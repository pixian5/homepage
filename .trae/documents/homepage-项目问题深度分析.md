# homepage 项目问题深度分析报告

> 任务范围：**仅深度分析项目问题，不修改代码**。项目定位为多浏览器新标签页扩展 demo。
> 分析覆盖：构建系统、架构、JS 代码质量、HTML/CSS/资源、安全、性能、可维护性。

---

## 一、项目概览

| 项目 | 说明 |
|---|---|
| 类型 | 浏览器扩展（新标签页 + 工具栏 popup） |
| 三端 | Chrome MV3 / Firefox MV2 / Safari MV3 |
| 当前版本 | 13.7（`package.json:3`，三端 manifest 一致 ✅） |
| 主入口 | `src/newtab.html` + `src/js/app.js`（4024 行，"上帝模块"） |
| popup 入口 | `src/popup.html` + `src/popup.js` |
| 依赖 | 无 `dependencies` / `devDependencies`，仅用 Node 内置模块构建 |
| 测试 / Lint / CI | 全部缺失（无 `.eslintrc`、`tsconfig`、`jest.config`、`.github/workflows/`） |

模块依赖关系：
```
app.js ──┬──> storage.js
         ├──> icons.js ──> storage.js
         └──> bing-wallpaper.js ──> storage.js

popup.js ──> storage.js

孤立模块（无任何运行时引用）:
  constants.js / dom-utils.js / shared.js / toast.js / tooltip.js
  （仅彼此互相 import，且与 app.js 内实现重复）
```

---

## 二、架构问题

### 2.1 [P0] Safari 真正构建入口位于 git 忽略目录

**问题**：Safari 宿主 App 的真正构建入口 `dist/build-macos.command`（包含 `xcodebuild`、Apple Development 证书二次签名、`pkill`+`open` 启动 App 等关键逻辑）位于 `dist/`，而 `.gitignore:1-2` 把整个 `dist/` 忽略。

**后果**：
- 全新 `git clone` 后**无法构建 Safari**，因为脚本不存在。
- `README.md:402,450` 和 `Safari说明.md:17,80,101` 引用的入口脚本不在版本控制中。
- `scripts/build.sh` 的 `build_safari_project` 只生成 Xcode 工程，**不调用 `xcodebuild`**；编译/签名/启动逻辑全在 git 之外。
- `SAFARI_XCODE_CONFIGURATION` 环境变量只在 `dist/build-macos.command:11` 读取，`build.sh` 中无任何引用。

**位置**：
- `/Users/x/code/homepage/.gitignore:1-2`
- `/Users/x/code/homepage/dist/build-macos.command`（git 忽略）
- `/Users/x/code/homepage/scripts/build.sh:166-219`（只建工程，不编译）
- `/Users/x/code/homepage/README.md:402,450`

### 2.2 [P0] Firefox Bundle / CSP Hash 机制：文档与实现严重不符

**文档声明**（`AGENTS.md:24-30`、`README.md:426-431`）：
- Firefox 版用 `scripts/bundle-firefox.mjs` 生成**内联脚本**
- 构建时必须用 **LF 归一化** 计算 Hash 并写入 `dist/firefox/manifest.json`
- 产物以 `dist/firefox` 为准

**实际实现**（`scripts/bundle-firefox.mjs` 全文）：
1. **不是内联脚本**：产物是外部文件 `dist/firefox/js/app.ff.js`（`bundle-firefox.mjs:7-8,41`），HTML 通过 `<script src="js/app.ff.js">` 引用（`:46`）。
2. **完全没有计算 SHA-256 Hash**：脚本中无 `crypto` / `sha` / `hash` 关键字。
3. **完全没有修改 `manifest.json` 的 CSP**：CSP 是 `manifest.firefox.json:35` 硬编码字符串 `"script-src 'self'; object-src 'self'; img-src 'self' data: https: http:;"`，无 `'sha256-...'` 注入。
4. **无 LF 归一化**：`bundle-firefox.mjs:33` 只去 BOM（`code.replace(/^\uFEFF/, "")`），没有 `\r\n -> \n`。

