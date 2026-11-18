// UI and error strings. The offscreen page only has chrome.runtime, so chrome.i18n can't be
// used everywhere; the language follows navigator.language in every context instead.
// _locales/ only covers the manifest fields the Chrome Web Store reads.

const zh = {
  appName: "X Space 录音",
  tagline: "把回放保存成音频文件",
  spaceLink: "Space 链接",
  inspect: "解析",
  downloadAudio: "下载录音",
  downloadVideo: "下载视频",
  downloadVideoSize: "下载视频 · 约 $1",
  cancel: "取消",
  close: "关闭",
  settings: "设置",
  progress: "下载进度",
  hideForever: "不再显示",
  hideForeverHint: "以后不在页面上显示这个面板，可在扩展设置里重新打开",
  thisSpace: "这场 Space",
  segments: "$1 段",
  savedIn: "文件保存在“下载 / $1”",
  savedInRoot: "文件保存在“下载”文件夹",

  stateRunning: "直播中",
  stateNotStarted: "未开始",
  stateEndedReplay: "已结束 · 有回放",
  stateEndedNoReplay: "已结束 · 无回放",
  stateUnknown: "未知状态",

  inspecting: "正在解析…",
  inspectFailed: "解析失败",
  fetchingReplayUrl: "正在获取回放地址…",
  fetchingVideoUrl: "正在获取视频地址…",
  readingPlaylist: "正在读取播放列表…",
  preparingWithBoth: "正在准备下载… 时长 $1，共 $2 段",
  preparingWithSegments: "正在准备下载… 共 $1 段",
  downloading: "正在下载…",
  downloadingProgress: "正在下载 $1/$2 · $3%",
  lanes: " · $1 路",
  muxing: "分片已下完，正在合成… $1%",
  savingFile: "正在保存文件…",
  savedToDownloads: "已保存到下载文件夹",
  savedAs: "已保存 $1",
  cancelling: "正在取消…",
  cancelled: "已取消下载",
  cancelledDownload: "已取消下载",
  notifyAudioSaved: "Space 录音已保存",
  notifyVideoSaved: "Space 视频已保存",

  busyOther: "正在下载另一场 Space「$1」，等它完成或取消后再试",
  busyElsewhere: "正在下载另一场 Space「$1」· $2%",
  busyGeneric: "已经有一个下载在进行",
  interruptedResume: "上次下载中断了。再点一次下载，会从中断的地方继续",
  downloadNotStarted: "下载没有开始",
  offscreenFailed: "下载组件没有启动",
  backgroundTimeout: "后台没有响应，请重试",
  requestFailed: "请求失败",
  saveInterrupted: "浏览器没有保存文件 $1",

  notSpaceUrl: "这不是 Space 链接",
  notSpaceUrlHelp: "这不是 Space 链接。打开 x.com/i/spaces/… 或把链接贴进来。",
  untitled: "未命名 Space",
  notStarted: "这场 Space 还没开始。",
  liveNow: "正在直播。完整录音要等这场结束，并且主持人保留了回放。",
  noReplay: "这场 Space 已结束，主持人没有保留回放。",
  replayGenerating: "回放还在生成，过几分钟再试。",
  replayNotReady: "回放还没有生成完整文件。若这场仍在直播，请等结束后再下载。",
  noRecording: "这场没有可下载的录音",
  noVideo: "这场 Space 没有视频回放",
  noReplayUrl: "没有拿到回放地址",
  replayUrlExpired: "回放地址过期了，重新获取也没有成功",
  geoBlocked: "这个回放在当前地区不可用",
  spaceMissing: "找不到这场 Space",
  queryStale: "Space 接口编号已失效",
  queryChanged: "X 的 Space 接口变了，暂时解析不了。打开一场 Space 页面后再试。",
  guestFailed: "没有拿到 X 的访客令牌",
  apiEmpty: "X 没有返回数据（$1）",
  apiBadJson: "X 返回了无法解析的内容（$1）",
  apiFailed: "X 请求失败（$1）",
  apiFailedPlain: "X 请求失败",
  networkFailed: "网络请求失败",
  timeout: "连接超时，请再点一次下载",
  mediaUrlRejected: "回放地址不在允许的域名里，已停止",

  playlistHttp: "打不开播放列表（$1）",
  playlistNoAudio: "播放列表里没有可下载的音轨",
  playlistNested: "播放列表嵌套异常",
  playlistEmpty: "播放列表是空的",
  playlistTooLong: "播放列表异常地长，已停止",
  playlistChanged: "重新获取的播放列表和原来的对不上",
  noSegments: "没有可下载的音频分片",
  segmentHttp: "分片下载失败（$1）",
  encryptedUnsupported: "这条回放的加密方式暂不支持",
  useVideoDownload: "这条回放是视频分段，请改用下载视频",
  unknownAudioFormat: "认不出回放的音频格式",
  remuxFailed: "视频转成 MP4 失败",

  aacNoChannels: "音频声道信息不完整，没法封装成 m4a",
  aacFormatChanged: "录音中途换了采样率或声道，没法合成一个文件",
  aacUnaligned: "有一段音频对不上 AAC 帧，下载已停止",
  aacNoFrames: "没有解析出音频帧",
  aacDescriptor: "音频描述块超出预期",
  aacTooLarge: "录音超过 4GB，没法存成一个文件",
  tsNotMpegTs: "视频分片不是 MPEG-TS",
  tsNoAudio: "没有在视频回放里找到音轨",
  tsLatm: "这条视频回放的音频封装暂时抽不出来，可以改下载视频",

  settingsTitle: "X Space 录音 · 设置",
  optFolder: "保存子目录",
  optFolderHint: "相对于浏览器的下载文件夹，留空则直接放在下载文件夹里。",
  optTemplate: "文件名模板",
  optTemplateHint: "可用：{date} {time} {handle} {name} {title} {id}",
  optPreview: "示例：$1",
  optVideoFormat: "视频保存格式",
  optVideoMp4: "MP4（推荐，系统播放器能直接打开）",
  optVideoTs: "MPEG-TS（原始分段，不做转换）",
  optConcurrency: "最大并发连接数",
  optConcurrencyHint: "0 表示按设备和网络自动调整。",
  optMetadata: "在音频文件里写入标题、主持人、日期和封面",
  optSpeakers: "同时保存发言人时间线（.speakers.json），记录谁在什么时间说话",
  optShowPanel: "在 Space 页面右下角显示下载面板",
  optSaved: "已保存",
};

