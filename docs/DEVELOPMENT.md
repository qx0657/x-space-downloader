# 开发与发布指南

## 环境要求

- **Node.js 22+**：测试与脚本依赖 Node 内置测试运行器（`node:test`）、全局 `fetch` 与 Web Crypto API。
- **Chrome 116+**：`manifest.json` 要求最低版本 `116`（使用 `chrome.runtime.getContexts`、`chrome.offscreen`、OPFS 等特性）。
- **可选命令行工具**：
  - `ffprobe`（随 `ffmpeg` 安装）：若本机已安装，单测与在线测试会自动调用 `ffprobe` 校验生成的 `.m4a` / `.mp4` 容器流信息与元数据标签；未安装时相关校验自动跳过。
  - `zip`：执行 `npm run package` 打包发布压缩包时使用。

## 安装依赖与本地加载

```bash
npm install
```

本扩展采用原生 ES Module 编写，第三方浏览器端依赖已预置在 `src/vendor/` 中，无需构建步骤即可直接加载运行：

1. 打开 `chrome://extensions`，启用右上角“开发者模式”。
2. 点击“加载已解压的扩展程序”，选择本仓库根目录。
3. 修改 `src/` 下的代码后，在 `chrome://extensions` 卡片上点击刷新按钮即可生效（内容脚本修改后需同时刷新已打开的 `x.com` 页面）。

## 目录结构

```text
.
├── .github/workflows/ci.yml   # GitHub Actions：执行 lint、格式检查、单测与打包
├── _locales/                  # 供 Chrome Web Store 和 manifest 读取的扩展名与简介多语言文件
│   ├── en/messages.json
│   └── zh_CN/messages.json
├── docs/                      # 架构、开发与隐私说明文档
├── icons/                     # 16 / 48 / 128 扩展图标
├── manifest.json              # Chrome MV3 扩展清单
├── scripts/
│   ├── package.mjs            # 校验版本号并生成 dist/*.zip 发布包
│   └── vendor.mjs             # 将 node_modules 中的 mux.js 浏览器包同步至 src/vendor/
├── src/
│   ├── background.js          # MV3 Service Worker：X 会话、状态管理、DNR 规则、downloads 落盘
│   ├── content.js             # 内容脚本入口加载器（动态 import panel.js）
│   ├── content/panel.js       # Space 页面右下角 Shadow DOM 悬浮面板
│   ├── offscreen.html         # 离屏文档页面（引入 mux-mp4.min.js 与 offscreen.js）
│   ├── offscreen.js           # 离屏下载执行器：OPFS 管理、HLS 下载、重封装、创建 blob URL
│   ├── options.html / .css / .js  # 扩展设置页面
│   ├── popup.html / .css / .js    # 工具栏弹窗界面
│   ├── ui/view.js             # 弹窗与悬浮面板共享的状态渲染逻辑
│   ├── vendor/                # 预拷贝的 mux-mp4.min.js 及其许可证
│   └── lib/                   # 纯逻辑与平台封装模块（x-api、hls、m4a、ts-audio、remux、store 等）
└── test/
    ├── helpers.mjs            # 合成 ID3/ADTS、MPEG-TS、AES-128 样本与 mockFetch 工具
    ├── unit.test.mjs          # 离线单元测试
    └── live.test.mjs          # 连接真实 X 接口与 CDN 的端到端集成测试
```

## 常用命令

- **离线单元测试**：

  ```bash
  npm test
  ```

  运行 `test/unit.test.mjs`（此时 `test/live.test.mjs` 因未设置 `LIVE=1` 会自动跳过）。测试完全离线运行，通过 `test/helpers.mjs` 构造合成的 ID3+ADTS AAC 分片、含 PAT/PMT/PES 的 MPEG-TS 分片与 AES-128 加密流，并使用 `mockFetch` 模拟播放列表、断点续传、过期重签刷新及错误重试；若环境装有 `ffprobe`，还会对产出的 `.m4a` 做容器与标签探测。

- **真实网络集成测试**：

  ```bash
  npm run test:live
  ```

  以 `LIVE=1` 运行测试套件，实际请求 X 访客接口与 CDN，分别测试真实纯音频 Space 分片封装、视频 Space 抽取音轨以及通过 `mux.js` 重封装为 MP4（需要当前网络可正常访问 `x.com` 与 `pscp.tv`）。