**后果**：当前实际方案是**外部脚本 + `'self'` CSP**（Firefox MV2 下可工作），但与文档描述完全脱节，任何按文档假设维护的人都会被坑。

### 2.3 [P1] 三端 Manifest 80% 重复，手工同步

三个 manifest 文件约 80% 内容重复：

| 字段 | Chrome | Firefox | Safari |
|---|---|---|---|
| `manifest_version` | 3 | 2 | 3 |
| 工具栏入口 | `action` | `browser_action` | `action` |
| 权限 | `permissions` + `host_permissions` 分离 | 全塞 `permissions`（MV2 写法） | 同 Chrome 但**少 `history`** |
| CSP | 对象形式 `{ extension_pages }` | 字符串 | 对象形式 |
| `web_accessible_resources` | 无 | `["js/*.js"]` | 无 |
| `browser_specific_settings.gecko.id` | 无 | 有 | 无 |

**风险**：任何新增权限/字段需在 3 个文件手工同步，极易遗漏。Safari 故意去掉 `history`（`README.md:454` 有说明），但缺乏注释。

### 2.4 [P1] 5 个孤立模块（死代码）与 app.js 重复实现并存

通过 Grep 验证 import 关系，以下 5 个模块**完全没有被任何运行时代码 import**，但被 `rsync` 复制到 `dist/{chrome,firefox,safari}/js/`：

| 孤立模块 | 与 app.js 重复的内容 |
|---|---|
| `src/js/constants.js` | 20+ 个常量（`RECENT_GROUP_ID`、`TOAST_DURATION_MS`、`densityMap`、`bgOverlayMap`、`MIN_TILE_SIZE` 等），app.js:108-150 又定义一遍 |
| `src/js/dom-utils.js` | `$`/`qs`/`qqa`/`normalizeUrl`/`safeSetText`/`safeSetAttr`/`createFormSection`，app.js:16-18, 2164-2192 又实现一遍 |
| `src/js/shared.js` | `getChrome`/`storageArea`/`getLastError`/`estimateBytes`/`sanitizeForSync`，storage.js 内部又实现一遍 |
| `src/js/toast.js` | `toast` 函数，app.js:945 又实现一遍（行为还不一致：app 版本不检查 toastContainer 是否存在） |
| `src/js/tooltip.js` | `showTooltip`/`hideTooltip`/`clearTooltipTimer`，app.js:992-1002 又实现一遍（且丢了 `clearTooltipTimer` 清理逻辑） |

**位置**：
- `/Users/x/code/homepage/src/js/constants.js:7-46`
- `/Users/x/code/homepage/src/js/dom-utils.js:11-62`
- `/Users/x/code/homepage/src/js/shared.js:15-116`
- `/Users/x/code/homepage/src/js/toast.js:25`
- `/Users/x/code/homepage/src/js/tooltip.js:39-53`
- 重复方：`/Users/x/code/homepage/src/js/app.js:16-18, 108-150, 945, 992-1002, 2164-2192, 3248-3255`

**后果**：维护负担倍增；bug 修一处忘另一处；孤立模块中的清理逻辑（`clearTooltipTimer`）在 app.js 中缺失。

### 2.5 [P1] `scripts/build.mjs` 死代码 + npm 脚本完全相同

- `package.json:8` 的 `build` 调用 `bash scripts/build.sh`，从不引用 `scripts/build.mjs`。`build.mjs` 只支持单浏览器，功能远不如 `build.sh`，是死代码。
- `package.json:9-11` 的 `build:chrome` / `build:firefox` / `build:safari` **三个脚本完全相同**（都是 `bash scripts/build.sh`），没有传递目标参数的能力，形同虚设。

