import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { concat } from "../src/lib/bytes.js";
import { fileBase, sanitizeFolder } from "../src/lib/format.js";
import { deviceConcurrency, downloadRecording, parsePlaylist } from "../src/lib/hls.js";
import { messageKeys } from "../src/lib/i18n.js";
import { nextJob } from "../src/lib/job.js";
import { createAacCollector, m4aHeader, muxAacChunks } from "../src/lib/m4a.js";
import { isAllowedMediaUrl } from "../src/lib/net.js";
import { normalizeSettings } from "../src/lib/settings.js";
import { createSpeakerLog, rosterFromSpace } from "../src/lib/speakers.js";
import { spaceIdFromText } from "../src/lib/space-url.js";
import { createMemoryStore } from "../src/lib/store.js";
import { extractAdtsFromTs } from "../src/lib/ts-audio.js";
import { findQueryId } from "../src/lib/x-api.js";
import {
  aacSegment,
  aesEncrypt,
  boxes,
  execFileAsync,
  hasCommand,
  id3Wrap,
  makeAdts,
  mediaPlaylist,
  mockFetch,
  tsSegment,
} from "./helpers.mjs";

const CDN = "https://prod-fastly.video.pscp.tv/Transcoding/v1/hls/token1";
const FAST = { start: 2, min: 2, max: 4 };
const HAS_FFPROBE = await hasCommand("ffprobe");

async function blobBytes(blob) {
  return new Uint8Array(await blob.arrayBuffer());
}

async function ffprobe(bytes, name = "sample.m4a") {
  const dir = await mkdtemp(join(tmpdir(), "xsd-"));
  const path = join(dir, name);
  await writeFile(path, bytes);
  const { stdout } = await execFileAsync("ffprobe", [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_streams",
    "-show_format",
    path,
  ]);
  return JSON.parse(stdout);
}

// ---------- 链接、接口编号、设置 ----------

test("parses Space URLs and ids", () => {
  assert.equal(spaceIdFromText("https://x.com/i/spaces/1OwxWwQOPlNxQ"), "1OwxWwQOPlNxQ");
  assert.equal(spaceIdFromText("https://twitter.com/i/spaces/1OwxWwQOPlNxQ/peek"), "1OwxWwQOPlNxQ");
  assert.equal(spaceIdFromText("x.com/i/spaces/1OwxWwQOPlNxQ"), "1OwxWwQOPlNxQ");
  assert.equal(spaceIdFromText("1OwxWwQOPlNxQ"), "1OwxWwQOPlNxQ");
  assert.equal(spaceIdFromText("https://x.com/home"), null);
  assert.equal(spaceIdFromText("https://evil.com/i/spaces/1OwxWwQOPlNxQ"), null);
});

test("finds a rotated AudioSpace query id in either field order", () => {
  assert.equal(findQueryId('e.exports={queryId:"abcDEF123456",operationName:"AudioSpaceById"}'), "abcDEF123456");
  assert.equal(findQueryId('{operationName:"AudioSpaceById",queryId:"zyx987654321"}'), "zyx987654321");
  assert.equal(findQueryId('{queryId:"abcDEF123456",operationName:"Other"}'), null);
});

test("only allows https media hosts from X's CDNs", () => {
  assert.ok(isAllowedMediaUrl("https://prod-fastly-us-west-1.video.pscp.tv/a.m3u8"));
  assert.ok(isAllowedMediaUrl("https://video.twimg.com/a.m3u8"));
  assert.ok(!isAllowedMediaUrl("http://video.pscp.tv/a.m3u8"));
  assert.ok(!isAllowedMediaUrl("https://pscp.tv.evil.com/a.m3u8"));
  assert.ok(!isAllowedMediaUrl("https://example.com/a.m3u8"));
  assert.ok(!isAllowedMediaUrl("not a url"));
});

