# 我的首页（Chrome / Firefox / Safari 新标签页扩展）

> 本文档基于当前仓库源码（`src/` + `scripts/` + `manifest.*.json`）整理，重点是“实现现状”而不是需求设想。

## 1. 项目定位

这是一个浏览器扩展，用来替换浏览器新标签页，提供可维护的快捷入口面板，支持：

- 新标签页接管（Chrome MV3 / Firefox MV3 / Safari Web Extension）
- 分组与文件夹管理
- 快捷卡片增删改查、拖拽排序
- 最近历史页（读取浏览器历史）
- 图标自动抓取与缓存
- 每日 Bing 背景（含缓存回退）
- 本地存储 + 可选同步存储
- 导入导出、备份与恢复
- Popup 一键保存当前网页到分组

## 2. 功能总览（按已实现代码）

### 2.1 新标签页主界面

- 顶部工具栏：新增、批量删、打开方式切换、设置、搜索。
- 左侧分组栏：历史、分组列表、新增分组、收起按钮。
- 主区域网格：卡片展示 + 拖拽排序。
- 文件夹覆盖层：进入文件夹后可继续增删/批量删/解散。
- 右键菜单：卡片操作、分组操作。
- Toast / Tooltip：操作反馈与悬停提示。

### 2.2 卡片能力

- 支持类型：
  - `item`（普通网址卡片）
  - `folder`（文件夹）
  - `history`（历史页临时卡片，不持久化）
- 打开方式：本页 / 新页 / 后台（通过按钮循环切换）。
- 卡片新增支持：
  - 手工输入 URL
  - 从当前标签页读取 URL + 标题
  - 图标来源：自动、上传、颜色头像、远程 URL
- 编辑支持：标题、URL、图标来源。
- 删除支持：单个、批量；支持撤销（10 秒窗口）。

### 2.3 分组 / 文件夹

- 分组可新增、重命名、删除、拖拽排序。
- 卡片可拖到另一卡片图标上创建文件夹。
- 卡片可拖入现有文件夹图标。
- 文件夹可解散，子项回填原位置。
- 支持文件夹内继续拖拽排序。

### 2.4 历史页

- “历史”分组来自 `chrome.history.search` / `browser.history.search`。
- 最近天数：7 天。
- 最大条目：24。
- 按 URL 去重。
- 历史项支持“添加到快捷”（可选分组）。

### 2.5 搜索

- 顶部输入框即时过滤当前网格中的卡片标题/URL。
- Enter 或搜索按钮会使用当前搜索引擎打开新页面搜索。

### 2.6 设置

已实现设置项：

- 顶部搜索框显示开关
- 搜索引擎预设/自定义
- 固定列数 + 列数
- 网格密度（紧凑/标准/宽松）
- 背景类型（Bing/纯色/渐变/自定义图）
- 背景遮罩强度
- 语言（简体中文/繁體中文/English/日本語/한국어/Deutsch/Français/Español）
- Tooltip、键盘导航
- 主题（system/light/dark）
- 字体大小
- 默认保存分组（上次分组/固定分组）
- 侧边栏隐藏
- 同步开关
- 最大备份数量
- 图标失败重试时间点（0~23 点或关闭）

## 3. 架构与模块

## 3.1 运行时结构

- 新标签页入口：`src/newtab.html` -> `src/js/app.js`
- Popup 入口：`src/popup.html` -> `src/popup.js`
- 内容提示脚本：`src/js/content-toast.js`

## 3.2 核心模块

- `src/js/app.js`
  - 主应用状态、渲染、交互、设置、导入导出、备份、拖拽、历史。
- `src/js/storage.js`
  - 存储读写封装、本地/同步切换、配额处理、默认数据、备份快照、数据迁移。
- `src/js/icons.js`
  - favicon 候选策略、图标缓存、头像生成、失败重试。
- `src/js/bing-wallpaper.js`
  - Bing API 拉取、背景缓存、失败回退。
- `src/popup.js`
  - 当前标签页保存逻辑、保存后 toast 注入。
- `src/js/content-toast.js`
  - 普通网页中接收消息并显示 toast。
- `src/js/error-bootstrap.js`
  - 新标签页 JS 加载失败时的兜底错误提示（内联于 HTML 头部）。

## 3.3 构建模块

- `scripts/build.sh`
  - 复制 `src` 到 `dist/chrome`、`dist/firefox`、`dist/safari`，写入对应 manifest，打包 zip/xpi；
  - 在 macOS 上调用 `safari-web-extension-converter` 生成 `dist/safari-app` 宿主工程。