### 2.6 [P2] Windows 构建路径与 macOS 路径完全分裂

- `build.cmd`（项目根）+ `scripts/bundle-firefox.ps1` + `scripts/strip-bom.ps1` + `scripts/zip-normalized.ps1` 实现 Windows 构建。
- `scripts/build.sh` + `scripts/bundle-firefox.mjs` 实现 macOS 构建。
- 两套路径逻辑不对齐（Windows 不构建 Safari 是合理的，但也没在 `package.json` 暴露任何 Windows 入口）。
- Windows 路径不调用 `bump-version.mjs`，版本号管理不一致。

### 2.7 [P2] `prebuild` 钩子语义不一致

- `prebuild` 只在 `npm run build` 时触发。
- `dist/build-macos.command:55` 显式调用 `bump-version.mjs` 绕过。
- 但直接 `bash scripts/build.sh` 不会 bump 版本。
- 三个入口（npm / build-macos.command / 直接 bash）语义不一致。

### 2.8 [P2] Safari Xcode 工程从不彻底清理

- `build.sh:221` 清理 zip 时未清理 `safari-app`。
- `build.sh:199` 的 `rm -rf "$SAFARI_PROJECT_DIR"` 只在新建路径执行，复用路径不清理。
- 旧 Xcode 工程在 `--rebuildProject` 路径下复用，可能残留陈旧资源。

---

## 三、安全问题（最严重）

### 3.1 [P0] 多处 XSS 漏洞：用户可控数据直接插入 HTML

项目里有 `dom-utils.js#safeSetText`/`safeSetAttr` 可用，但 **app.js 完全没用它们**，所有动态 HTML 都通过模板字符串拼接。

| 位置 | 代码 | 风险 |
|---|---|---|
| `app.js:2413` | `<input id="fieldTitle" value="${node.title}">` | `node.title` 含 `" onmouseover="alert(1)` 即 XSS |
| `app.js:2418` | `<input id="fieldUrl" value="${node.url}">` | 同上 |
| `app.js:2988` | `<textarea readonly>${payload}</textarea>` | payload 含 `</textarea><script>...` 逃逸 |
| `app.js:3108` | `<option value="${g.id}">${g.name}</option>` | 分组名/ID 注入 |
| `app.js:3200` | `<div data-backup="${b.id}">` | backup.id 注入属性 |
| `app.js:3442` | `openAddHistoryToGroup` 同样模式 | 同上 |
| `app.js:1054` | `style.backgroundImage = url('${style}')` | style 含 `'` 逃逸 CSS 上下文 |

**攻击面**：
- `openImportModal` 允许任意 JSON 导入 → 数据中的 `title`/`url` 直接进 HTML。
- `openImportUrlModal` 从 URL 拉取 JSON → 同上。
- 备份恢复 `openBackupModal` → 同上。

**建议**：所有动态 HTML 改用 `document.createElement` + `textContent`/`setAttribute`；或实现 `escapeHtml`/`escapeAttr` 工具函数并在所有模板处使用；CSS url 用 `CSS.escape` 或协议白名单。

### 3.2 [P2] 调试 API 暴露到 window

- `app.js:878` `window.homepageDebugLog = () => {...}`
- `app.js:887` `window.homepageDebugEnv = async () => {...}`

生产环境暴露调试接口，可能泄露运行时信息（runtimeId、存储字节量）。建议用 `if (DEBUG)` 包裹或仅在开发构建中暴露。

---

## 四、代码质量问题

### 4.1 [P1] `bing-wallpaper.js` Promise/错误处理缺陷

**`bing-wallpaper.js:14-20`** `blobToDataUrl`：
```js
function blobToDataUrl(blob) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.readAsDataURL(blob);
  });
}
```
- 无 `reader.onerror`，FileReader 失败时 Promise **永远 pending**，上游 `getBingWallpaper` 卡死。
- `onloadend` 中未检查 `reader.error`。