test("builds file names from a template", () => {
  const info = {
    spaceId: "1OwxWwQOPlNxQ",
    title: "A/B: talk?",
    handle: "host",
    startedAt: new Date(2026, 0, 2, 3, 4).getTime(),
  };
  assert.equal(fileBase(info), "2026-01-02 @host A B talk");
  assert.equal(fileBase(info, "{id}-{time}"), "1OwxWwQOPlNxQ-0304");
  assert.equal(fileBase({ spaceId: "1OwxWwQOPlNxQ" }, "{title}"), "1OwxWwQOPlNxQ");
  assert.equal(fileBase(info, "{unknown} {title}"), "{unknown} A B talk");
});

test("sanitises the download folder", () => {
  assert.equal(sanitizeFolder("X-Spaces"), "X-Spaces");
  assert.equal(sanitizeFolder("../a//b\\c"), "a/b/c");
  assert.equal(sanitizeFolder(""), "");
  assert.equal(sanitizeFolder("/abs/path/"), "abs/path");
});

test("normalises settings", () => {
  assert.deepEqual(normalizeSettings({}), normalizeSettings(undefined));
  const s = normalizeSettings({ maxConcurrency: "99", videoFormat: "avi", template: "  ", showPanel: false });
  assert.equal(s.maxConcurrency, 32);
  assert.equal(s.videoFormat, "mp4");
  assert.equal(s.template, "{date} {handle} {title}");
  assert.equal(s.showPanel, false);
  assert.equal(s.saveSpeakers, true);
  assert.equal(normalizeSettings({ saveSpeakers: false }).saveSpeakers, false);
});

test("zh and en dictionaries have the same keys", () => {
  assert.deepEqual(messageKeys("en").sort(), messageKeys("zh").sort());
});

test("picks fewer parallel downloads on small devices and honours an override", () => {
  const phone = deviceConcurrency({ hardwareConcurrency: 4, deviceMemory: 2, connection: { effectiveType: "3g" } });
  const desktop = deviceConcurrency({
    hardwareConcurrency: 16,
    deviceMemory: 16,
    connection: { effectiveType: "4g", downlink: 40 },
  });
  assert.ok(phone.start <= 4 && phone.max <= 6);
  assert.ok(desktop.start >= 8 && desktop.max >= phone.max && desktop.start <= desktop.max);
  const capped = deviceConcurrency({ hardwareConcurrency: 16, deviceMemory: 16 }, 3);
  assert.equal(capped.max, 3);
  assert.ok(capped.start <= 3);
});

// ---------- 任务状态机 ----------

test("job updates from a finished or other run are ignored", () => {
  const running = nextJob(null, { start: true, runId: "r1", phase: "downloading", spaceId: "a" }, 1);
  assert.equal(nextJob(running, { runId: "r2", phase: "done" }), null);
  assert.equal(nextJob(running, { phase: "inspecting", spaceId: "b" }), null);
  const cancelled = nextJob(running, { runId: "r1", phase: "cancelled" }, 2);
  assert.equal(cancelled.phase, "cancelled");
  assert.equal(nextJob(cancelled, { runId: "r1", phase: "done" }), null);
  const card = nextJob(cancelled, { phase: "inspecting", spaceId: "b", runId: null }, 3);
  assert.equal(card.phase, "inspecting");
  assert.equal(card.updatedAt, 3);
  const again = nextJob(card, { start: true, runId: "r3", phase: "downloading" });
  assert.equal(again.runId, "r3");
});

// ---------- 播放列表 ----------

test("parses a master playlist whose codecs contain commas", () => {
  const parsed = parsePlaylist(
    [
      "#EXTM3U",
      '#EXT-X-STREAM-INF:BANDWIDTH=300000,RESOLUTION=224x392,CODECS="avc1.640015,mp4a.40.2"',
      "/low/playlist.m3u8",
      '#EXT-X-STREAM-INF:BANDWIDTH=1200000,CODECS="avc1.64001e,mp4a.40.2"',
      "high/playlist.m3u8",
    ].join("\n"),
    "https://cdn.example/master.m3u8",
  );
  assert.equal(parsed.kind, "master");
  assert.equal(parsed.variants[0].codecs, "avc1.640015,mp4a.40.2");
  assert.equal(parsed.variants[0].url, "https://cdn.example/low/playlist.m3u8");
  assert.equal(parsed.variants[1].url, "https://cdn.example/high/playlist.m3u8");
});