- `scripts/bundle-firefox.mjs`
  - 将 Firefox 的 `app.js` 等多个 ESM 模块合并为单一外部脚本 `dist/firefox/js/app.ff.js`；
  - 替换 `newtab.html` 的模块脚本标签为普通外部脚本标签，规避 Firefox CSP 对 ESM 的限制。
- `scripts/bump-version.mjs`
  - 版本号自动 +0.1（满十进一）。

## 4. 目录说明

```text
src/
  assets/                图标资源（16/32/48/128）
  newtab.html            新标签页主界面
  styles.css             新标签页样式
  popup.html             Popup 页面
  popup.css              Popup 样式
  popup.js               Popup 逻辑
  js/
    app.js               主应用逻辑
    storage.js           存储层
    icons.js             图标策略与缓存
    bing-wallpaper.js    Bing 背景获取与缓存
    content-toast.js     页面内 toast
    error-bootstrap.js   加载失败兜底提示

manifest.chrome.json     Chrome Manifest V3 模板
manifest.firefox.json    Firefox Manifest V3 模板
manifest.safari.json     Safari Manifest V3 模板
scripts/
  build.sh               主构建脚本（bash）
  build-macos.command    macOS 一键构建入口（含 Safari App 签名与安装）
  bundle-firefox.mjs     Firefox ESM 合并为外部脚本
  bump-version.mjs       自动版本号递增
```

## 5. 数据模型（存储结构）

存储主键：`homepage_data`

```json
{
  "schemaVersion": 1,
  "settings": {},
  "groups": [],
  "nodes": {},
  "backups": [],
  "lastUpdated": 0
}
```

## 5.1 `groups`

- 结构：`{ id, name, order, nodes: string[] }`
- `nodes` 保存节点 ID 顺序。

## 5.2 `nodes`

### item

```json
{
  "id": "itm_xxx",
  "type": "item",
  "title": "示例",
  "url": "https://example.com/",
  "iconType": "auto|upload|color|remote|letter",
  "iconData": "",
  "color": "",
  "titlePending": false,
  "iconPending": false,
  "createdAt": 0,
  "updatedAt": 0
}
```

### folder

```json
{
  "id": "fld_xxx",
  "type": "folder",
  "title": "新建文件夹",
  "children": ["itm_xxx", "itm_yyy"],
  "createdAt": 0,
  "updatedAt": 0
}
```

## 5.3 `settings` 字段说明

- `language`: 界面语言（空 = 跟随系统）
- `showSearch`: 显示顶部搜索框
- `enableSearchEngine`: 保留字段（当前逻辑固定为 `true`）
- `searchEngineUrl`: 搜索引擎前缀
- `openMode`: `current|new|background`
- `fixedLayout`: 固定列数开关
- `fixedCols`: 固定列数
- `gridDensity`: `compact|standard|spacious`
- `fontSize`: 基础字体大小
- `tooltipEnabled`: 提示开关
- `emptyHintDisabled`: 空状态提示关闭
- `backgroundType`: `bing|color|gradient|custom`
- `backgroundColor`: 纯色背景值
- `backgroundGradient`: 渐变字符串
- `backgroundGradientA/B`: 渐变两色
- `backgroundCustom`: 自定义背景 DataURL
- `backgroundFade`: 保留字段（当前无单独行为）
- `backgroundOverlayStrength`: 图片背景遮罩强度
- `iconFetch`: 自动图标抓取
- `iconRetryAtSix`: 兼容字段（18 点重试）
- `iconRetryHour`: 重试小时（0~23 或空）
- `syncEnabled`: 是否启用 `storage.sync`
- `maxBackups`: 最大备份数（0 代表不自动备份）
- `keyboardNav`: 键盘导航开关
- `lastActiveGroupId`: 上次激活分组
- `defaultGroupMode`: `last|fixed`
- `defaultGroupId`: 固定分组 ID
- `theme`: `system|light|dark`
- `lastSaveUrl/lastSaveTs/lastSaveToast`: popup 保存辅助字段
- `sidebarCollapsed`: 左侧栏压缩态
- `sidebarHidden`: 左侧栏隐藏态

## 5.4 其他存储键

- `homepage_icon_cache`: 图标缓存
- `homepage_bg_cache`: 背景缓存
- `homepage_save_log`: popup 保存日志
- `homepage_debug_log`: 调试日志（`localStorage`）