**`bing-wallpaper.js:40-46`** fetch 链：
- 无 `res.ok` / `imgRes.ok` 检查，HTTP 4xx/5xx 被当成功。
- 无 `AbortController` 超时，网络挂起无限等待。
- 对 `bing.com` 的 fetch 在扩展环境下需 host_permissions（已声明 `<all_urls>`，OK），但失败会反复刷日志。

### 4.2 [P1] `loadRecentHistory` 重复 API 调用

**`app.js:3385-3388`**：
```js
const result = api.history.search({ text: "", startTime, maxResults: RECENT_LIMIT });
const items = typeof result?.then === "function"
  ? await result
  : await new Promise((resolve) => {
      api.history.search({ ..., maxResults: RECENT_LIMIT }, (res) => resolve(res || []));
    });
```
第一次调用已触发实际查询，callback 分支里又查询一次，**导致重复 API 调用**。应统一为一种调用方式。

### 4.3 [P1] 类型检查缺失

**`app.js:1208`**：
```js
if (err1.startsWith("local_trimmed_")) { ... }
```
`err1` 来自 `saveData`，可能是 `null`/`undefined`/非字符串，会抛 `TypeError`。应 `typeof err1 === "string" && err1.startsWith(...)`。

### 4.4 [P1] `FINAL_URL_CACHE` 无界增长

**`icons.js:47`** `const FINAL_URL_CACHE = new Map();`
模块级 Map，每次 `resolveFinalUrl` 命中后 12 小时复用，但**无清理机制**。长期使用下，每访问一个新 URL 就添加一项，Map 无限增长。建议加 LRU 上限（如 200 项）。

### 4.5 [P2] `pendingDeletion` setTimeout 未清理

**`app.js:2145`**：连续多次删除时，前一次 setTimeout 还在排队，后一次删除覆盖 `pendingDeletion`，但旧 timer 仍会触发并把新的 `pendingDeletion` 误清空。应保存 timer id 并 `clearTimeout`。

### 4.6 [P2] `chrome.tabs.query` 未检查 lastError

**`app.js:2312`**：未检查 `chrome.runtime.lastError`，标签权限被收回时静默失败，用户无反馈。

### 4.7 [P2] `fetchTitleViaTab` 标签泄漏隐患

**`app.js:3364`**：`api.tabs.onUpdated` 监听器添加失败（同步异常）时 tab 会泄漏。应包 try/catch。

### 4.8 [P3] `error-bootstrap.js` / `content-toast.js` 顶层副作用

- `error-bootstrap.js:24-35`：非 ES Module，通过 `<script>` 直接加载。若被多次打包/引入会重复绑定 `error`/`unhandledrejection` 监听。
- `content-toast.js:36-44`：文件顶层直接执行 `api.runtime.onMessage.addListener`，content script 在 SPA 路由切换时可能重复注入，造成 toast 重复显示。

### 4.9 [P3] `migrateData` 空壳

**`storage.js:268-272`**：有迁移框架但无实际逻辑，`schemaVersion` 固定为 1。未来升级时容易遗漏。

### 4.10 [P3] 原地排序副作用

**`app.js:1278, 2089, 2097`**：`data.groups.sort(...)` 是原地操作，本应只读的函数实际改变了 `data.groups` 顺序，破坏数据不可变性预期。

---

## 五、性能问题

### 5.1 [P1] resize / mousemove 未防抖，layout thrashing

- **`app.js:3653`** `window.addEventListener("resize", () => render())` — resize 高频触发，每次重建整个 grid。应加 debounce/rAF。
- **`app.js:3852`** `document.addEventListener("mousemove", handleBoxSelectMove)` — `handleBoxSelectMove` 内调 `updateSelectionBox`（改 4 个 style）+ `selectTilesInBox`（遍历所有 tile 调 `getBoundingClientRect`），每次 mousemove **强制同步布局**。
- **`app.js:3859`** tooltip mousemove 改 `left`/`top` 触发重排，应用 `transform: translate3d(...)` 或 rAF 节流。同样问题在 `tooltip.js:42-43, 83-84`、`app.js:995-996`。