test("parses byte ranges, keys, map and media sequence", () => {
  const parsed = parsePlaylist(
    [
      "#EXTM3U",
      "#EXT-X-MEDIA-SEQUENCE:7",
      '#EXT-X-MAP:URI="init.mp4",BYTERANGE="100@0"',
      '#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x0000000000000000000000000000000A',
      "#EXTINF:2.0,",
      "#EXT-X-BYTERANGE:500@100",
      "all.mp4",
      "#EXTINF:2.5,",
      "#EXT-X-BYTERANGE:400",
      "all.mp4",
      "#EXT-X-ENDLIST",
    ].join("\n"),
    "https://cdn.example/a/media.m3u8",
  );
  assert.equal(parsed.kind, "media");
  assert.equal(parsed.endList, true);
  assert.deepEqual(parsed.map, { url: "https://cdn.example/a/init.mp4", byterange: { length: 100, offset: 0 } });
  assert.deepEqual(parsed.segments[0].byterange, { length: 500, offset: 100 });
  assert.deepEqual(parsed.segments[1].byterange, { length: 400, offset: 600 });
  assert.equal(parsed.segments[1].sequence, 8);
  assert.equal(parsed.segments[0].key.method, "AES-128");
  assert.equal(parsed.segments[0].key.iv[15], 10);
  assert.equal(parsed.durationSeconds, 4.5);
});

// ---------- m4a ----------

function txxx(key, value) {
  const payload = new TextEncoder().encode(`${key}\0${value}\0`);
  const body = concat([new Uint8Array([3]), payload]);
  const header = new Uint8Array(10);
  header.set([0x54, 0x58, 0x58, 0x58]);
  header[4] = (body.length >> 21) & 0x7f;
  header[5] = (body.length >> 14) & 0x7f;
  header[6] = (body.length >> 7) & 0x7f;
  header[7] = body.length & 0x7f;
  return concat([header, body]);
}

function hydraTag({ participants, levels = [] }) {
  const frames = [];
  if (participants) frames.push(txxx("HydraParticipants", JSON.stringify(participants)));
  for (const level of levels) frames.push(txxx("HydraAudioLevel", JSON.stringify(level)));
  return id3Wrap(concat(frames));
}

test("reports the AAC frame count when an ID3 tag is skipped, including a tag split across chunks", () => {
  const seen = [];
  const collector = createAacCollector({ onTag: (_tag, frameCount) => seen.push(frameCount) });
  const first = hydraTag({ levels: [[1]] });
  collector.push(first.subarray(0, 8));
  assert.deepEqual(seen, []);
  const frames = [];
  for (let i = 0; i < 15; i += 1) frames.push(makeAdts(8));
  collector.push(concat([first.subarray(8), ...frames, hydraTag({ levels: [[2]] })]));
  assert.deepEqual(seen, [0, 15]);
  assert.equal(collector.finish().frameCount, 15);
});

test("builds a speaker timeline from interleaved Hydra tags", () => {
  const participants = [
    { UserName: "Alice", UserId: "tw-2" },
    { UserName: "bob", UserId: "tw-3" },
  ];
  const roster = {
    host: { id: "tw-1", handle: "hostuser", name: "主持人" },
    people: [
      { id: "tw-2", handle: "alice", name: "Alice", role: "speaker" },
      { id: "tw-3", handle: "bob", name: "Bob", role: "speaker" },
    ],
  };
  const log = createSpeakerLog();
  log.observe(
    hydraTag({
      participants,
      levels: [
        [0, 80, 0],
        [0, 70, 0],
      ],
    }),
    0,
  );
  log.observe(hydraTag({ levels: [[0, 10, 0]] }), 30);
  log.observe(hydraTag({ levels: [[90, 0, 0]] }), 45);
  log.observe(hydraTag({ levels: [[88, 0, 0]] }), 60);
  log.observe(hydraTag({ levels: [[0, 0, 60]] }), 120);
  log.observe(hydraTag({ levels: [[1, 2, 3, 4]] }), 150);
  const doc = log.finish({
    sampleRate: 48000,
    durationSeconds: 4,
    roster,
    space: { id: "abc", title: "Weekly", startedAt: Date.UTC(2026, 10, 17, 12) },
  });
  assert.equal(doc.version, 1);
  assert.equal(doc.space.host.handle, "hostuser");
  assert.equal(doc.space.startedAt, "2026-11-17T12:00:00.000Z");
  assert.equal(doc.audio.unmappedSamples, 1);
  assert.deepEqual(
    doc.turns.map((turn) => turn.speaker),
    ["alice", "hostuser"],
  );
  const alice = doc.turns[0];
  assert.equal(alice.start, 0);
  assert.equal(alice.peak, 80);
  assert.ok(alice.end > alice.start);
  assert.equal(doc.speakers[0].name, "Alice");
  assert.equal(doc.speakers[0].id, "tw-2");
  assert.equal(doc.speakers.find((person) => person.handle === "hostuser").role, "host");
  assert.equal(
    doc.speakers.find((person) => person.handle === "bob"),
    undefined,
  );
  assert.equal(doc.raw.samples[0][1].alice, 80);
  assert.ok(doc.raw.samples.some((sample) => sample[1].bob === 60));
});