## 6. 关键流程

## 6.1 初始化

`init()` 流程：

1. 绑定 runtime 消息与 storage 监听。
2. 读取本地数据；若启用同步则比较 `lastUpdated` 选择更新者。
3. 执行去重修复（分组节点/文件夹子节点）。
4. 恢复上次分组、载入最近历史。
5. 应用密度、主题、侧栏状态。
6. 加载背景（Bing/本地设置）。
7. 尝试图标定时重试。
8. 首次渲染。

## 6.2 持久化 `persistData()`

- 保存前自动对比指纹，必要时先生成备份快照。
- 根据 `syncEnabled` 写入 `sync` 或 `local`。
- 若同步开启，会额外写本地副本。
- 写入后再次去重并二次保存（如有必要）。
- 返回 `ok/warning/err`，由 UI 给出 toast。

## 6.3 删除与撤销

- 删除前会 `pushBackup()`。
- 删除后保留 `pendingDeletion` 快照。
- toast 显示“撤销”，可回滚。
- 撤销窗口：10 秒（`UNDO_TIMEOUT_MS = 10000`）。

## 6.4 拖拽与文件夹规则

- 拖到卡片图标：
  - 目标非文件夹 -> 创建新文件夹，包含目标与源。
  - 目标是文件夹 -> 源卡片加入目标文件夹。
- 拖到卡片非图标区域：按左右半区计算插入位置。
- 支持鼠标拖拽与触摸长按拖拽。

## 6.5 触摸交互

- 卡片长按 3 秒进入拖拽。
- 卡片触摸 1 秒弹上下文菜单。
- 分组长按约 260ms 进入拖拽。

## 6.6 popup 保存当前页

`popup.js` 行为：

- 若设置为固定分组，打开 popup 时直接保存并关闭窗口。
- 否则展示当前标签页信息 + 分组选择，下发保存。
- 保存后优先向当前页面注入 toast（消息通信 + 内容脚本兜底）。

## 7. 同步与配额策略

## 7.1 同步选择策略

- 本地与同步同时存在时按 `lastUpdated` 选最新。

## 7.2 同步数据清洗（`sanitizeForSync`）

写 `storage.sync` 前会去除高体积字段：

- `backups` 清空
- `backgroundCustom` 清空（自定义背景）
- 过长上传图标改为自动

## 7.3 配额与降级处理

- 同步目标大小阈值：`7500` bytes。
- 超限：自动关闭同步，回退本地存储。
- 本地写入遇到 quota 错误时，依次尝试：
  - 清理备份
  - 清理上传图标
  - 清理自定义背景

## 8. 图标与背景

## 8.1 favicon 候选顺序

`icons.js` 会根据域名生成候选：

- 特殊站点预设（如 Gmail/Google/OpenAI/ChatGPT）
- `origin/favicon.ico`
- Google S2 favicon API
- DuckDuckGo 图标源

## 8.2 图标缓存

- URL 维度缓存 + `site:根域` 维度缓存。
- 非 http(s) URL 会回退字母头像并清理 URL 缓存。
- `refreshAllIcons()` 支持并发刷新。

## 8.3 背景缓存

- Bing 壁纸缓存 key 为当日日期。
- 新鲜度：同日优先，其次 6 小时 TTL。
- 获取失败回退缓存，仍失败则回退纯色背景。

## 9. 设置、导入导出与备份

## 9.1 导出设置

- 优先写剪贴板。
- 失败时弹文本框手工复制。

## 9.2 导入设置

支持三种策略：

- 覆盖所有：直接替换数据对象。
- 合并现有：
  - 节点按 ID 补缺。
  - 分组同 ID 同名 -> 合并节点列表；同 ID 异名 -> 自动改 ID 新建分组。
- 仅新增：已有 ID 跳过，不覆盖。

## 9.3 批量导入网址

- 每行一个网址（取每行首 token）。
- 可选择按 `http://` 或 `https://` 规范化导入。
- 统计并提示无效条目数。

## 9.4 备份管理

- 可查看备份列表、恢复某条备份、删除备份。
- 自动备份由 `persistData` 指纹比较触发。

## 10. 权限与外部请求

## 10.1 权限

- `storage`: 数据存储
- `tabs` / `activeTab`: popup 获取当前页、后台取标题
- `history`: 历史分组读取（Chrome / Firefox 声明，Safari 不声明）
- `scripting`: 注入 content toast（Chrome / Firefox MV3 / Safari 声明）
- `<all_urls>`: favicon / toast 注入覆盖面