### 5.2 [P1] 频繁 `JSON.parse(JSON.stringify(...))` 深克隆

位置：`app.js:1109, 2133, 2322, 2479, 2841, 3213`、`storage.js:117, 379, 401`。

每次添加/编辑/删除节点都深克隆整个 `data`（含所有 nodes、groups、backups）。节点数百+时明显卡顿。可用 `structuredClone`（现代浏览器支持）或增量快照。

### 5.3 [P1] `persistData` 单次最多 4 次 storage.set

**`app.js:1206-1219`**：
```js
const err1 = await saveData(data, useSync);
if (useSync) await saveData(data, false);        // 第 2 次
if (changed) {
  const err2 = await saveData(data, useSync);    // 第 3 次
  if (useSync) await saveData(data, false);      // 第 4 次
}
```
`changed` 是 `dedupeData(data)` 的返回值，dedupe 改了数据后应只写一次。

### 5.4 [P1] 表单字段即时保存

**`app.js:2959-2963`**：
```js
qsa("input, select, textarea", elements.modal).forEach((el) => {
  el.addEventListener(eventName, () => scheduleSettingsSave(true));  // immediate=true
});
```
`immediate=true` 会立即调 `saveSettings`（含 persistData、深克隆备份），即每次输入字符都触发一次完整保存。应改 `false` 走 120ms 节流。

### 5.5 [P1] `refreshAllIcons` 并发刷新数百次 fetch

**`icons.js:363-381`**：对所有节点调 `resolveFinalUrl`（fetch 原始 URL 跟随重定向），每个节点 1 次网络请求。即使 12 小时缓存，首次刷新代价巨大。

### 5.6 [P2] `grid.innerHTML = ""` 清空

位置：`app.js:1271, 1339, 1827, 1863, 2270, 2443, 2787`。`replaceChildren()` 更明确且更快。

---

## 六、HTML / CSS / 资源问题

### 6.1 [P1] popup 仅 3 种语言翻译，却声明支持 8 种

- `popup.js:13` `SUPPORTED_LANGUAGES` 声明 8 种（zh-CN、zh-TW、en、ja、ko、de、fr、es）。
- `popup.js:15-46` `POPUP_I18N` **只提供 3 种完整翻译**（zh-CN、zh-TW、en）。
- `popup.js:91` `POPUP_I18N[lang] || POPUP_I18N.en` — ja/ko/de/fr/es 静默回退到 en。
- 声明与实现不一致，误导用户。

### 6.2 [P1] toast 样式三处硬编码重复

| 位置 | 内容 |
|---|---|
| `popup.js:510-547` | `showToastInTab` 内联整套 toast 样式（`rgba(15,20,28,0.88)`、`#ffffff` 等） |
| `popup.js:566` | MV2 回退分支又写一遍相同字符串 |
| `content-toast.js:11-25` | 第三处重复 |

三处样式需同步维护，极易漂移。

### 6.3 [P1] popup 与主界面样式体系割裂

- `popup.css:1-7` 定义**独立一套 `:root` 变量**（`--bg`/`--panel`/`--text`/`--muted`/`--accent`），与 `styles.css` 部分重名但取值不同。
- popup 固定深色背景，**完全不支持 light/dark 主题切换**。
- `popup.css:24,54` 硬编码 `#ffffff`；`popup.css:27,38,58,66` 大量 `rgba(...)` 硬编码。

### 6.4 [P2] system 主题不监听实时变化

**`app.js:909-919`** `applyTheme` 支持 `system`/`light`/`dark`，`system` 模式用 `matchMedia("(prefers-color-scheme: dark)")`。但**没有 `addEventListener('change', ...)`**，系统主题切换后不会实时响应（需重开新标签页）。

