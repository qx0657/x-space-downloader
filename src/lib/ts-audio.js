import { SpaceError } from "./errors.js";
import { concat } from "./bytes.js";
import { t } from "./i18n.js";

const PACKET = 188;

function section(payload) {
  if (!payload.length) return null;
  const pointer = payload[0];
  const start = 1 + pointer;
  if (start >= payload.length) return null;
  return payload.subarray(start);
}

function readPmtPid(payload) {
  const sec = section(payload);
  if (!sec || sec[0] !== 0x00 || sec.length < 12) return null;
  const sectionLength = ((sec[1] & 0x0f) << 8) | sec[2];
  const end = Math.min(sec.length, 3 + sectionLength - 4);
  for (let i = 8; i + 4 <= end; i += 4) {
    const program = (sec[i] << 8) | sec[i + 1];
    if (program === 0) continue;
    return ((sec[i + 2] & 0x1f) << 8) | sec[i + 3];
  }
  return null;
}

function readAudioPid(payload) {
  const sec = section(payload);
  if (!sec || sec[0] !== 0x02 || sec.length < 12) return null;
  const sectionLength = ((sec[1] & 0x0f) << 8) | sec[2];
  const end = Math.min(sec.length, 3 + sectionLength - 4);
  const infoLength = ((sec[10] & 0x0f) << 8) | sec[11];
  let fallback = null;
  for (let i = 12 + infoLength; i + 5 <= end;) {
    const streamType = sec[i];
    const pid = ((sec[i + 1] & 0x1f) << 8) | sec[i + 2];
    const esLength = ((sec[i + 3] & 0x0f) << 8) | sec[i + 4];
    if (streamType === 0x0f) return { pid, latm: false };
    if (streamType === 0x11 && !fallback) fallback = { pid, latm: true };
    i += 5 + esLength;
  }
  return fallback;
}

function stripPes(packet) {
  if (packet.length >= 6 && packet[0] === 0x00 && packet[1] === 0x00 && packet[2] === 0x01) {
    if (packet.length < 9) return new Uint8Array(0);
    const headerLength = packet[8];
    const start = 9 + headerLength;
    if (start > packet.length) return new Uint8Array(0);
    return packet.subarray(start);
  }
  return packet;
}

export function extractAdtsFromTs(data) {
  if (data.length < PACKET || data[0] !== 0x47) {
    throw new SpaceError("audio", t("tsNotMpegTs"));
  }
  let pmtPid = null;
  let audio = null;
  const elementary = [];
  let current = [];
  const packets = Math.floor(data.length / PACKET);

  for (let index = 0; index < packets; index += 1) {
    const offset = index * PACKET;
    if (data[offset] !== 0x47) continue;
    const pid = ((data[offset + 1] & 0x1f) << 8) | data[offset + 2];
    const start = (data[offset + 1] & 0x40) !== 0;
    const adaptation = (data[offset + 3] >> 4) & 0x03;
    let payloadOffset = offset + 4;
    if (adaptation & 0x02) {
      payloadOffset = offset + 5 + data[offset + 4];
    }
    if ((adaptation & 0x01) === 0 || payloadOffset >= offset + PACKET) continue;
    const payload = data.subarray(payloadOffset, offset + PACKET);

    if (pid === 0 && start && pmtPid == null) {
      pmtPid = readPmtPid(payload);
      continue;
    }
    if (pmtPid != null && pid === pmtPid && start && !audio) {
      audio = readAudioPid(payload);
      continue;
    }
    if (!audio || pid !== audio.pid) continue;
    if (start) {
      if (current.length) elementary.push(stripPes(concat(current)));
      current = [payload];
    } else if (current.length) {
      current.push(payload);
    }
  }
  if (current.length) elementary.push(stripPes(concat(current)));
  if (!elementary.length) {
    throw new SpaceError("audio", t("tsNoAudio"));
  }
  if (audio?.latm) {
    throw new SpaceError("audio", t("tsLatm"));
  }
  return concat(elementary);
}