## 10.2 外部请求

- Bing 壁纸 API：`https://www.bing.com/*`
- favicon 源：
  - `https://www.google.com/s2/favicons`
  - `https://icons.duckduckgo.com`
  - 目标站点 `favicon.ico`

## 11. 构建与发布

补充文档：

- Safari 专项说明见 [Safari说明.md](/Users/x/code/homepage/Safari说明.md)

## 11.1 前置条件

- Node.js（用于脚本）
- Bash（`npm run build` 调用 `scripts/build.sh`）
- zip 工具（`build.sh` 使用 `zip`）
- macOS 构建 Safari 宿主 App 时需安装 Xcode（使用 `xcrun safari-web-extension-converter` 与 `xcodebuild`）

## 11.2 构建命令

```bash
npm run build
```

或在 macOS 直接运行项目内构建入口：

```bash
NO_PAUSE=1 ./scripts/build-macos.command
```

说明：

- `scripts/build-macos.command` 默认使用 Xcode `Release` 配置构建 Safari 宿主 App，避免 `Debug` 产物注入 `__preview.dylib` / `*.debug.dylib` 导致 Safari 扩展新标签页空白。
- 若本机钥匙串存在 `Apple Development` 证书，`scripts/build-macos.command` 会在 Xcode 构建后自动对 Safari 宿主 App 与 `.appex` 进行二次开发签名，避免 Safari 启动后清空新标签页接管设置。
- 如需临时切回其他配置，可在命令前覆盖环境变量：`SAFARI_XCODE_CONFIGURATION=Debug NO_PAUSE=1 ./scripts/build-macos.command`

执行链：

1. `build` -> `scripts/build.sh`
2. build.sh 开头自动调用 `scripts/bump-version.mjs` 自增版本号（可用 `SKIP_BUMP=1` 跳过，如 CI 场景）
3. 产物输出：
   - `dist/chrome`
   - `dist/firefox`
   - `dist/safari`
   - `dist/chrome.zip`
   - `dist/firefox.zip`
   - `dist/firefox.xpi`
   - `dist/safari.zip`
   - `dist/safari-app`（仅 macOS，Safari 宿主 App Xcode 工程）

## 11.3 Firefox 特别说明

Firefox 使用 Manifest V3。由于 Firefox 扩展 CSP 对 ESM 模块加载有限制，新标签页按钮点击无响应通常是脚本未执行。当前实现已采用：

- `scripts/bundle-firefox.mjs` 把多个 ESM 模块（`storage.js` / `icons.js` / `bing-wallpaper.js` / `app.js`）合并为单一外部脚本 `dist/firefox/js/app.ff.js`
- 把 `newtab.html` 的模块脚本标签替换为普通 `<script src="js/app.ff.js">`
- CSP 保持 `script-src 'self'`，无需内联脚本哈希

发布与调试均应以 `dist/firefox` 目录为准加载扩展。

## 12. 安装方式

## 12.1 Chrome

1. 打开 `chrome://extensions/`
2. 开启开发者模式
3. 加载已解压的扩展程序 -> 选择 `dist/chrome`

## 12.2 Firefox

1. 打开 `about:debugging#/runtime/this-firefox`
2. 临时载入附加组件 -> 选择 `dist/firefox/manifest.json`

## 12.3 Safari

1. 运行 `NO_PAUSE=1 ./scripts/build-macos.command`
2. 脚本会生成并构建 `dist/safari-app`
3. 自动启动生成出的 `我的首页 Safari.app`
4. 在 Safari 的“设置 -> 高级”开启开发菜单后，到“开发 -> 扩展”里启用对应扩展
5. Safari 版本不声明 `history` 权限，因此“历史”分组会自动退化为空列表，不影响其余功能

## 13. 调试入口

调试接口仅在 `DEBUG` 全局变量为 `true` 的开发构建中暴露，生产构建不可用：

- `window.homepageDebugLog()`：读取调试日志（localStorage 存储）。
- `window.homepageDebugEnv()`：查看 runtime 信息与本地存储占用。
- `localStorage.setItem("homepage_debug_persist", "1")`：开启持久化校验日志（调试模式下 persist 后自动回读验证）。
- Popup 保存日志键：`homepage_save_log`（`chrome.storage.local`）。