### 6.5 [P2] host_permissions 未最小化

三个 manifest 都同时声明 `<all_urls>` **和** `https://www.bing.com/*`、`https://www.google.com/*`。后两者**完全被 `<all_urls>` 包含**，冗余声明，应删除以减小权限范围感知。
- `manifest.chrome.json:20-24`
- `manifest.firefox.json:13-21`
- `manifest.safari.json:19-23`

### 6.6 [P2] a11y 缺陷

- `newtab.html:20-24` 顶部按钮（`btnAdd`/`btnBatchDelete` 等）只有 `data-tooltip`，**没有 `aria-label`**。
- `newtab.html:16` `<input id="topSearch">` **没有关联 `<label>`**，仅靠 placeholder。
- `newtab.html:31` "历史"按钮实际充当 tab 切换，未用 `role="tab"` / `aria-selected`，分组栏缺 `role="tablist"`。
- `popup.html:18` `<label class="label">保存到分组</label>` **没有 `for` 属性**，未与 `<select id="groupSelect">` 关联。

### 6.7 [P2] popup.html body 初始 hidden，JS 失败则永久空白

**`popup.html:9`** `<body class="hidden">`，依赖 `popup.js:609` 初始化完成后移除 `hidden`。若 JS 加载失败，**popup 永久空白**，且 `popup.js:628-636` 的 catch 仅在 JS 执行后才生效。

### 6.8 [P2] 未使用浏览器原生 `_locales/` + `chrome.i18n`

全部自定义 JS 字典，无法被 Web Store 自动识别语言。HTML 初始文本硬编码中文（`newtab.html:6,17,20-24`、`popup.html:6`），JS 失败时非中文用户看到中文。

### 6.9 [P3] 大量硬编码中文未走 i18n

`app.js:2236-2263, 2972-3237` 中 `openImportModal`/`openBackupModal`/`openManualExportModal` 等函数的 placeholder、"导出设置"、"导入设置"等硬编码中文，未走 `t()` i18n 体系。

### 6.10 [P3] CSS 重复声明

- `styles.css:472-473` `.modal .row-actions` 重复定义两次相同规则（笔误）。
- `styles.css:364-368` `.overlay-grid` 重复声明，应合并。

### 6.11 [P3] Bing API `mkt=en-US` 硬编码

**`bing-wallpaper.js:3`** `BING_API` 固定 `mkt=en-US`，不会根据 `data.settings.language` 切换区域，中文用户拿到的壁纸描述可能不符。

### 6.12 [P3] 三个 manifest 都没有 background/service_worker

扩展**没有后台脚本**，所有逻辑都在新标签页和 popup 内。对当前功能够用，但限制未来扩展能力（快捷键、定时任务、alarms API）。

---

## 七、文档与资源问题

### 7.1 [P2] 两个"参考同步方式.md"内容重叠

| 文档 | 行数 | 主题 |
|---|---|---|
| `参考同步方式.md` | 189 | 在线同步方案（op log + HLC + tombstone + LWW） |
| `参考同步方式2.md` | 106 | 备份合并方案（操作日志重放 + tombstone） |

核心概念（操作日志、tombstone、LWW、时间排序重放）**大量重复**，仅场景不同。两者都是**未落地的设计讨论**，与实际代码（`storage.js` 用 `lastUpdated` 时间戳 + LWW，未实现 op log）不完全一致。建议合并为一份"同步与合并设计参考"或移入 `docs/` 子目录。

### 7.2 [P3] `参考配置.txt` 用途不明

嵌套极深的备份数据 JSON 样本（多层 `backups` 嵌套），疑似测试数据，非文档。建议确认用途或移入测试目录。

### 7.3 [P3] `.vscode/settings.json` 与项目无关

```json
{ "chatgpt.openOnStartup": true }
```
仅一行，让 VS Code 的 ChatGPT 扩展启动时自动打开，属于个人开发环境配置，不应纳入版本控制。

