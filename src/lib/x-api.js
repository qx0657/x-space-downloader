import { asSpaceError, SpaceError } from "./errors.js";
import { fetchWithTimeout } from "./net.js";
import { epochMs } from "./format.js";
import { apiLanguage, t } from "./i18n.js";
import { fetchText, isAudioOnly, mediaKind, parsePlaylist, resolveMedia, selectPlaylistTarget } from "./hls.js";
import { spacePageUrl } from "./space-url.js";
import { rosterFromSpace } from "./speakers.js";

// x.com 网页自己带的公开客户端令牌，不是用户密钥。
// 登录身份只来自浏览器里的 auth_token / ct0。
export const PUBLIC_BEARER =
  "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs=1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";
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
    "x-twitter-client-language": apiLanguage(),
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
    throw new SpaceError(code, t("apiEmpty", response.status));
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new SpaceError("http", t("apiBadJson", response.status));
  }
  if (!response.ok) {
    const message = (json.errors || [])
      .map((item) => item.message)
      .filter(Boolean)
      .join("；");
    const staleQuery =
      /\/graphql\//.test(url) && /unknown operation|query not found|could not find operation/i.test(message);
    const code = response.status === 401 || response.status === 403 ? "auth" : staleQuery ? "query" : "http";
    throw new SpaceError(code, message || t("apiFailed", response.status));
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
  if (!json.guest_token) throw new SpaceError("auth", t("guestFailed"));
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
  throw lastError || new SpaceError("http", t("apiFailedPlain"));
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
      throw new SpaceError("query", t("queryStale"));
    }
    throw new SpaceError("missing", messages.join("；") || t("spaceMissing"));
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
  if (!playlistUrl) throw new SpaceError("stream", t("noReplayUrl"));
  if (playlistUrl.includes("/geoblocked/")) throw new SpaceError("geo", t("geoBlocked"));
  return playlistUrl;
}

function creatorOf(metadata) {
  const result = metadata.creator_results?.result || {};
  const core = result.core || {};
  const legacy = result.legacy || {};
  const avatar = result.avatar?.image_url || legacy.profile_image_url_https || "";
  return {
    creatorName: core.name || legacy.name || "",
    handle: core.screen_name || legacy.screen_name || "",
    avatarUrl: avatar.replace(/_normal(\.\w+)$/, "_400x400$1"),
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
      message: ready ? "" : t("replayNotReady"),
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
  if (!audioTarget?.url) throw new SpaceError("playlist", t("playlistNoAudio"));
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
  const videoBytesEstimate =
    videoBandwidth && audio.durationSeconds ? Math.round((videoBandwidth * audio.durationSeconds) / 8) : 0;
  return {
    canDownload: ready,
    message: ready ? "" : t("replayNotReady"),
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
    throw new SpaceError("url", t("notSpaceUrl"));
  }
  const space = await fetchAudioSpace(session, spaceId, queryId);
  const metadata = space.metadata || {};
  const startedAt = epochMs(metadata.started_at || metadata.scheduled_start);
  const endedAt = epochMs(metadata.ended_at);
  const metadataDuration = startedAt && endedAt && endedAt > startedAt ? (endedAt - startedAt) / 1000 : null;
  const info = {
    spaceId,
    url: spacePageUrl(spaceId),
    title: metadata.title || t("untitled"),
    state: metadata.state || "",
    replay: Boolean(metadata.is_space_available_for_replay),
    contentType: metadata.content_type || "",
    mediaKey: metadata.media_key || "",
    ...creatorOf(metadata),
    roster: rosterFromSpace(space),
    startedAt,
    endedAt,
    ...emptyPlayback(),
    durationSeconds: metadataDuration,
  };

  if (info.state === "NotStarted") {
    info.message = t("notStarted");
    return info;
  }
  if (!info.mediaKey) {
    if (info.state === "Running") info.message = t("liveNow");
    else if (!info.replay) info.message = t("noReplay");
    else info.message = t("replayGenerating");
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
    const response = await fetchWithTimeout("https://x.com/", { credentials: "omit" }, 10000);
    if (!response.ok) return null;
    const html = await response.text();
    const urls = [...html.matchAll(/https:\/\/abs\.twimg\.com\/responsive-web\/client-web\/[^"'\\\s>]+\.js/g)].map(
      (match) => match[0],
    );
    return searchScripts(rankScripts(urls));
  } catch {
    return null;
  }
}