如需临时启用调试接口，可在控制台执行：`DEBUG = true; location.reload()` 不生效（脚本加载时即判断），需自行在 `src/js/app.js` 顶部添加 `const DEBUG = true;` 后重新构建。

## 14. 已知限制（当前代码行为）

- `enableSearchEngine`、`backgroundFade` 为保留字段，当前逻辑未单独使用。
- 设置面板"隐藏分组"绑定的是 `sidebarHidden`，而顶部"收起"按钮操作的是 `sidebarCollapsed`，两者是不同状态。
- "清空数据"先 `defaultData()` 再 `clearData(syncEnabled)`，不会主动清理未开启同步时旧的 `storage.sync` 残留。
- 导入 JSON 仅检查 `schemaVersion`，不做严格 schema 校验。
- 搜索框回车/按钮始终新页搜索，不受 `openMode` 影响。
- 调试接口（`homepageDebugLog` / `homepageDebugEnv`）在生产构建中不可用，需手动开启 `DEBUG`。
- Firefox 版因 CSP 限制不能直接加载 ESM 模块，通过 `bundle-firefox.mjs` 合并为单文件外部脚本绕过。
- Safari 版不声明 `history` 权限，"历史"分组为空列表。
- 图标缓存存储为 dataURL 时体积较大，同步存储会触发裁剪（上传图标改为自动）。
- 已有自动化测试：`tests/` 目录下 5 个测试文件、36 个用例，覆盖 storage/icons/bing-wallpaper/bump-version/bundle-firefox；通过 `npm test` 运行；GitHub Actions CI 自动执行 `npm run check` + `npm test`。

## 15. 版本策略

- 版本在 `package.json`、`manifest.chrome.json`、`manifest.firefox.json`、`manifest.safari.json` 四端保持一致。
- 每次构建会自动执行 **+0.1（满十进一）**。

### 具体实现机制

