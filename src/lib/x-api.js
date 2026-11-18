import { asSpaceError, SpaceError } from "./errors.js";
import { fetchWithTimeout } from "./net.js";
import { epochMs, fileBase } from "./format.js";
import {
  fetchText,
  isAudioOnly,
  mediaKind,
  parsePlaylist,
  resolveMedia,
  selectPlaylistTarget,
} from "./hls.js";
import { spacePageUrl } from "./space-url.js";

// x.com 网页自己带的公开客户端令牌，不是用户密钥。
// 登录身份只来自浏览器里的 auth_token / ct0。
export const PUBLIC_BEARER = "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs=1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";
export const DEFAULT_QUERY_ID = "zm3JmUpYWDXIUsf_33-ZrA";

const FEATURES = {
  dont_mention_me_view_api_enabled: true,
  interactive_text_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  responsive_web_enhance_cards_enabled: true,
  responsive_web_uc_gql_enabled: true,
  spaces_2022_h2_clipping: true,
  spaces_2022_h2_spaces_communities: false,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: false,
  vibe_api_enabled: true,
};

function headersFor(session, extra = {}) {
  const headers = {
    authorization: `Bearer ${PUBLIC_BEARER}`,
    accept: "*/*",
    "x-twitter-active-user": "yes",
    "x-twitter-client-language": "zh-cn",
    ...extra,
  };
  if (session.mode === "user") {
    headers["x-csrf-token"] = session.csrf;
    headers["x-twitter-auth-type"] = "OAuth2Session";
  } else if (session.guestToken) {
    headers["x-guest-token"] = session.guestToken;
  }
  return headers;
}

async function apiFetch(session, url, options = {}) {
  const response = await fetchWithTimeout(url, {
    method: options.method || "GET",
    body: options.body,
    headers: headersFor(session, options.headers),
    credentials: session.mode === "user" ? "include" : "omit",
    signal: options.signal,
  });
  const text = await response.text();
  if (!text) {
    const code = response.status === 401 || response.status === 403 ? "auth" : "http";
    throw new SpaceError(code, `X 没有返回数据（${response.status}）`);
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new SpaceError("http", `X 返回了无法解析的内容（${response.status}）`);
  }
  if (!response.ok) {
    const message = (json.errors || []).map((item) => item.message).filter(Boolean).join("；");
    const staleQuery = /\/graphql\//.test(url) && /unknown operation|query not found|could not find operation/i.test(message);
    const code = response.status === 401 || response.status === 403 ? "auth" : (staleQuery ? "query" : "http");
    throw new SpaceError(code, message || `X 请求失败（${response.status}）`);
  }
  return json;
}

export async function activateGuest(signal) {
  const json = await apiFetch({ mode: "guest" }, "https://api.x.com/1.1/guest/activate.json", {
    method: "POST",
    body: "{}",
    headers: { "content-type": "application/json" },
    signal,
  });
  if (!json.guest_token) throw new SpaceError("auth", "没有拿到 X 的访客令牌");
  return json.guest_token;
}

async function firstOk(requests) {
  let lastError = null;
  for (const request of requests) {
    try {
      return await request();
    } catch (error) {
      lastError = error;
      if (error.code === "query") throw error;
    }
  }
  throw lastError || new SpaceError("http", "X 请求失败");
}

async function fetchAudioSpace(session, spaceId, queryId) {
  const params = new URLSearchParams({
    variables: JSON.stringify({
      id: spaceId,
      isMetatagsQuery: true,
      withDownvotePerspective: false,
      withReactionsMetadata: false,
      withReactionsPerspective: false,
      withReplays: true,
      withSuperFollowsUserFields: true,
      withSuperFollowsTweetFields: true,
    }),
    features: JSON.stringify(FEATURES),
  });
  const json = await firstOk([
    () => apiFetch(session, `https://x.com/i/api/graphql/${queryId}/AudioSpaceById?${params}`),
    () => apiFetch(session, `https://api.x.com/graphql/${queryId}/AudioSpaceById?${params}`),
  ]);
  const space = json?.data?.audioSpace;
  if (!space) {
    const messages = (json?.errors || [])
      .map((item) => item.message)
      .filter((message) => message && message.toLowerCase() !== "dependency: unspecified");
    if (messages.some((message) => /query|unknown operation/i.test(message))) {
      throw new SpaceError("query", "Space 接口编号已失效");
    }
    throw new SpaceError("missing", messages.join("；") || "找不到这场 Space");
  }
  return space;
}

