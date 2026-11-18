import { SpaceError } from "./errors.js";
import { t } from "./i18n.js";
import { ascii, box, concat, u16, u32 } from "./bytes.js";

const SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
const AAC_SAMPLES_PER_FRAME = 1024;
const EMPTY = new Uint8Array(0);

function id3TagLength(buffer, offset) {
  if (offset + 10 > buffer.length) return null;
  if (buffer[offset] !== 0x49 || buffer[offset + 1] !== 0x44 || buffer[offset + 2] !== 0x33) return 0;
  const size =
    ((buffer[offset + 6] & 0x7f) << 21) |
    ((buffer[offset + 7] & 0x7f) << 14) |
    ((buffer[offset + 8] & 0x7f) << 7) |
    (buffer[offset + 9] & 0x7f);
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
  const frameLength =
    ((buffer[offset + 3] & 0x03) << 11) | (buffer[offset + 4] << 3) | ((buffer[offset + 5] >> 5) & 0x07);
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
    raw: buffer.subarray(offset + headerLength, offset + frameLength),
    frameLength,
  };
}

// Space 的 .aac 分片前面带有 Apple 的 ID3 时间戳，后面才是 ADTS。
// push() 丢掉标签和 ADTS 头，返回能放进 m4a 的裸 AAC；只在内存里保留每帧长度。
export function createAacCollector() {
  let pending = EMPTY;
  const lengths = [];
  let rawLength = 0;
  let profile = null;
  let sampleRateIndex = null;
  let channels = null;

  function remember(frame) {
    if (profile == null) {
      profile = frame.profile;
      sampleRateIndex = frame.sampleRateIndex;
      channels = frame.channels;
      if (!channels) throw new SpaceError("audio", t("aacNoChannels"));
    } else if (frame.sampleRateIndex !== sampleRateIndex || frame.channels !== channels) {
      throw new SpaceError("audio", t("aacFormatChanged"));
    }
    lengths.push(frame.raw.length);
    rawLength += frame.raw.length;
    return frame.raw;
  }

  return {
    push(chunk) {
      if (!chunk?.length && !pending.length) return null;
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
      pending = offset < buffer.length ? buffer.slice(offset) : EMPTY;
      if (pending.length > 1_000_000) throw new SpaceError("audio", t("aacUnaligned"));
      return pieces.length ? concat(pieces) : null;
    },
    finish() {
      if (!lengths.length) throw new SpaceError("audio", t("aacNoFrames"));
      const sampleRate = SAMPLE_RATES[sampleRateIndex];
      return {
        lengths,
        rawLength,
        profile,
        sampleRateIndex,
        sampleRate,
        channels,
        frameCount: lengths.length,
        durationSeconds: (lengths.length * AAC_SAMPLES_PER_FRAME) / sampleRate,
      };
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
  if (body.length >= 128) throw new SpaceError("audio", t("aacDescriptor"));
  return concat([new Uint8Array([tag, body.length]), body]);
}

function esds(config, bitrate) {
  const specific = descriptor(0x05, config);
  const decoder = descriptor(
    0x04,
    concat([new Uint8Array([0x40, 0x15, 0x00, 0x18, 0x00]), u32(bitrate), u32(bitrate), specific]),
  );
  const syncLayer = descriptor(0x06, new Uint8Array([0x02]));
  const es = descriptor(0x03, concat([u16(1), new Uint8Array([0x00]), decoder, syncLayer]));
  return box("esds", u32(0), es);
}

function mp4Time() {
  return (Math.floor(Date.now() / 1000) + 2082844800) >>> 0;
}

function matrix() {
  // prettier-ignore
  return concat([
    u32(0x00010000), u32(0), u32(0),
    u32(0), u32(0x00010000), u32(0),
    u32(0), u32(0), u32(0x40000000),
  ]);
}

const utf8 = (value) => new TextEncoder().encode(String(value));

function textItem(name, value) {
  if (!value) return null;
  return box(name, box("data", u32(1), u32(0), utf8(value)));
}

function coverItem(cover) {
  if (!cover?.bytes?.length) return null;
  return box("covr", box("data", u32(cover.type === "png" ? 14 : 13), u32(0), cover.bytes));
}

export function metadataBox(metadata) {
  if (!metadata) return null;
  const items = [
    textItem("\xa9nam", metadata.title),
    textItem("\xa9ART", metadata.artist),
    textItem("aART", metadata.artist),
    textItem("\xa9alb", metadata.album),
    textItem("\xa9day", metadata.date),
    textItem("\xa9cmt", metadata.comment),
    coverItem(metadata.cover),
  ].filter(Boolean);
  if (!items.length) return null;
  const hdlr = box("hdlr", u32(0), u32(0), ascii("mdir"), ascii("appl"), u32(0), u32(0), new Uint8Array(1));
  return box("udta", box("meta", u32(0), hdlr, box("ilst", ...items)));
}

function buildMoov({ lengths, sampleRate, channels, config, bitrate, mdatOffset, udta }) {
  const frameCount = lengths.length;
  const duration = frameCount * AAC_SAMPLES_PER_FRAME;
  const now = mp4Time();
  // prettier-ignore
  const mvhd = box("mvhd", concat([
    u32(0), u32(now), u32(now), u32(sampleRate), u32(duration),
    u32(0x00010000), u16(0x0100), u16(0), u32(0), u32(0),
    matrix(),
    u32(0), u32(0), u32(0), u32(0), u32(0), u32(0),
    u32(2),
  ]));
  // prettier-ignore
  const tkhd = box("tkhd", concat([
    u32(0x00000007), u32(now), u32(now), u32(1), u32(0), u32(duration),
    u32(0), u32(0), u16(0), u16(0), u16(0x0100), u16(0),
    matrix(),
    u32(0), u32(0),
  ]));
  const mdhd = box("mdhd", concat([u32(0), u32(now), u32(now), u32(sampleRate), u32(duration), u16(0x55c4), u16(0)]));
  const hdlr = box(
    "hdlr",
    concat([u32(0), u32(0), ascii("soun"), u32(0), u32(0), u32(0), ascii("SoundHandler"), new Uint8Array(1)]),
  );
  // prettier-ignore
  const mp4a = box("mp4a", concat([
    new Uint8Array(6), u16(1), u16(0), u16(0), u32(0),
    u16(channels), u16(16), u16(0), u16(0), u32(sampleRate << 16),
    esds(config, bitrate),
  ]));
  const stsd = box("stsd", concat([u32(0), u32(1), mp4a]));
  const stts = box("stts", concat([u32(0), u32(1), u32(frameCount), u32(AAC_SAMPLES_PER_FRAME)]));
  const stsc = box("stsc", concat([u32(0), u32(1), u32(1), u32(frameCount), u32(1)]));
  const stszBody = new Uint8Array(12 + frameCount * 4);
  const view = new DataView(stszBody.buffer);
  view.setUint32(8, frameCount);
  for (let i = 0; i < frameCount; i += 1) view.setUint32(12 + i * 4, lengths[i]);
  const stsz = box("stsz", stszBody);
  const stco = box("stco", concat([u32(0), u32(1), u32(mdatOffset)]));
  const stbl = box("stbl", stsd, stts, stsc, stsz, stco);
  const smhd = box("smhd", concat([u32(0), u16(0), u16(0)]));
  const dref = box("dref", concat([u32(0), u32(1), box("url ", u32(1))]));
  const minf = box("minf", smhd, box("dinf", dref), stbl);
  const trak = box("trak", tkhd, box("mdia", mdhd, hdlr, minf));
  return udta ? box("moov", mvhd, trak, udta) : box("moov", mvhd, trak);
}

// ftyp + moov + mdat 头。真正的 AAC 数据由调用方紧接着拼在后面。
export function m4aHeader(summary, metadata = null) {
  const { lengths, rawLength, sampleRate, channels, profile, sampleRateIndex } = summary;
  if (rawLength + 8 > 0xffffffff) throw new SpaceError("audio", t("aacTooLarge"));
  const bitrate = Math.max(1, Math.round((rawLength * 8 * sampleRate) / (lengths.length * AAC_SAMPLES_PER_FRAME)));
  const base = {
    lengths,
    sampleRate,
    channels,
    config: audioSpecificConfig(profile, sampleRateIndex, channels),
    bitrate,
    udta: metadataBox(metadata),
  };
  const ftyp = box("ftyp", ascii("M4A "), u32(0), ascii("M4A "), ascii("isom"));
  const draft = buildMoov({ ...base, mdatOffset: 0 });
  const moov = buildMoov({ ...base, mdatOffset: ftyp.length + draft.length + 8 });
  return concat([ftyp, moov, u32(rawLength + 8), ascii("mdat")]);
}

export function muxAacChunks(chunks, metadata = null) {
  const collector = createAacCollector();
  const raws = [];
  for (const chunk of chunks) {
    const raw = collector.push(chunk);
    if (raw) raws.push(raw);
  }
  const summary = collector.finish();
  return { ...summary, bytes: concat([m4aHeader(summary, metadata), ...raws]) };
}