- **代码静态检查与格式化**：

  ```bash
  npm run lint          # 运行 ESLint 检查 src/、test/、scripts/
  npm run format        # 使用 Prettier 自动格式化仓库文件
  npm run format:check  # 检查格式是否符合 Prettier 规范
  ```

- **更新第三方浏览器包**：

  ```bash
  npm run vendor
  ```

  升级 `package.json` 中的 `mux.js` 版本并安装后运行该命令，将 `node_modules/mux.js/dist/mux-mp4.min.js` 与 `LICENSE` 同步到 `src/vendor/`。

- **打包发布产物**：
  ```bash
  npm run package
  ```
  检查 `package.json` 与 `manifest.json` 的 `version` 字段是否严格一致（不一致则报错退出），随后将 `manifest.json`、`_locales`、`icons`、`src` 打包至 `dist/x-space-downloader-<version>.zip`。

GitHub Actions 工作流（`.github/workflows/ci.yml`）会在每次 `push` 和 `pull_request` 时自动安装 Node 22、`ffmpeg` 与 `zip`，依次执行 `npm ci`、`npm run lint`、`npm run format:check`、`npm test` 和 `npm run package`，并上传打包产物构件。

## 多语言（i18n）机制说明

- **为什么不全局使用 `chrome.i18n`**：Chrome MV3 的 Offscreen Document 上下文仅暴露 `chrome.runtime`，无法调用 `chrome.i18n.getMessage`。为保证后台、离屏文档、弹窗、设置页和内容脚本共用同一套错误提示与界面文案，运行时所有文案统一维护在 `src/lib/i18n.js` 的 `zh` 与 `en` 词典中，各上下文根据 `navigator.language`（`zh` 开头使用中文，其余使用英文）自动选择语言。HTML 静态节点通过 `data-i18n` 和 `data-i18n-label` 属性由 `applyI18n(document)` 注入文本。
- **`_locales/` 的作用**：`_locales/zh_CN/messages.json` 与 `_locales/en/messages.json` 仅提供 `manifest.json` 引用的三个清单字段（`extName`、`extDescription`、`actionTitle`），供浏览器扩展管理页和 Chrome Web Store 展示。
- **词典一致性校验**：新增或删除文案键时必须同时更新 `src/lib/i18n.js` 中的 `zh` 和 `en` 对象，`test/unit.test.mjs` 中的单元测试会自动断言两份词典的键集合完全一致。

## 发布检查清单

1. 同步修改 `package.json` 与 `manifest.json` 中的 `version` 版本号，确保完全一致。
2. 在 `CHANGELOG.md` 中补充新版本的变更记录与发布日期。
3. 若升级了 `mux.js`，执行 `npm run vendor` 并确认 `src/vendor/` 变更已纳入提交。
4. 依次运行以下检查并确保全部通过：
   ```bash
   npm run lint
   npm run format:check
   npm test
   npm run test:live
   ```
5. 执行 `npm run package` 生成 `dist/x-space-downloader-<version>.zip`，在本地 Chrome 中实测解析、音频/视频下载、面板交互与设置保存正常。
6. 将生成的 `.zip` 包上传至 Chrome Web Store 开发者控制台提交审核。

## 调试技巧

- **查看后台与离屏文档日志**：打开 `chrome://extensions`，在扩展卡片的“检查视图”（Inspect views）处点击 `service worker` 打开后台 DevTools；下载进行期间（Offscreen 尚未自动关闭时），同一位置还会出现 `offscreen.html` 链接，点击即可检查 HLS 下载、重封装过程与网络请求。
- **检查会话状态（`job` / `guest` / `media`）**：在 `service worker` 的 DevTools Console 中执行：
  ```js
  await chrome.storage.session.get(["job", "guest", "media"]);
  ```
- **检查 OPFS 暂存分片**：在 `offscreen.html`、弹窗或设置页的 DevTools Console 中，可通过 File System Access 接口枚举当前暂存目录：
  ```js
  const root = await navigator.storage.getDirectory();
  const runs = await root.getDirectoryHandle("runs");
  for await (const [name, handle] of runs.entries()) {
    console.log(name, handle.kind);
  }
  ```