test("reads the Space roster into host and speakers", () => {
  const roster = rosterFromSpace({
    metadata: { creator_results: { result: { rest_id: "9", core: { screen_name: "hostuser", name: "主持人" } } } },
    participants: {
      admins: [{ twitter_screen_name: "hostuser", display_name: "主持人", user_results: { rest_id: "9" } }],
      speakers: [
        { twitter_screen_name: "alice", display_name: "Alice", user_results: { rest_id: "2" } },
        { twitter_screen_name: "alice", display_name: "重复", user_results: { rest_id: "2" } },
      ],
    },
  });
  assert.deepEqual(roster.host, { id: "tw-9", handle: "hostuser", name: "主持人" });
  assert.deepEqual(roster.people, [
    { id: "tw-9", handle: "hostuser", name: "主持人", role: "admin" },
    { id: "tw-2", handle: "alice", name: "Alice", role: "speaker" },
  ]);
});

test("muxes AAC frames that begin with an ID3 tag, across chunk boundaries", () => {
  const collector = createAacCollector();
  const frame = makeAdts(16);
  const parts = [
    collector.push(concat([id3Wrap(new Uint8Array([1, 2, 3])), frame])),
    collector.push(frame.subarray(0, 4)),
    collector.push(frame.subarray(4)),
  ];
  assert.equal(parts[0].length, 16);
  assert.equal(parts[1], null);
  assert.equal(parts[2].length, 16);
  const summary = collector.finish();
  assert.equal(summary.frameCount, 2);
  assert.equal(summary.sampleRate, 48000);
  assert.equal(summary.channels, 2);
  assert.deepEqual(boxes(m4aHeader(summary)), ["ftyp", "moov", "mdat"]);
});

test("writes title, artist and cover into the m4a", async (t) => {
  const cover = { bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), type: "jpeg" };
  const metadata = {
    title: "周会 Weekly",
    artist: "Host",
    album: "X Spaces",
    date: "2026-01-02T03:04:00.000Z",
    comment: "https://x.com/i/spaces/1",
    cover,
  };
  const file = muxAacChunks([aacSegment(50)], metadata);
  const text = new TextDecoder("latin1").decode(file.bytes.subarray(0, 4000));
  assert.match(text, /udta/);
  assert.match(text, /ilst/);
  assert.match(text, /covr/);
  if (!HAS_FFPROBE) return t.skip("ffprobe not installed");
  const probe = await ffprobe(file.bytes);
  assert.equal(probe.streams[0].codec_name, "aac");
  assert.equal(probe.streams[0].sample_rate, "48000");
  assert.equal(probe.format.tags.title, "周会 Weekly");
  assert.equal(probe.format.tags.artist, "Host");
  assert.equal(probe.format.tags.album, "X Spaces");
});

test("pulls ADTS audio out of an MPEG-TS segment", () => {
  const adts = extractAdtsFromTs(tsSegment(12));
  const summary = muxAacChunks([adts]);
  assert.equal(summary.frameCount, 12);
});

