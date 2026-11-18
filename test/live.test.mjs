// Talks to the real X API and CDN. Run with `npm run test:live`; skipped otherwise.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { downloadRecording } from "../src/lib/hls.js";
import { createTsRemuxer } from "../src/lib/remux.js";
import { activateGuest, inspectSpace } from "../src/lib/x-api.js";
import { execFileAsync, hasCommand } from "./helpers.mjs";

const LIVE = process.env.LIVE === "1";
const HAS_FFPROBE = await hasCommand("ffprobe");
const { mp4 } = createRequire(import.meta.url)("mux.js");
const AUDIO_SPACE = "1OwxWwQOPlNxQ";
const VIDEO_SPACE = "1DXGydznBYWKM";
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

if (LIVE) {
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = (url, options = {}) => {
    const headers = new Headers(options.headers || {});
    if (!headers.has("user-agent")) headers.set("user-agent", BROWSER_UA);
    return nativeFetch(url, { ...options, headers });
  };
}

async function probe(blob, name) {
  const dir = await mkdtemp(join(tmpdir(), "xsd-live-"));
  const path = join(dir, name);
  await writeFile(path, new Uint8Array(await blob.arrayBuffer()));
  const { stdout } = await execFileAsync("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", path]);
  return JSON.parse(stdout).streams;
}

let guest = null;
const session = async () => ({ mode: "guest", guestToken: (guest ||= await activateGuest()) });

test("downloads two real audio segments into a playable m4a", { skip: !LIVE }, async () => {
  const info = await inspectSpace(AUDIO_SPACE, await session());
  assert.equal(info.canDownload, true);
  assert.match(info.title, /Everybody in/);
  assert.equal(info.handle, "mtbarra");
  assert.ok(info.durationSeconds > 500);
  const file = await downloadRecording(info.audioMediaUrl, {
    maxSegments: 2,
    metadata: { title: info.title, artist: info.creatorName },
  });
  assert.equal(file.extension, "m4a");
  assert.ok(file.durationSeconds > 5 && file.durationSeconds < 8);
  if (!HAS_FFPROBE) return;
  const [stream] = await probe(file.blob, "space.m4a");
  assert.equal(stream.codec_name, "aac");
  assert.equal(stream.sample_rate, "48000");
});

test("extracts audio from a real video Space segment", { skip: !LIVE }, async () => {
  const info = await inspectSpace(VIDEO_SPACE, await session());
  assert.equal(info.canDownload, true);
  assert.equal(info.videoAvailable, true);
  const file = await downloadRecording(info.audioMediaUrl, { maxSegments: 1 });
  assert.equal(file.extension, "m4a");
  if (!HAS_FFPROBE) return;
  const [stream] = await probe(file.blob, "video-audio.m4a");
  assert.equal(stream.codec_name, "aac");
});

test("remuxes real video segments into MP4", { skip: !LIVE }, async () => {
  const info = await inspectSpace(VIDEO_SPACE, await session());
  const file = await downloadRecording(info.videoMediaUrl, {
    mode: "video",
    maxSegments: 2,
    createRemuxer: () => createTsRemuxer(mp4.Transmuxer),
  });
  assert.equal(file.extension, "mp4");
  if (!HAS_FFPROBE) return;
  const codecs = (await probe(file.blob, "video.mp4")).map((stream) => stream.codec_name).sort();
  assert.deepEqual(codecs, ["aac", "h264"]);
});