async function fetchPlaylistUrl(session, mediaKey) {
  const json = await firstOk([
    () => apiFetch(session, `https://x.com/i/api/1.1/live_video_stream/status/${mediaKey}`),
    () => apiFetch(session, `https://api.x.com/1.1/live_video_stream/status/${mediaKey}`),
  ]);
  const source = json.source || {};
  const playlistUrl = source.noRedirectPlaybackUrl || source.location || "";
  if (!playlistUrl) throw new SpaceError("stream", "没有拿到回放地址");
  if (playlistUrl.includes("/geoblocked/")) throw new SpaceError("geo", "这个回放在当前地区不可用");
  return playlistUrl;
}

function creatorOf(metadata) {
  const result = metadata.creator_results?.result || {};
  const core = result.core || result.legacy || {};
  return {
    creatorName: core.name || "",
    handle: core.screen_name || "",
  };
}

function emptyPlayback() {
  return {
    canDownload: false,
    message: "",
    durationSeconds: null,
    segmentCount: 0,
    mediaKind: "",
    audioMediaUrl: "",
    videoMediaUrl: "",
    videoAvailable: false,
    videoBandwidth: 0,
    videoBytesEstimate: 0,
  };
}

async function describePlaylists(playlistUrl) {
  const master = parsePlaylist(await fetchText(playlistUrl), playlistUrl);
  if (master.kind === "media") {
    const kind = mediaKind(master);
    const video = kind === "ts";
    const ready = master.endList && master.segments.length > 0;
    return {
      canDownload: ready,
      message: ready ? "" : "回放还没有生成完整文件。若这场仍在直播，请等结束后再下载。",
      durationSeconds: master.durationSeconds,
      segmentCount: master.segments.length,
      mediaKind: kind,
      audioMediaUrl: master.url,
      videoMediaUrl: video ? master.url : "",
      videoAvailable: video,
      videoBandwidth: 0,
      videoBytesEstimate: 0,
    };
  }

  const audioTarget = selectPlaylistTarget(master, "audio");
  const videoTarget = selectPlaylistTarget(master, "video");
  if (!audioTarget?.url) throw new SpaceError("playlist", "播放列表里没有音轨");
  const audio = await resolveMedia(audioTarget.url, "audio");
  const kind = mediaKind({ ...audio, codecs: audio.codecs || audioTarget.codecs });
  let videoMediaUrl = "";
  let videoBandwidth = 0;
  if (videoTarget?.url && !isAudioOnly(videoTarget.codecs || "")) {
    const video = await resolveMedia(videoTarget.url, "video");
    videoMediaUrl = video.url;
    videoBandwidth = videoTarget.bandwidth || video.bandwidth || 0;
  } else if (kind === "ts") {
    videoMediaUrl = audio.url;
  }
  const ready = audio.endList && audio.segments.length > 0;
  const videoBytesEstimate = videoBandwidth && audio.durationSeconds
    ? Math.round((videoBandwidth * audio.durationSeconds) / 8)
    : 0;
  return {
    canDownload: ready,
    message: ready ? "" : "回放还没有生成完整文件。若这场仍在直播，请等结束后再下载。",
    durationSeconds: audio.durationSeconds,
    segmentCount: audio.segments.length,
    mediaKind: kind,
    audioMediaUrl: audio.url,
    videoMediaUrl,
    videoAvailable: Boolean(videoMediaUrl),
    videoBandwidth,
    videoBytesEstimate,
  };
}