// ---------- 下载流程（模拟网络） ----------

test("downloads plain .aac segments into an m4a", async () => {
  const names = ["chunk_0.aac", "chunk_1.aac", "chunk_2.aac"];
  const routes = { [`${CDN}/playlist.m3u8`]: mediaPlaylist(names) };
  for (const name of names) routes[`${CDN}/${name}`] = aacSegment(20);
  const mock = mockFetch(routes);
  try {
    const progress = [];
    const file = await downloadRecording(`${CDN}/playlist.m3u8`, { limits: FAST, onProgress: (p) => progress.push(p) });
    const bytes = await blobBytes(file.blob);
    assert.equal(file.extension, "m4a");
    assert.equal(file.segmentCount, 3);
    assert.deepEqual(boxes(bytes), ["ftyp", "moov", "mdat"]);
    assert.ok(Math.abs(file.durationSeconds - (60 * 1024) / 48000) < 0.001);
    assert.ok(progress.some((p) => p.phase === "segment" && p.completed === 3));
    assert.ok(progress.some((p) => p.phase === "mux" && p.completed === 3));
  } finally {
    mock.restore();
  }
});

test("decrypts AES-128 segments using the media sequence as IV", async () => {
  const keyBytes = new Uint8Array(16).fill(7);
  const names = ["a.aac", "b.aac"];
  const routes = {
    [`${CDN}/p.m3u8`]: mediaPlaylist(names, { key: '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"', sequence: 5 }),
    [`${CDN}/key.bin`]: keyBytes,
    [`${CDN}/a.aac`]: await aesEncrypt(aacSegment(10), keyBytes, 5),
    [`${CDN}/b.aac`]: await aesEncrypt(aacSegment(10), keyBytes, 6),
  };
  const mock = mockFetch(routes);
  try {
    const file = await downloadRecording(`${CDN}/p.m3u8`, { limits: FAST });
    assert.equal(file.extension, "m4a");
    assert.ok(Math.abs(file.durationSeconds - (20 * 1024) / 48000) < 0.001);
    assert.equal(mock.log.filter((url) => url.endsWith("key.bin")).length, 1);
  } finally {
    mock.restore();
  }
});

test("extracts audio from TS segments in audio mode", async () => {
  const routes = {
    [`${CDN}/v.m3u8`]: mediaPlaylist(["0.ts", "1.ts"]),
    [`${CDN}/0.ts`]: tsSegment(15),
    [`${CDN}/1.ts`]: tsSegment(15),
  };
  const mock = mockFetch(routes);
  try {
    const file = await downloadRecording(`${CDN}/v.m3u8`, { limits: FAST });
    assert.equal(file.extension, "m4a");
    assert.ok(Math.abs(file.durationSeconds - (30 * 1024) / 48000) < 0.001);
  } finally {
    mock.restore();
  }
});

test("keeps raw TS in video mode when no remuxer is available", async () => {
  const routes = {
    [`${CDN}/v.m3u8`]: mediaPlaylist(["0.ts", "1.ts"]),
    [`${CDN}/0.ts`]: tsSegment(5),
    [`${CDN}/1.ts`]: tsSegment(5),
  };
  const mock = mockFetch(routes);
  try {
    const file = await downloadRecording(`${CDN}/v.m3u8`, { mode: "video", limits: FAST });
    assert.equal(file.extension, "ts");
    assert.equal(file.blob.size, tsSegment(5).length * 2);
  } finally {
    mock.restore();
  }
});

test("resumes from segments already stored by an interrupted run", async () => {
  const names = ["s0.aac", "s1.aac", "s2.aac", "s3.aac"];
  const routes = { [`${CDN}/p.m3u8`]: mediaPlaylist(names) };
  for (const name of names) routes[`${CDN}/${name}`] = aacSegment(8);
  routes[`${CDN}/s3.aac`] = () => new Response("gone", { status: 404 });
  const store = createMemoryStore();
  const first = mockFetch(routes);
  try {
    await assert.rejects(downloadRecording(`${CDN}/p.m3u8`, { store, limits: FAST }), /404/);
  } finally {
    first.restore();
  }
  assert.equal((await store.completed()).size, 3);

  routes[`${CDN}/s3.aac`] = aacSegment(8);
  const second = mockFetch(routes);
  try {
    const file = await downloadRecording(`${CDN}/p.m3u8`, { store, limits: FAST });
    assert.equal(file.segmentCount, 4);
    assert.deepEqual(
      second.log.filter((url) => url.endsWith(".aac")),
      [`${CDN}/s3.aac`],
    );
  } finally {
    second.restore();
  }
});

