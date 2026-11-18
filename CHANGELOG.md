# 更新日志（Changelog）

本项目的所有显著变更均记录在此文件中。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [1.1.0] - 2026-11-17

### 新增

- `.m4a` 音频文件内嵌元数据与封面图支持（写入标题、主持人名称、开播日期、Space 链接备注及主持人头像封面）。
- 视频 Space 下载支持通过 `mux.js` 无损重封装为系统播放器可直接播放的 `.mp4`（也可在设置中切换为原始 `.ts`）。
- 新增扩展设置页（`src/options.html`），支持自定义保存子目录、文件名模板、视频格式、最大并发连接数、音频元数据开关与页面面板开关。
- 页面悬浮面板、弹窗与设置页支持浅色主题，页面面板自动跟随 X 网页浅色/深色背景切换。
- 新增中英双语国际化支持（`src/lib/i18n.js` 与 `_locales/`）。
- 完善界面无障碍属性（进度条 `role="progressbar"` 与 `aria-valuenow`、状态消息 `aria-live="polite"`、减少动态效果媒体查询适配）。
- 页面右下角下载面板新增“不再显示”快捷按钮，点击后永久隐藏面板并可在设置中重新启用。
- 下载过程中回放签名地址过期（HTTP 401/403）时自动向后台请求重新解析并无感续下。
- 新增离线单元测试套件（`test/unit.test.mjs`）、真实网络集成测试（`test/live.test.mjs`）、ESLint 配置、Prettier 配置、发布打包脚本（`scripts/package.mjs`）、依赖同步脚本（`scripts/vendor.mjs`）以及 GitHub Actions CI 工作流。

### 变更

- 将 HLS 分片下载与音视频合成流水线从后台 Service Worker 彻底迁移至 Offscreen Document（`src/offscreen.js`），由后台统一负责 `chrome.downloads` 落盘与生命周期回收。
- 分片存储改用源私有文件系统（OPFS，`runs/<spaceId>-<mode>/`），实现跨中断断点续传与磁盘支撑的低内存流式合成。
- 状态同步改为基于 `chrome.storage.onChanged` 与 `chrome.tabs.sendMessage` 推送，取代轮询。
- 页面悬浮面板优先使用 Navigation API（`currententrychange`）检测 X 的 SPA 路由切换。
- X 访客令牌（Guest Token）缓存在 `chrome.storage.session` 中复用（有效期 90 分钟），减少重复激活请求。
- 收敛并统一网络超时、可重试错误判定与自适应并发退避重试逻辑。
- `src/lib/m4a.js` 直接流式统计帧长并一次写出 MP4 采样表与文件头，合成阶段无需在内存中保留整段裸 AAC 数据。

### 修复

- 修复上一场 Space 未清理的暂存文件可能以新 Space 文件名被错误保存的问题：彻底移除旧版共用单槽位的 IndexedDB（并在 `onInstalled` 时清理旧库），所有下载轮次按 `<spaceId>-<mode>` 独立隔离。
- 修复点击取消后延迟到达的完成事件把 `cancelled` 状态重新覆盖为 `done` 的竞态问题：带 `runId` 的状态更新仅在对应轮次仍处于 `downloading` 时生效。

### 移除

- 移除用于中转保存文件的隐藏标签页 `src/save.html` 与 `src/save.js`。
- 移除旧版 IndexedDB 暂存模块 `src/lib/idb-file.js` 及静态规则文件 `rules.json`。

### 安全

- 请求头改写规则改为会话级动态注册（`updateSessionRules`），并通过 `tabIds: [-1]` 严格限制仅对扩展自身后台请求生效，不再影响任何网页向 `x.com` 或 `twimg.com` 发起的 XHR 请求。
- 新增媒体地址域名白名单（仅允许 `pscp.tv`、`twimg.com` 及其子域名）并强制要求 `https:` 协议。
- 后台不再信任消息参数中传入的媒体流地址，仅使用后台自身解析缓存在 `chrome.storage.session` 中的播放列表地址。
- 后台处理 `offscreen-*` 消息时严格校验 `sender.url` 必须来自扩展自身的 `src/offscreen.html`。
- 精简扩展权限：移除 `tabs` 与 `activeTab` 权限，将 `declarativeNetRequest` 替换为 `declarativeNetRequestWithHostAccess`（并新增 `unlimitedStorage` 以支持 OPFS 大体积回放暂存），收敛冗余的 `host_permissions` 条目。

## [1.0.9]

- 初始版本。