const en = {
  appName: "X Space Downloader",
  tagline: "Save Space replays as audio files",
  spaceLink: "Space link",
  inspect: "Check",
  downloadAudio: "Download audio",
  downloadVideo: "Download video",
  downloadVideoSize: "Download video · ~$1",
  cancel: "Cancel",
  close: "Close",
  settings: "Settings",
  progress: "Download progress",
  hideForever: "Don't show again",
  hideForeverHint: "Stop showing this panel on pages. You can turn it back on in the extension settings.",
  thisSpace: "This Space",
  segments: "$1 segments",
  savedIn: "Files go to Downloads / $1",
  savedInRoot: "Files go to your Downloads folder",

  stateRunning: "Live",
  stateNotStarted: "Not started",
  stateEndedReplay: "Ended · replay available",
  stateEndedNoReplay: "Ended · no replay",
  stateUnknown: "Unknown",

  inspecting: "Checking…",
  inspectFailed: "Couldn't check this Space",
  fetchingReplayUrl: "Getting the replay address…",
  fetchingVideoUrl: "Getting the video address…",
  readingPlaylist: "Reading the playlist…",
  preparingWithBoth: "Preparing… $1 long, $2 segments",
  preparingWithSegments: "Preparing… $1 segments",
  downloading: "Downloading…",
  downloadingProgress: "Downloading $1/$2 · $3%",
  lanes: " · $1 connections",
  muxing: "All segments downloaded, assembling… $1%",
  savingFile: "Saving the file…",
  savedToDownloads: "Saved to your Downloads folder",
  savedAs: "Saved $1",
  cancelling: "Cancelling…",
  cancelled: "Download cancelled",
  cancelledDownload: "Download cancelled",
  notifyAudioSaved: "Space recording saved",
  notifyVideoSaved: "Space video saved",

  busyOther: 'Another Space ("$1") is downloading. Wait for it to finish or cancel it first.',
  busyElsewhere: 'Downloading another Space ("$1") · $2%',
  busyGeneric: "A download is already running",
  interruptedResume: "The last download was interrupted. Click download again to resume where it stopped.",
  downloadNotStarted: "The download didn't start",
  offscreenFailed: "The download component didn't start",
  backgroundTimeout: "The extension didn't respond. Try again.",
  requestFailed: "Request failed",
  saveInterrupted: "The browser didn't save the file $1",

  notSpaceUrl: "This isn't a Space link",
  notSpaceUrlHelp: "This isn't a Space link. Open x.com/i/spaces/… or paste the link here.",
  untitled: "Untitled Space",
  notStarted: "This Space hasn't started yet.",
  liveNow: "This Space is live. The full recording is available after it ends, if the host keeps the replay.",
  noReplay: "This Space has ended and the host didn't keep a replay.",
  replayGenerating: "The replay is still being prepared. Try again in a few minutes.",
  replayNotReady: "The replay isn't complete yet. If the Space is still live, wait until it ends.",
  noRecording: "There's no recording to download",
  noVideo: "This Space has no video replay",
  noReplayUrl: "Couldn't get the replay address",
  replayUrlExpired: "The replay address expired and refreshing it failed",
  geoBlocked: "This replay isn't available in your region",
  spaceMissing: "Couldn't find this Space",
  queryStale: "The Space API id has expired",
  queryChanged: "X changed its Space API. Open any Space page and try again.",
  guestFailed: "Couldn't get a guest token from X",
  apiEmpty: "X returned no data ($1)",
  apiBadJson: "X returned something unreadable ($1)",
  apiFailed: "X request failed ($1)",
  apiFailedPlain: "X request failed",
  networkFailed: "Network request failed",
  timeout: "The connection timed out. Click download again.",
  mediaUrlRejected: "The replay address isn't on an allowed domain, so the download stopped",

  playlistHttp: "Couldn't open the playlist ($1)",
  playlistNoAudio: "The playlist has no audio track to download",
  playlistNested: "The playlist is nested too deeply",
  playlistEmpty: "The playlist is empty",
  playlistTooLong: "The playlist is unusually long, so the download stopped",
  playlistChanged: "The refreshed playlist doesn't match the original",
  noSegments: "There are no audio segments to download",
  segmentHttp: "Segment download failed ($1)",
  encryptedUnsupported: "This replay uses an unsupported encryption method",
  useVideoDownload: "This replay is video. Use Download video instead.",
  unknownAudioFormat: "Couldn't recognise the replay's audio format",
  remuxFailed: "Converting the video to MP4 failed",

  aacNoChannels: "The audio is missing channel information, so it can't be packed into m4a",
  aacFormatChanged: "The sample rate or channel count changes mid-recording, so it can't be one file",
  aacUnaligned: "Part of the audio doesn't line up with AAC frames, so the download stopped",
  aacNoFrames: "No audio frames were found",
  aacDescriptor: "The audio descriptor is larger than expected",
  aacTooLarge: "The recording is over 4 GB and can't be saved as one file",
  tsNotMpegTs: "The video segment isn't MPEG-TS",
  tsNoAudio: "No audio track was found in the video replay",
  tsLatm: "The audio in this video replay can't be extracted yet. Download the video instead.",

  settingsTitle: "X Space Downloader · Settings",
  optFolder: "Subfolder",
  optFolderHint: "Relative to the browser's Downloads folder. Leave empty to save directly there.",
  optTemplate: "File name template",
  optTemplateHint: "Available: {date} {time} {handle} {name} {title} {id}",
  optPreview: "Example: $1",
  optVideoFormat: "Video format",
  optVideoMp4: "MP4 (recommended, opens in system players)",
  optVideoTs: "MPEG-TS (original segments, no conversion)",
  optConcurrency: "Maximum parallel connections",
  optConcurrencyHint: "0 adjusts automatically for your device and network.",
  optMetadata: "Write title, host, date and cover art into audio files",
  optSpeakers: "Also save a speaker timeline (.speakers.json) showing who talked when",
  optShowPanel: "Show the download panel on Space pages",
  optSaved: "Saved",
};

const DICTS = { zh, en };

function detect() {
  const language = String(globalThis.navigator?.language || "zh-CN").toLowerCase();
  return language.startsWith("zh") ? "zh" : "en";
}

export const LANG = detect();

export function t(key, ...subs) {
  let text = DICTS[LANG][key] ?? zh[key] ?? key;
  subs.forEach((value, index) => {
    text = text.replaceAll(`$${index + 1}`, String(value ?? ""));
  });
  return text;
}

export function apiLanguage() {
  return LANG === "zh" ? "zh-cn" : "en";
}

export function messageKeys(lang) {
  return Object.keys(DICTS[lang] || {});
}

export function applyI18n(root) {
  if (root.documentElement) root.documentElement.lang = LANG === "zh" ? "zh-CN" : "en";
  for (const element of root.querySelectorAll("[data-i18n]")) element.textContent = t(element.dataset.i18n);
  for (const element of root.querySelectorAll("[data-i18n-label]")) {
    element.setAttribute("aria-label", t(element.dataset.i18nLabel));
  }
}
