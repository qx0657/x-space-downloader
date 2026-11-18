import { SpaceError } from "./errors.js";
import { ascii, box, concat, u16, u32 } from "./bytes.js";

const SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
const AAC_SAMPLES_PER_FRAME = 1024;

function id3TagLength(buffer, offset) {
  if (offset + 10 > buffer.length) return null;
  if (buffer[offset] !== 0x49 || buffer[offset + 1] !== 0x44 || buffer[offset + 2] !== 0x33) return 0;
  const size = ((buffer[offset + 6] & 0x7f) << 21)
    | ((buffer[offset + 7] & 0x7f) << 14)
    | ((buffer[offset + 8] & 0x7f) << 7)
    | (buffer[offset + 9] & 0x7f);
  if (size > 1_000_000) return 10;
  const total = 10 + size;
  if (offset + total > buffer.length) return null;
  return total;
}

function readAdts(buffer, offset) {
  if (offset + 7 > buffer.length) return null;
  if (buffer[offset] !== 0xff || (buffer[offset + 1] & 0xf6) !== 0xf0) return { sync: false };
  const protectionAbsent = buffer[offset + 1] & 0x01;
  const profile = (buffer[offset + 2] >> 6) & 0x03;
  const sampleRateIndex = (buffer[offset + 2] >> 2) & 0x0f;
  const channels = ((buffer[offset + 2] & 0x01) << 2) | ((buffer[offset + 3] >> 6) & 0x03);
  const frameLength = ((buffer[offset + 3] & 0x03) << 11)
    | (buffer[offset + 4] << 3)
    | ((buffer[offset + 5] >> 5) & 0x07);
  const headerLength = protectionAbsent ? 7 : 9;
  if (sampleRateIndex >= SAMPLE_RATES.length || frameLength < headerLength + 1 || frameLength > 8191) {
    return { sync: false };
  }
  if (offset + frameLength > buffer.length) return null;
  return {
    sync: true,
    profile,
    sampleRateIndex,
    channels,
    headerLength,
    frameLength,
    raw: buffer.slice(offset + headerLength, offset + frameLength),
  };
}

// Space 的 .aac 分片前面带有 Apple 的 ID3 时间戳，后面才是 ADTS。
// 这里丢掉标签和 ADTS 头，只留下能放进 m4a 的裸 AAC。
export function createAacCollector() {
  let pending = new Uint8Array(0);
  const rawParts = [];
  const lengths = [];
  let profile = null;
  let sampleRateIndex = null;
  let channels = null;

  function remember(frame) {
    if (profile == null) {
      profile = frame.profile;
      sampleRateIndex = frame.sampleRateIndex;
      channels = frame.channels;
      if (!channels) {
        throw new SpaceError("audio", "音频声道信息不完整，没法封装成 m4a");
      }
    } else if (frame.sampleRateIndex !== sampleRateIndex || frame.channels !== channels) {
      throw new SpaceError("audio", "录音中途换了采样率或声道，没法合成一个文件");
    }
    lengths.push(frame.raw.length);
    return frame.raw;
  }

  return {
    push(chunk) {
      if (!chunk?.length && !pending.length) return;
      const buffer = pending.length ? concat([pending, chunk]) : chunk;
      const pieces = [];
      let offset = 0;
      while (offset < buffer.length) {
        const tagLength = id3TagLength(buffer, offset);
        if (tagLength == null) break;
        if (tagLength > 0) {
          offset += tagLength;
          continue;
        }
        const frame = readAdts(buffer, offset);
        if (frame == null) break;
        if (!frame.sync) {
          offset += 1;
          continue;
        }
        pieces.push(remember(frame));
        offset += frame.frameLength;
      }
      if (pieces.length) rawParts.push(concat(pieces));
      pending = offset < buffer.length ? buffer.slice(offset) : new Uint8Array(0);
      if (pending.length > 1_000_000) {
        throw new SpaceError("audio", "有一段音频对不上 AAC 帧，下载已停止");
      }
    },
    finish() {
      if (!lengths.length) throw new SpaceError("audio", "没有解析出音频帧");
      return muxAac(rawParts, lengths, { profile, sampleRateIndex, channels });
    },
    get frameCount() {
      return lengths.length;
    },
  };
}

function audioSpecificConfig(profile, sampleRateIndex, channels) {
  const audioObjectType = profile + 1;
  return new Uint8Array([
    (audioObjectType << 3) | (sampleRateIndex >> 1),
    ((sampleRateIndex & 1) << 7) | (channels << 3),
  ]);
}

function descriptor(tag, body) {
  if (body.length >= 128) throw new SpaceError("audio", "音频描述块超出预期");
  return concat([new Uint8Array([tag, body.length]), body]);
}

function esds(config, bitrate) {
  const specific = descriptor(0x05, config);
  const decoder = descriptor(0x04, concat([
    new Uint8Array([0x40, 0x15, 0x00, 0x18, 0x00]),
    u32(bitrate),
    u32(bitrate),
    specific,
  ]));
  const syncLayer = descriptor(0x06, new Uint8Array([0x02]));
  const es = descriptor(0x03, concat([u16(1), new Uint8Array([0x00]), decoder, syncLayer]));
  return box("esds", u32(0), es);
}

function mp4Time() {
  return (Math.floor(Date.now() / 1000) + 2082844800) >>> 0;
}

function matrix() {
  return concat([
    u32(0x00010000), u32(0), u32(0),
    u32(0), u32(0x00010000), u32(0),
    u32(0), u32(0), u32(0x40000000),
  ]);
}