export async function inspectSpace(spaceId, session, { queryId = DEFAULT_QUERY_ID } = {}) {
  if (!/^[0-9A-Za-z]{13,}$/.test(spaceId || "")) {
    throw new SpaceError("url", "这不是 Space 链接");
  }
  const space = await fetchAudioSpace(session, spaceId, queryId);
  const metadata = space.metadata || {};
  const startedAt = epochMs(metadata.started_at || metadata.scheduled_start);
  const endedAt = epochMs(metadata.ended_at);
  const metadataDuration = startedAt && endedAt && endedAt > startedAt ? (endedAt - startedAt) / 1000 : null;
  const info = {
    spaceId,
    url: spacePageUrl(spaceId),
    title: metadata.title || "未命名 Space",
    state: metadata.state || "",
    replay: Boolean(metadata.is_space_available_for_replay),
    contentType: metadata.content_type || "",
    mediaKey: metadata.media_key || "",
    ...creatorOf(metadata),
    startedAt,
    endedAt,
    ...emptyPlayback(),
    durationSeconds: metadataDuration,
  };

  if (info.state === "NotStarted") {
    info.message = "这场 Space 还没开始。";
    return info;
  }
  if (!info.mediaKey) {
    if (info.state === "Running") info.message = "正在直播。完整录音要等这场结束，并且主持人保留了回放。";
    else if (!info.replay) info.message = "这场 Space 已结束，主持人没有保留回放。";
    else info.message = "回放还在生成，过几分钟再试。";
    return info;
  }

  try {
    const playlistUrl = await fetchPlaylistUrl(session, info.mediaKey);
    const playback = await describePlaylists(playlistUrl);
    const durationSeconds = playback.durationSeconds || info.durationSeconds;
    return { ...info, ...playback, durationSeconds };
  } catch (error) {
    const wrapped = asSpaceError(error);
    info.message = wrapped.message;
    return info;
  }
}

export async function prepareDownload(spaceId, session, options = {}) {
  const info = await inspectSpace(spaceId, session, options);
  if (!info.canDownload) throw new SpaceError("unavailable", info.message || "没有可下载的录音");
  const video = Boolean(options.video);
  if (video && !info.videoAvailable) throw new SpaceError("video", "这场 Space 没有视频回放");
  return {
    ...presentable(info),
    mediaUrl: video ? info.videoMediaUrl : info.audioMediaUrl,
    mode: video ? "video" : "audio",
    baseName: fileBase(info),
  };
}

export function presentable(info) {
  const copy = { ...info };
  delete copy.audioMediaUrl;
  delete copy.videoMediaUrl;
  delete copy.mediaUrl;
  delete copy.mediaKey;
  return copy;
}

export function findQueryId(source) {
  const patterns = [
    /queryId:"([A-Za-z0-9_-]{12,40})",operationName:"AudioSpaceById"/,
    /operationName:"AudioSpaceById",queryId:"([A-Za-z0-9_-]{12,40})"/,
  ];
  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match) return match[1];
  }
  return null;
}

function rankScripts(urls) {
  const score = (url) => {
    let value = 0;
    if (/AudioSpace/i.test(url)) value += 5;
    if (/\/main\./i.test(url)) value += 3;
    if (/bundle/i.test(url)) value += 2;
    if (/vendor|icons|i18n/i.test(url)) value -= 3;
    return value;
  };
  return [...new Set((urls || []).filter(Boolean))].sort((a, b) => score(b) - score(a));
}

async function searchScripts(urls) {
  for (const url of urls.slice(0, 2)) {
    try {
      const response = await fetchWithTimeout(url, { credentials: "omit" }, 8000);
      if (!response.ok) continue;
      const found = findQueryId(await response.text());
      if (found) return found;
    } catch {
      // 换下一个脚本继续找。
    }
  }
  return null;
}

export async function discoverQueryId(scriptUrls = []) {
  const found = await searchScripts(rankScripts(scriptUrls));
  if (found) return found;
  try {
    const response = await fetch("https://x.com/", { credentials: "omit" });
    if (!response.ok) return null;
    const html = await response.text();
    const urls = [...html.matchAll(/https:\/\/abs\.twimg\.com\/responsive-web\/client-web\/[^"'\\\s>]+\.js/g)]
      .map((match) => match[0]);
    return searchScripts(rankScripts(urls));
  } catch {
    return null;
  }
}
