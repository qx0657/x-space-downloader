import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { webcrypto } from "node:crypto";

import { concat } from "../src/lib/bytes.js";

export const execFileAsync = promisify(execFile);

export async function hasCommand(name) {
  try {
    await execFileAsync("which", [name]);
    return true;
  } catch {
    return false;
  }
}

export function makeAdts(payloadLength, fill = 0x11) {
  const frameLength = 7 + payloadLength;
  const header = new Uint8Array(7);
  header[0] = 0xff;
  header[1] = 0xf1;
  header[2] = (1 << 6) | (3 << 2); // AAC-LC, 48 kHz
  header[3] = (2 << 6) | ((frameLength >> 11) & 0x03); // stereo
  header[4] = (frameLength >> 3) & 0xff;
  header[5] = ((frameLength & 0x07) << 5) | 0x1f;
  header[6] = 0xfc;
  return concat([header, new Uint8Array(payloadLength).fill(fill)]);
}

export function id3Wrap(body) {
  const header = new Uint8Array(10);
  header.set([0x49, 0x44, 0x33, 0x04, 0x00, 0x00]);
  header[6] = (body.length >> 21) & 0x7f;
  header[7] = (body.length >> 14) & 0x7f;
  header[8] = (body.length >> 7) & 0x7f;
  header[9] = body.length & 0x7f;
  return concat([header, body]);
}

// One Space-style .aac segment: an ID3 timestamp tag followed by `frames` ADTS frames.
export function aacSegment(frames = 10, fill = 0x11) {
  const parts = [id3Wrap(new Uint8Array([1, 2, 3, 4]))];
  for (let i = 0; i < frames; i += 1) parts.push(makeAdts(32, fill));
  return concat(parts);
}

export function boxes(bytes) {
  const found = [];
  let offset = 0;
  while (offset + 8 <= bytes.length) {
    const size = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (size < 8) break;
    found.push(type);
    if (type === "mdat") break;
    offset += size;
  }
  return found;
}

function tsPacket(pid, chunk, start) {
  const packet = new Uint8Array(188).fill(0xff);
  packet[0] = 0x47;
  packet[1] = (start ? 0x40 : 0) | ((pid >> 8) & 0x1f);
  packet[2] = pid & 0xff;
  if (chunk.length >= 184) {
    packet[3] = 0x10;
    packet.set(chunk.subarray(0, 184), 4);
  } else {
    const stuffing = 183 - chunk.length;
    packet[3] = 0x30;
    packet[4] = stuffing;
    if (stuffing > 0) packet[5] = 0x00;
    packet.set(chunk, 5 + stuffing);
  }
  return packet;
}

function psi(section) {
  return concat([new Uint8Array([0]), section]);
}

// A minimal MPEG-TS segment with a PAT, a PMT declaring one ADTS audio stream, and PES
// packets carrying `frames` ADTS frames — enough for extractAdtsFromTs().
export function tsSegment(frames = 10) {
  const PMT_PID = 0x1000;
  const AUDIO_PID = 0x101;
  const pat = psi(
    new Uint8Array([
      0x00,
      0xb0,
      13,
      0x00,
      0x01,
      0xc1,
      0x00,
      0x00,
      0x00,
      0x01,
      0xe0 | (PMT_PID >> 8),
      PMT_PID & 0xff,
      0,
      0,
      0,
      0,
    ]),
  );
  // prettier-ignore
  const pmt = psi(
    new Uint8Array([
      0x02, 0xb0, 18, 0x00, 0x01, 0xc1, 0x00, 0x00, 0xe1, 0x01, 0xf0, 0x00,
      0x0f, 0xe0 | (AUDIO_PID >> 8), AUDIO_PID & 0xff, 0xf0, 0x00,
      0, 0, 0, 0,
    ]),
  );
  const adts = concat(Array.from({ length: frames }, () => makeAdts(32)));
  const pesHeader = new Uint8Array([
    0x00, 0x00, 0x01, 0xc0, 0x00, 0x00, 0x80, 0x80, 0x05, 0x21, 0x00, 0x01, 0x00, 0x01,
  ]);
  const pes = concat([pesHeader, adts]);
  const packets = [tsPacket(0, pat, true), tsPacket(PMT_PID, pmt, true)];
  for (let offset = 0; offset < pes.length; offset += 184) {
    packets.push(tsPacket(AUDIO_PID, pes.subarray(offset, offset + 184), offset === 0));
  }
  return concat(packets);
}

export async function aesEncrypt(bytes, keyBytes, sequence) {
  const iv = new Uint8Array(16);
  new DataView(iv.buffer).setUint32(12, sequence);
  const key = await webcrypto.subtle.importKey("raw", keyBytes, { name: "AES-CBC" }, false, ["encrypt"]);
  return new Uint8Array(await webcrypto.subtle.encrypt({ name: "AES-CBC", iv }, key, bytes));
}

export function mediaPlaylist(names, { endList = true, key = "", sequence = 0 } = {}) {
  const lines = ["#EXTM3U", "#EXT-X-VERSION:3", "#EXT-X-TARGETDURATION:3", `#EXT-X-MEDIA-SEQUENCE:${sequence}`];
  if (key) lines.push(key);
  for (const name of names) lines.push("#EXTINF:2.000,", name);
  if (endList) lines.push("#EXT-X-ENDLIST");
  return lines.join("\n");
}

// Replaces globalThis.fetch with a route table. A route is bytes/string, or a function
// returning a Response. Returns the request log and a restore function.
export function mockFetch(routes) {
  const original = globalThis.fetch;
  const log = [];
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    log.push(href);
    if (options.signal?.aborted) throw new DOMException("aborted", "AbortError");
    const route = routes[href];
    if (route == null) return new Response("missing", { status: 404 });
    if (typeof route === "function") return route(href, options);
    return new Response(route, { status: 200 });
  };
  return { log, restore: () => (globalThis.fetch = original) };
}