function buildMoov({ frameCount, timescale, sampleRate, channels, config, bitrate, mdatOffset }) {
  const duration = frameCount * AAC_SAMPLES_PER_FRAME;
  const now = mp4Time();
  const mvhd = box("mvhd", concat([
    u32(0),
    u32(now),
    u32(now),
    u32(timescale),
    u32(duration),
    u32(0x00010000),
    u16(0x0100),
    u16(0),
    u32(0),
    u32(0),
    matrix(),
    u32(0), u32(0), u32(0), u32(0), u32(0), u32(0),
    u32(2),
  ]));
  const tkhd = box("tkhd", concat([
    u32(0x00000007),
    u32(now),
    u32(now),
    u32(1),
    u32(0),
    u32(duration),
    u32(0),
    u32(0),
    u16(0),
    u16(0),
    u16(0x0100),
    u16(0),
    matrix(),
    u32(0),
    u32(0),
  ]));
  const mdhd = box("mdhd", concat([
    u32(0),
    u32(now),
    u32(now),
    u32(timescale),
    u32(duration),
    u16(0x55c4),
    u16(0),
  ]));
  const name = concat([ascii("SoundHandler"), new Uint8Array(1)]);
  const hdlr = box("hdlr", concat([
    u32(0),
    u32(0),
    ascii("soun"),
    u32(0), u32(0), u32(0),
    name,
  ]));
  const mp4a = box("mp4a", concat([
    new Uint8Array(6),
    u16(1),
    u16(0),
    u16(0),
    u32(0),
    u16(channels),
    u16(16),
    u16(0),
    u16(0),
    u32(sampleRate << 16),
    esds(config, bitrate),
  ]));
  const stsd = box("stsd", concat([u32(0), u32(1), mp4a]));
  const stts = box("stts", concat([u32(0), u32(1), u32(frameCount), u32(AAC_SAMPLES_PER_FRAME)]));
  const stsc = box("stsc", concat([u32(0), u32(1), u32(1), u32(frameCount), u32(1)]));
  const stszBody = new Uint8Array(12 + frameCount * 4);
  const view = new DataView(stszBody.buffer);
  view.setUint32(4, 0);
  view.setUint32(8, frameCount);
  const stsz = box("stsz", stszBody);
  const stco = box("stco", concat([u32(0), u32(1), u32(mdatOffset)]));
  const stbl = box("stbl", stsd, stts, stsc, stsz, stco);
  const smhd = box("smhd", concat([u32(0), u16(0), u16(0)]));
  const dref = box("dref", concat([u32(0), u32(1), box("url ", u32(1))]));
  const minf = box("minf", smhd, box("dinf", dref), stbl);
  const mdia = box("mdia", mdhd, hdlr, minf);
  const trak = box("trak", tkhd, mdia);
  return { moov: box("moov", mvhd, trak), stsz, stszBody };
}

function findBytes(haystack, needle, end) {
  const last = Math.min(haystack.length, end) - needle.length;
  for (let i = 0; i <= last; i += 1) {
    if (haystack[i] !== needle[0]) continue;
    let matched = true;
    for (let j = 1; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) {
        matched = false;
        break;
      }
    }
    if (matched) return i;
  }
  return -1;
}

function writeSampleSizes(file, moovLength, frameCount, lengths) {
  const stszSize = 20 + frameCount * 4;
  const needle = concat([u32(stszSize), ascii("stsz"), u32(0), u32(0), u32(frameCount)]);
  const found = findBytes(file, needle, moovLength + 64);
  if (found < 0) throw new SpaceError("audio", "封装 m4a 时没有写上采样表");
  const view = new DataView(file.buffer, file.byteOffset + found + needle.length, lengths.length * 4);
  for (let i = 0; i < lengths.length; i += 1) view.setUint32(i * 4, lengths[i]);
}

export function muxAac(rawParts, lengths, info) {
  const sampleRate = SAMPLE_RATES[info.sampleRateIndex];
  const raw = concat(rawParts);
  const bitrate = Math.max(1, Math.round((raw.length * 8 * sampleRate) / (lengths.length * AAC_SAMPLES_PER_FRAME)));
  const config = audioSpecificConfig(info.profile, info.sampleRateIndex, info.channels);
  const ftyp = box("ftyp", ascii("M4A "), u32(0), ascii("M4A "), ascii("isom"));
  const draft = buildMoov({
    frameCount: lengths.length,
    timescale: sampleRate,
    sampleRate,
    channels: info.channels,
    config,
    bitrate,
    mdatOffset: 0,
  });
  const mdatHeader = 8;
  const mdatOffset = ftyp.length + draft.moov.length + mdatHeader;
  if (raw.length + mdatHeader > 0xffffffff) {
    throw new SpaceError("audio", "录音超过 4GB，没法存成一个文件");
  }
  const finalMoov = buildMoov({
    frameCount: lengths.length,
    timescale: sampleRate,
    sampleRate,
    channels: info.channels,
    config,
    bitrate,
    mdatOffset,
  });
  const file = concat([
    ftyp,
    finalMoov.moov,
    u32(raw.length + mdatHeader),
    ascii("mdat"),
    raw,
  ]);
  writeSampleSizes(file, ftyp.length + finalMoov.moov.length, lengths.length, lengths);
  return {
    bytes: file,
    sampleRate,
    channels: info.channels,
    frameCount: lengths.length,
    durationSeconds: (lengths.length * AAC_SAMPLES_PER_FRAME) / sampleRate,
  };
}
