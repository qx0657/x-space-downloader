#!/usr/bin/env node
// 命令行下载 Space 回放：保存 m4a 和 .speakers.json（谁在什么时间说话）。
// 只用游客身份，公开 Space 不需要登录。
//
//   node tools/download.mjs https://x.com/i/spaces/1pedlnlnyjZevP
//   node tools/download.mjs 1pedlnlnyjZevP --out-dir ~/Downloads/X-Spaces
//   node tools/download.mjs <链接> --info
//
// 最后一行向 stdout 输出一行 JSON，写明文件路径，方便脚本或 AI 接着处理。

import { createWriteStream } from "node:fs";
import { access, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parseArgs } from "node:util";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const nativeFetch = globalThis.fetch;
// 没有浏览器 User-Agent 时，X 会把游客请求当成无效页面拒掉。
globalThis.fetch = (url, options = {}) => {
  const headers = new Headers(options.headers || {});
  if (!headers.has("user-agent")) headers.set("user-agent", UA);
  headers.set("origin", "https://x.com");
  headers.set("referer", "https://x.com/");
  return nativeFetch(url, { ...options, headers });
};

const { activateGuest, inspectSpace, presentable } = await import("../src/lib/x-api.js");
const { downloadRecording } = await import("../src/lib/hls.js");
const { spaceIdFromText, spacePageUrl } = await import("../src/lib/space-url.js");
const { fileBase, DEFAULT_FOLDER } = await import("../src/lib/format.js");

const USAGE = `用法：node tools/download.mjs <Space 链接或 ID> [选项]

  --out-dir <目录>      保存位置，默认 ~/Downloads/${DEFAULT_FOLDER}
  --name <模板>         文件名模板，可用 {date} {time} {handle} {name} {title} {id}
  --max-segments <n>    只下载前 n 个分片（每片约 3 秒），用来试跑
  --info                只查看 Space 信息，不下载
  --force               已有同名文件时也重新下载
  -h, --help            显示帮助`;

function fail(message) {
  console.error(message);
  process.exit(1);
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function expandHome(path) {
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

function speakerSource(info) {
  return {
    roster: {
      host: {
        id: info.roster?.host?.id || "",
        handle: info.roster?.host?.handle || info.handle || "",
        name: info.roster?.host?.name || info.creatorName || "",
      },
      people: info.roster?.people || [],
    },
    space: {
      id: info.spaceId,
      url: info.url || spacePageUrl(info.spaceId),
      title: info.title || "",
      startedAt: info.startedAt || null,
      endedAt: info.endedAt || null,
    },
  };
}

function metadataFor(info) {
  return {
    title: info.title || "",
    artist: info.creatorName || (info.handle ? `@${info.handle}` : ""),
    album: "X Spaces",
    date: info.startedAt ? new Date(info.startedAt).toISOString() : "",
    comment: spacePageUrl(info.spaceId),
  };
}

function progressReporter() {
  let last = "";
  return ({ phase, completed, total }) => {
    const label = phase === "segment" ? "下载分片" : phase === "mux" ? "合成音频" : "读取播放列表";
    const line = total ? `${label} ${completed}/${total}` : label;
    if (line === last) return;
    last = line;
    if (process.stderr.isTTY) process.stderr.write(`\r${line}\u001b[K`);
    else if (!total || completed === total || completed % 100 === 0) console.error(line);
  };
}

async function inspect(spaceId) {
  const session = { mode: "guest", guestToken: await activateGuest() };
  return inspectSpace(spaceId, session);
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "out-dir": { type: "string" },
    name: { type: "string" },
    "max-segments": { type: "string" },
    info: { type: "boolean" },
    force: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help || !positionals.length) {
  console.log(USAGE);
  process.exit(values.help ? 0 : 1);
}

const spaceId = spaceIdFromText(positionals.join(" "));
if (!spaceId) fail(`认不出 Space 链接：${positionals.join(" ")}`);

let info;
try {
  info = await inspect(spaceId);
} catch (error) {
  fail(`读取 Space 信息失败：${error.message}`);
}

if (values.info) {
  console.log(JSON.stringify(presentable(info), null, 2));
  process.exit(0);
}
if (!info.audioMediaUrl) fail(info.message || "这个 Space 没有可下载的回放");

const outDir = resolve(expandHome(values["out-dir"] || join("~/Downloads", DEFAULT_FOLDER)));
const maxSegments = values["max-segments"] ? Number(values["max-segments"]) : Infinity;
if (!(maxSegments > 0)) fail("--max-segments 需要是正整数");
const base = fileBase(info, values.name) + (Number.isFinite(maxSegments) ? ` (前${maxSegments}片)` : "");
const audioPath = join(outDir, `${base}.m4a`);
const speakersPath = join(outDir, `${base}.speakers.json`);
const summary = {
  spaceId: info.spaceId,
  url: info.url,
  title: info.title,
  host: info.handle ? `@${info.handle}` : info.creatorName || "",
  startedAt: info.startedAt ? new Date(info.startedAt).toISOString() : null,
  audio: audioPath,
  speakers: speakersPath,
};

if (!values.force && (await exists(audioPath)) && (await exists(speakersPath))) {
  console.error(`已存在，跳过下载（需要重下请加 --force）：${audioPath}`);
  console.log(JSON.stringify({ ...summary, skipped: true }));
  process.exit(0);
}

await mkdir(outDir, { recursive: true });
console.error(`下载「${info.title}」到 ${outDir}`);
let file;
try {
  file = await downloadRecording(info.audioMediaUrl, {
    maxSegments,
    metadata: metadataFor(info),
    speakers: speakerSource(info),
    refreshMedia: async () => {
      const fresh = await inspect(spaceId);
      if (!fresh.audioMediaUrl) throw new Error(fresh.message || "回放地址已失效");
      return fresh.audioMediaUrl;
    },
    onProgress: progressReporter(),
  });
} catch (error) {
  if (process.stderr.isTTY) process.stderr.write("\n");
  fail(`下载失败：${error.message}`);
}
if (process.stderr.isTTY) process.stderr.write("\n");
if (file.extension !== "m4a") fail(`这个回放不是音频（${file.extension}），命令行版只支持音频 Space`);

await pipeline(Readable.fromWeb(file.blob.stream()), createWriteStream(audioPath));
await writeFile(speakersPath, `${JSON.stringify(file.speakers, null, 2)}\n`);
console.log(JSON.stringify({ ...summary, durationSeconds: Math.round(file.durationSeconds) }));