| 环节 | 文件 | 说明 |
|------|------|------|
| 版本号计算逻辑 | [scripts/bump-version.mjs](file:///Users/x/code/homepage/scripts/bump-version.mjs#L7-L15) | `bumpVersion()` 函数：拆分为 major.minor 两段，minor + 1，满十进一到 major |
| 批量更新文件 | [scripts/bump-version.mjs](file:///Users/x/code/homepage/scripts/bump-version.mjs#L17-L28) | `run()` 函数：遍历 `files` 数组（4 个文件），读取 JSON → 改 version → 写回 |
| 构建触发点 | [scripts/build.sh](file:///Users/x/code/homepage/scripts/build.sh#L14-L18) | build.sh 开头调用 `node scripts/bump-version.mjs`，在复制资源前先改版本号 |
| 跳过方式 | [scripts/build.sh](file:///Users/x/code/homepage/scripts/build.sh#L14-L18) | 设环境变量 `SKIP_BUMP=1` 可跳过（CI / 调试场景用） |
| 入口 | [package.json](file:///Users/x/code/homepage/package.json) | `npm run build` → `bash scripts/build.sh`，不再用 prebuild 钩子 |

### 举例

- `16.9` → `17.0`（9+1=10，进一位）
- `17.0` → `17.1`
- `17.9` → `18.0`

---

如果你要继续扩展本项目，建议先从以下文件入手：

- 交互主逻辑：`src/js/app.js`
- 存储与配额：`src/js/storage.js`
- 图标系统：`src/js/icons.js`
- Firefox 构建关键：`scripts/bundle-firefox.mjs`
- Safari 构建关键：`manifest.safari.json`、`scripts/build-macos.command`

---

## 16. 开发者地图（功能 → 代码位置速查）

> 帮助快速定位功能对应的代码位置，便于二次开发。

### 16.1 应用入口与初始化

| 功能 | 文件 | 关键函数/位置 |
|------|------|-------------|
| 新标签页入口 HTML | [src/newtab.html](file:///Users/x/code/homepage/src/newtab.html) | `<script type="module" src="js/app.js">` |
| 加载失败兜底提示 | [src/js/error-bootstrap.js](file:///Users/x/code/homepage/src/js/error-bootstrap.js) | 内联于 `<head>`，检测 ESM 加载失败 |
| Popup 入口 HTML | [src/popup.html](file:///Users/x/code/homepage/src/popup.html) | `<script type="module" src="popup.js">` |
| 应用初始化 | [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js) | `init()`（文件末尾自执行） |
| 初始渲染流程 | [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js#L3742-L3810) | `init()` 内的串行步骤 |

### 16.2 状态与数据

| 功能 | 文件 | 关键函数/位置 |
|------|------|-------------|
| 全局状态变量 | [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js) | `let data`、`let state`（文件顶部） |
| 数据默认值 | [src/js/storage.js](file:///Users/x/code/homepage/src/js/storage.js#L87-L123) | `DEFAULT_SETTINGS`、`defaultData()` |
| 数据读写封装 | [src/js/storage.js](file:///Users/x/code/homepage/src/js/storage.js) | `loadData()` / `saveData()` / `clearData()` |
| 本地 vs 同步存储 | [src/js/storage.js](file:///Users/x/code/homepage/src/js/storage.js#L200-L276) | `loadData()` 内的 lastUpdated 比较策略 |
| 数据迁移框架 | [src/js/storage.js](file:///Users/x/code/homepage/src/js/storage.js#L277-L328) | `migrateData()` + `MIGRATIONS` 注册表 |
| 配额与降级 | [src/js/storage.js](file:///Users/x/code/homepage/src/js/storage.js#L439-L506) | `handleQuotaError()` 逐级清理 |
| 同步数据清洗 | [src/js/storage.js](file:///Users/x/code/homepage/src/js/storage.js#L330-L380) | `sanitizeForSync()` |
| 持久化写入 | [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js#L1228-L1300) | `persistData()`（指纹对比 + 备份 + 二次去重） |
| 备份与恢复 | [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js) | `pushBackup()` / `restoreBackup()` / `createBackupSnapshot()` |

### 16.3 渲染与界面

| 功能 | 文件 | 关键函数/位置 |
|------|------|-------------|
| 主渲染函数 | [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js#L927-L978) | `render()`（清空 + 重渲染分组栏 + 网格） |
| 网格卡片渲染 | [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js) | `renderCard()`（item/folder/history 三种类型） |
| 分组侧栏渲染 | [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js) | `renderGroups()` |
| 主题与密度应用 | [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js) | `applyTheme()` / `applyDensity()` / `applyFontSize()` |
| 背景设置 | [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js#L1082-L1096) | `setBackground()`（CSS.escape + 白名单，防 XSS） |
| 搜索过滤 | [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js) | `searchInput` 事件 + `render()` 过滤 |

### 16.4 拖拽与文件夹

| 功能 | 文件 | 关键函数/位置 |
|------|------|-------------|
| 鼠标拖拽 | [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js) | `handleCardDragStart` / `handleCardDrop` |
| 触摸长按拖拽 | [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js#L1685-L1740) | `TOUCH_TILE_LONG_PRESS_MS`（3秒）+ touch 事件组 |
| 分组长按拖拽 | [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js#L675-L695) | `TOUCH_GROUP_LONG_PRESS_MS`（260ms） |
| 触摸上下文菜单 | [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js) | `touchMenuState` + `TOUCH_TILE_CONTEXT_MENU_MS`（1秒） |
| 框选（鼠标拖拽选多个） | [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js) | `handleBoxSelectStart` / `handleBoxSelectMove`（raf 节流） / `handleBoxSelectEnd` |
| 文件夹创建与解散 | [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js) | `createFolderFromTwoCards()` / `dissolveFolder()` |
| 文件夹覆盖层 | [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js) | `openFolder()` / `closeFolder()` |

### 16.5 模态框与设置

| 功能 | 文件 | 关键函数/位置 |
|------|------|-------------|
| 模态框模板 | [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js) | `createModal()` + `document.createElement` 安全渲染 |
| 添加/编辑卡片 | [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js) | `openAddModal()` / `openEditModal()` |
| 设置面板 | [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js) | `openSettingsModal()` + `renderSettingsContent()` |
| 导入导出 | [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js) | `openExportModal()` / `openImportModal()` + `importData()` 三种策略 |
| 备份管理 | [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js) | `openBackupModal()` |
| 删除确认与撤销 | [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js) | `confirmDeleteWithUndo()` + `UNDO_TIMEOUT_MS`（10秒） |
| 批量操作 | [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js) | `startBulkDelete()` / `executeBulkDelete()` |

### 16.6 图标系统

| 功能 | 文件 | 关键函数/位置 |
|------|------|-------------|
| favicon 候选生成 | [src/js/icons.js](file:///Users/x/code/homepage/src/js/icons.js#L101-L200) | `getFaviconCandidates()`（按浏览器排列优先级） |
| 图标缓存（dataURL） | [src/js/icons.js](file:///Users/x/code/homepage/src/js/icons.js) | `_iconCacheMemory` + `loadIconCache()` / `saveIconCache()` |
| 图标加载与尺寸校验 | [src/js/icons.js](file:///Users/x/code/homepage/src/js/icons.js) | `probeImage()`（≥16x16 才接受） |
| 预加载缓存 | [src/js/icons.js](file:///Users/x/code/homepage/src/js/icons.js) | `preloadAllIcons()`（单次读取，避免渲染循环多次 IO） |
| 批量刷新图标 | [src/js/icons.js](file:///Users/x/code/homepage/src/js/icons.js#L417-L470) | `refreshAllIcons()`（6 并发） |
| 失败重试调度 | [src/js/icons.js](file:///Users/x/code/homepage/src/js/icons.js) | `retryFailedIconsIfDue()` + `iconRetryHour` 设置 |
| 字母头像生成 | [src/js/icons.js](file:///Users/x/code/homepage/src/js/icons.js) | `generateLetterIcon()` / `generateColorIcon()` |
| 图标展示入口 | [src/js/icons.js](file:///Users/x/code/homepage/src/js/icons.js) | `resolveIcon()`（带 preloadedCache 参数优化性能） |

### 16.7 Bing 每日背景

| 功能 | 文件 | 关键函数/位置 |
|------|------|-------------|
| 获取每日壁纸 | [src/js/bing-wallpaper.js](file:///Users/x/code/homepage/src/js/bing-wallpaper.js) | `fetchBingWallpaper()` |
| 背景缓存策略 | [src/js/bing-wallpaper.js](file:///Users/x/code/homepage/src/js/bing-wallpaper.js) | `BING_CACHE_KEY`（同日 key）+ `MAX_CACHE_AGE`（6 小时） |
| 缓存读写 | [src/js/bing-wallpaper.js](file:///Users/x/code/homepage/src/js/bing-wallpaper.js) | `getCachedWallpaper()` / `setCachedWallpaper()` |
| 失败回退 | [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js) | `loadBackground()` 内的三级降级（Bing → 缓存 → 纯色） |

### 16.8 国际化

| 功能 | 文件 | 关键函数/位置 |
|------|------|-------------|
| 语言列表（设置用） | [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js#L205-L214) | `APP_SUPPORTED_LANGUAGES`（8 种） |
| 翻译函数 | [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js) | `t(key)` + `I18N` 对象 |
| 语言检测 | [src/js/storage.js](file:///Users/x/code/homepage/src/js/storage.js) | `detectPreferredLanguage()` |
| 存储侧语言列表 | [src/js/storage.js](file:///Users/x/code/homepage/src/js/storage.js) | `SUPPORTED_LANGUAGES`、`STORAGE_SUPPORTED_LANGUAGES` |

### 16.9 Popup 与内容脚本

| 功能 | 文件 | 关键函数/位置 |
|------|------|-------------|
| Popup 主逻辑 | [src/popup.js](file:///Users/x/code/homepage/src/popup.js) | `init()` + 保存当前页到分组 |
| Popup 获取当前标签页 | [src/popup.js](file:///Users/x/code/homepage/src/popup.js) | `getCurrentTab()`（含 lastError 检查） |
| 固定分组自动保存 | [src/popup.js](file:///Users/x/code/homepage/src/popup.js#L600-L620) | `defaultGroupMode === "fixed"` 时自动关闭 |
| 页面内 Toast | [src/js/content-toast.js](file:///Users/x/code/homepage/src/js/content-toast.js) | `showToast()` + `onMessage` 监听 + 注入守卫 |
| Toast 注入守卫 | [src/js/content-toast.js](file:///Users/x/code/homepage/src/js/content-toast.js#L18-L48) | `window.__homepageToastInjected` |

### 16.10 历史页

| 功能 | 文件 | 关键函数/位置 |
|------|------|-------------|
| 读取最近历史 | [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js#L3535-L3570) | `loadRecentHistory()`（7天/24条/URL去重） |
| 历史项添加到快捷 | [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js) | `addHistoryItemToShortcuts()` |
| Safari 兼容（无 history 权限） | 运行时自动降级 | 空列表不报错 |

### 16.11 构建系统

| 功能 | 文件 | 关键位置 |
|------|------|---------|
| 主构建脚本 | [scripts/build.sh](file:///Users/x/code/homepage/scripts/build.sh) | 复制资源 + 写 manifest + 打包 + Safari 转换 + 签名 |
| 版本号自增 | [scripts/bump-version.mjs](file:///Users/x/code/homepage/scripts/bump-version.mjs) | `bumpVersion()`（满十进一） |
| 构建入口 | [package.json](file:///Users/x/code/homepage/package.json) | `npm run build` → `bash scripts/build.sh` |
| macOS 一键入口 | [scripts/build-macos.command](file:///Users/x/code/homepage/scripts/build-macos.command) | 含 Xcode 构建 + 开发签名 + 安装到 /Applications + lsregister 去重 |
| Firefox ESM 打包 | [scripts/bundle-firefox.mjs](file:///Users/x/code/homepage/scripts/bundle-firefox.mjs) | `bundle()` 合并 + `patchHtml()` 替换脚本标签 |
| Chrome 构建 | [scripts/build.sh](file:///Users/x/code/homepage/scripts/build.sh) | `build_chrome` 函数 |
| Firefox 构建 | [scripts/build.sh](file:///Users/x/code/homepage/scripts/build.sh) | `build_firefox` 函数 + 调 bundle-firefox.mjs |
| Safari 构建 | [scripts/build.sh](file:///Users/x/code/homepage/scripts/build.sh) | `build_safari` + `build_safari_app` + `install_safari_app` |
| Safari Info.plist 补丁 | [scripts/build.sh](file:///Users/x/code/homepage/scripts/build.sh) | `fix_safari_extension_info_plist`（加 SFSafariWebsiteAccess） |
| Safari 旧插件清理 | [scripts/build.sh](file:///Users/x/code/homepage/scripts/build.sh) | `cleanup_stale_safari_plugins`（旧 bundle id 注销） |

### 16.12 安全防护

| 功能 | 文件 | 关键位置 |
|------|------|---------|
| XSS：模态框安全渲染 | [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js) | 统一用 `document.createElement` + `textContent` |
| XSS：背景样式转义 | [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js#L1082-L1096) | `setBackground()` 使用 `CSS.escape()` + 白名单 |
| XSS：用户数据进入 DOM | 全部渲染路径 | 标题/URL 均经 `textContent` 或 `setAttribute` |
| 内容脚本重复注入 | [src/js/content-toast.js](file:///Users/x/code/homepage/src/js/content-toast.js#L18-L48) | `window.__homepageToastInjected` 守卫 |
| 错误引导脚本重复注入 | [src/js/error-bootstrap.js](file:///Users/x/code/homepage/src/js/error-bootstrap.js) | `window.__homepageErrorBootstrapInjected` 守卫 |
| 调试接口生产隐藏 | [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js#L885-L906) | `if (typeof DEBUG !== "undefined" && DEBUG)` |
| chrome API 错误检查 | [src/popup.js](file:///Users/x/code/homepage/src/popup.js) | `chrome.runtime.lastError` 检查 |
| 存储读取重试（Safari） | [src/js/storage.js](file:///Users/x/code/homepage/src/js/storage.js) | `storageGet()` 3 次重试 + 递增间隔 |

### 16.13 测试与 CI

| 功能 | 文件 | 说明 |
|------|------|------|
| 存储模块测试 | [tests/storage.test.js](file:///Users/x/code/homepage/tests/storage.test.js) | 15 个用例：语言检测、深拷贝、默认数据、备份、CRUD、迁移 |
| 图标模块测试 | [tests/icons.test.js](file:///Users/x/code/homepage/tests/icons.test.js) | 10 个用例：候选生成、缓存、头像、尺寸校验 |
| Bing 背景测试 | [tests/bing-wallpaper.test.js](file:///Users/x/code/homepage/tests/bing-wallpaper.test.js) | 3 个用例：缓存读写、TTL 过期 |
| 版本号测试 | [tests/bump-version.test.js](file:///Users/x/code/homepage/tests/bump-version.test.js) | 2 个用例：bump 逻辑、满十进一 |
| Firefox 打包测试 | [tests/bundle-firefox.test.js](file:///Users/x/code/homepage/tests/bundle-firefox.test.js) | 6 个用例：strip 函数、bundle、patchHtml 幂等 |
| CI 工作流 | [.github/workflows/ci.yml](file:///Users/x/code/homepage/.github/workflows/ci.yml) | push/PR 触发：`npm run check` + `npm test` |
| 代码风格 | Biome | `npm run check`（lint + format + import 排序） |