---

## 八、问题优先级汇总

### P0（严重，必须立即处理）

| # | 问题 | 位置 |
|---|---|---|
| 1 | Safari 真正构建入口 `dist/build-macos.command` 在 git 忽略目录 | `.gitignore:1-2` + `dist/build-macos.command` |
| 2 | Firefox Bundle/CSP Hash 机制文档与实现严重不符 | `AGENTS.md:24-30` vs `bundle-firefox.mjs` 全文 |
| 3 | 多处 XSS：node.title/node.url/JSON payload/分组名直接插入 HTML | `app.js:2413,2418,2988,3108,3200,3442,1054` |

### P1（高，应尽快处理）

| # | 问题 | 位置 |
|---|---|---|
| 4 | 三端 Manifest 80% 重复，手工同步 | `manifest.{chrome,firefox,safari}.json` |
| 5 | 5 个孤立模块（constants/dom-utils/shared/toast/tooltip）与 app.js 重复实现 | `src/js/*.js` + `app.js` 多处 |
| 6 | `bing-wallpaper.js` Promise 无 onerror、fetch 无 res.ok 检查/超时 | `bing-wallpaper.js:14-20,40-46` |
| 7 | `FINAL_URL_CACHE` Map 无界增长 | `icons.js:47` |
| 8 | `loadRecentHistory` 重复 API 调用 | `app.js:3385-3388` |
| 9 | `err1.startsWith` 未做类型检查 | `app.js:1208` |
| 10 | resize/mousemove 未防抖，layout thrashing | `app.js:3653,3852,3859` |
| 11 | 频繁 `JSON.parse(JSON.stringify)` 深克隆 | `app.js` 6 处 + `storage.js` 3 处 |
| 12 | `persistData` 单次最多 4 次 storage.set | `app.js:1206-1219` |
| 13 | 表单字段即时保存（每次输入字符触发完整保存） | `app.js:2959-2963` |
| 14 | `refreshAllIcons` 并发刷新数百次 fetch | `icons.js:363-381` |
| 15 | popup 仅 3 种语言翻译，却声明 8 种 | `popup.js:13,15-46` |
| 16 | toast 样式三处硬编码重复 | `popup.js:510-547,566` + `content-toast.js:11-25` |
| 17 | popup 与主界面样式体系割裂 | `popup.css:1-7` |

### P2（中，应规划处理）

| # | 问题 | 位置 |
|---|---|---|
| 18 | `scripts/build.mjs` 死代码 + `build:chrome/firefox/safari` 三脚本相同 | `package.json:8-11` + `scripts/build.mjs` |
| 19 | Windows/macOS 构建路径分裂 | `build.cmd` + `.ps1` vs `build.sh` + `.mjs` |
| 20 | `prebuild` 钩子语义不一致 | `package.json` vs `build-macos.command:55` vs `build.sh` |
| 21 | Safari Xcode 工程从不彻底清理 | `build.sh:199,221` |
| 22 | 调试 API 暴露到 window | `app.js:878,887` |
| 23 | `pendingDeletion` setTimeout 未清理 | `app.js:2145` |
| 24 | `chrome.tabs.query` 未检查 lastError | `app.js:2312` |
| 25 | `fetchTitleViaTab` 标签泄漏隐患 | `app.js:3364` |
| 26 | system 主题不监听实时变化 | `app.js:909-919` |
| 27 | host_permissions 未最小化（bing/google 被 `<all_urls>` 冗余包含） | 三个 manifest |
| 28 | a11y 缺陷（按钮无 aria-label、input 无 label、tab 角色缺失） | `newtab.html:16-31` + `popup.html:18` |
| 29 | popup.html body 初始 hidden，JS 失败永久空白 | `popup.html:9` |
| 30 | 未使用浏览器原生 `_locales/` + `chrome.i18n` | 全局 |
| 31 | 两份"参考同步方式.md"内容重叠 | `参考同步方式.md` + `参考同步方式2.md` |