test("starts over when the stored run belongs to a different playlist", async () => {
  const store = createMemoryStore();
  await store.prepare({ mode: "audio", total: 2, first: "old.aac", last: "old2.aac" });
  await store.put(0, new Uint8Array([1, 2, 3]));
  const routes = {
    [`${CDN}/p.m3u8`]: mediaPlaylist(["n0.aac", "n1.aac"]),
    [`${CDN}/n0.aac`]: aacSegment(4),
    [`${CDN}/n1.aac`]: aacSegment(4),
  };
  const mock = mockFetch(routes);
  try {
    await downloadRecording(`${CDN}/p.m3u8`, { store, limits: FAST });
    assert.equal(mock.log.filter((url) => url.endsWith(".aac")).length, 2);
  } finally {
    mock.restore();
  }
});

test("refreshes an expired replay address once and keeps going", async () => {
  const fresh = "https://prod-fastly.video.pscp.tv/Transcoding/v1/hls/token2";
  const names = ["c0.aac", "c1.aac"];
  const routes = {
    [`${CDN}/p.m3u8`]: mediaPlaylist(names),
    [`${CDN}/c0.aac`]: () => new Response("expired", { status: 403 }),
    [`${CDN}/c1.aac`]: () => new Response("expired", { status: 403 }),
    [`${fresh}/p.m3u8`]: mediaPlaylist(names),
    [`${fresh}/c0.aac`]: aacSegment(6),
    [`${fresh}/c1.aac`]: aacSegment(6),
  };
  const mock = mockFetch(routes);
  let refreshes = 0;
  try {
    const file = await downloadRecording(`${CDN}/p.m3u8`, {
      limits: FAST,
      refreshMedia: async () => {
        refreshes += 1;
        return `${fresh}/p.m3u8`;
      },
    });
    assert.equal(file.segmentCount, 2);
    assert.equal(refreshes, 1);
  } finally {
    mock.restore();
  }
});

test("retries a segment after a 503", async () => {
  let calls = 0;
  const routes = {
    [`${CDN}/p.m3u8`]: mediaPlaylist(["r0.aac"]),
    [`${CDN}/r0.aac`]: () => {
      calls += 1;
      return calls === 1 ? new Response("busy", { status: 503 }) : new Response(aacSegment(4));
    },
  };
  const mock = mockFetch(routes);
  try {
    const file = await downloadRecording(`${CDN}/p.m3u8`, { limits: FAST });
    assert.equal(file.segmentCount, 1);
    assert.equal(calls, 2);
  } finally {
    mock.restore();
  }
});

test("refuses unfinished playlists and foreign hosts", async () => {
  const mock = mockFetch({ [`${CDN}/live.m3u8`]: mediaPlaylist(["x.aac"], { endList: false }) });
  try {
    await assert.rejects(downloadRecording(`${CDN}/live.m3u8`, { limits: FAST }), (error) => error.code === "live");
    await assert.rejects(
      downloadRecording("https://example.com/p.m3u8", { limits: FAST }),
      (error) => error.code === "playlist",
    );
  } finally {
    mock.restore();
  }
});

test("stops when the signal is aborted", async () => {
  const controller = new AbortController();
  const routes = {
    [`${CDN}/p.m3u8`]: mediaPlaylist(["a.aac"]),
    [`${CDN}/a.aac`]: () => {
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    },
  };
  const mock = mockFetch(routes);
  try {
    await assert.rejects(
      downloadRecording(`${CDN}/p.m3u8`, { limits: FAST, signal: controller.signal }),
      (error) => error.code === "cancelled",
    );
  } finally {
    mock.restore();
  }
});