### P3（低，可选处理）

| # | 问题 | 位置 |
|---|---|---|
| 32 | `error-bootstrap.js`/`content-toast.js` 顶层副作用可能重复绑定 | `error-bootstrap.js:24-35` + `content-toast.js:36-44` |
| 33 | `migrateData` 空壳 | `storage.js:268-272` |
| 34 | 原地排序副作用 | `app.js:1278,2089,2097` |
| 35 | 大量硬编码中文未走 i18n | `app.js:2236-2263,2972-3237` |
| 36 | Bing API `mkt=en-US` 硬编码 | `bing-wallpaper.js:3` |
| 37 | CSS 重复声明 | `styles.css:364-368,472-473` |
| 38 | 三个 manifest 都没有 background/service_worker | 三个 manifest |
| 39 | `参考配置.txt` 用途不明 | 项目根 |
| 40 | `.vscode/settings.json` 与项目无关 | `.vscode/settings.json` |
| 41 | `grid.innerHTML = ""` 应改 `replaceChildren()` | `app.js` 7 处 |
| 42 | 缺少测试 / Lint / CI | 全局 |

---

## 九、改进方向建议（仅供参考，本次不实施）

按收益/成本排序：

1. **修复 XSS（P0）**：实现 `escapeHtml`/`escapeAttr` 工具函数，所有动态 HTML 拼接处使用；或改用 `createElement` + `textContent`。CSS url 用 `CSS.escape`。
2. **对齐 Firefox 文档与实现（P0）**：要么按 AGENTS.md 实现真正的内联 + LF 归一化 + SHA-256 Hash 注入 CSP；要么修改文档描述为"外部脚本 + `'self'` CSP"。
3. **把 `dist/build-macos.command` 移入 `scripts/`（P0）**：纳入版本控制，让全新 clone 可复现 Safari 构建。
4. **清理 5 个孤立模块（P1）**：决定保留 app.js 内联实现还是孤立模块实现，删除另一方。推荐删除孤立模块（app.js 是运行时实际用的）。
5. **抽离 manifest 公共模板（P1）**：用构建脚本从模板生成三端 manifest，消除手工同步。
6. **性能优化（P1）**：resize/mousemove 加 rAF 节流；深克隆改 `structuredClone`；`persistData` 合并重复写入；表单保存改 `immediate=false`；`FINAL_URL_CACHE` 加 LRU 上限。
7. **`bing-wallpaper.js` 健壮性（P1）**：`blobToDataUrl` 加 `onerror` + `reject`；fetch 加 `AbortController` 超时 + `res.ok` 检查。
8. **popup 主题与 i18n 对齐（P1）**：popup.css 共享主界面 CSS 变量；popup 补齐 ja/ko/de/fr/es 翻译或缩小声明列表。
9. **拆分 app.js（P2）**：4024 行单文件拆为 i18n、storage-orchestrator、renderer、drag-touch、modal、backup、import-export 等模块。
10. **补测试 / Lint / CI（P2）**：至少加 ESLint + 一个 smoke test + GitHub Actions。

---

## 十、总体评价

项目作为 demo **功能完整、设计较成熟**：
- CSS 变量体系健全（主界面）、i18n 字典覆盖广、a11y 用了 `inert`/`aria-live` 等先进特性、README 文档详尽（485 行）、构建链路考虑周全、三端 manifest 版本一致。

主要短板集中在三类：
1. **文档与实现脱节**（Firefox CSP、Safari 构建入口）— 误导维护者。
2. **重复与死代码**（5 个孤立模块、三端 manifest、toast 样式三处）— 维护负担倍增。
3. **安全/性能隐患**（多处 XSS、layout thrashing、深克隆、无界缓存）— 长期使用会暴露。

所有引用的文件路径与行号均基于实际代码，未做任何修改。
