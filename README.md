# 我的首页（Chrome / Firefox 新标签页扩展）

> 本文档基于当前仓库源码（`src/` + `scripts/` + `manifest.*.json`）整理，重点是“实现现状”而不是需求设想。

## 1. 项目定位

这是一个浏览器扩展，用来替换浏览器新标签页，提供可维护的快捷入口面板，支持：

- 新标签页接管（Chrome MV3 / Firefox MV2）
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
  - 存储读写封装、本地/同步切换、配额处理、默认数据、备份快照。
- `src/js/icons.js`
  - favicon 候选策略、图标缓存、头像生成、失败重试。
- `src/js/bing-wallpaper.js`
  - Bing API 拉取、背景缓存、失败回退。
- `src/popup.js`
  - 当前标签页保存逻辑、保存后 toast 注入。
- `src/js/content-toast.js`
  - 普通网页中接收消息并显示 toast。

## 3.3 构建模块

- `scripts/build.sh`
  - 复制 `src` 到 `dist/chrome`、`dist/firefox`，写入对应 manifest，打包 zip/xpi。
- `scripts/bundle-firefox.mjs`
  - 将 Firefox 的 `app.js` 依赖打包为内联脚本；
  - 计算内联脚本 SHA-256（LF 归一化）并写入 `dist/firefox/manifest.json` 的 CSP。
- `scripts/bump-version.mjs`
  - 版本号自动 +0.1（满十进一）。

## 4. 目录说明

```text
src/
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

manifest.chrome.json     Chrome Manifest V3 模板
manifest.firefox.json    Firefox Manifest V2 模板
scripts/
  build.sh               主构建脚本（bash）
  bundle-firefox.mjs     Firefox 内联脚本 + CSP Hash
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
- `history`: 历史分组读取
- `scripting`（Chrome manifest）: 注入 content toast
- `<all_urls>`: favicon / toast 注入覆盖面

## 10.2 外部请求

- Bing 壁纸 API：`https://www.bing.com/*`
- favicon 源：
  - `https://www.google.com/s2/favicons`
  - `https://icons.duckduckgo.com`
  - 目标站点 `favicon.ico`

## 11. 构建与发布

## 11.1 前置条件

- Node.js（用于脚本）
- Bash（`npm run build` 调用 `scripts/build.sh`）
- zip 工具（`build.sh` 使用 `zip`）

## 11.2 构建命令

```bash
npm run build
```

执行链：

1. `prebuild` -> `scripts/bump-version.mjs` 自动版本 +0.1
2. `build` -> `scripts/build.sh`
3. 产物输出：
   - `dist/chrome`
   - `dist/firefox`
   - `dist/chrome.zip`
   - `dist/firefox.zip`
   - `dist/firefox.xpi`

## 11.3 Firefox 特别说明

Firefox 新标签页若按钮点击无响应，通常是脚本未执行。当前实现已采用：

- `scripts/bundle-firefox.mjs` 生成内联脚本
- 计算脚本哈希时做 LF 归一化
- 将 hash 写入 `dist/firefox/manifest.json` 的 CSP

发布与调试均应以 `dist/firefox` 目录为准加载扩展。

## 12. 安装方式

## 12.1 Chrome

1. 打开 `chrome://extensions/`
2. 开启开发者模式
3. 加载已解压的扩展程序 -> 选择 `dist/chrome`

## 12.2 Firefox

1. 打开 `about:debugging#/runtime/this-firefox`
2. 临时载入附加组件 -> 选择 `dist/firefox/manifest.json`

## 13. 调试入口

- `window.homepageDebugLog()`：读取调试日志。
- `window.homepageDebugEnv()`：查看 runtime 信息与本地存储占用。
- `localStorage.setItem("homepage_debug_persist", "1")`：开启持久化校验日志。
- Popup 保存日志键：`homepage_save_log`。

## 14. 已知限制（当前代码行为）

- `enableSearchEngine`、`backgroundFade` 为保留字段，当前逻辑未单独使用。
- 设置面板“隐藏分组”绑定的是 `sidebarHidden`，而顶部“收起”按钮操作的是 `sidebarCollapsed`，两者是不同状态。
- “清空数据”先 `defaultData()` 再 `clearData(false)`，不会主动清理旧的 `storage.sync` 残留。
- 导入 JSON 仅检查 `schemaVersion`，不做严格 schema 校验。
- 搜索框回车/按钮始终新页搜索，不受 `openMode` 影响。
- 暂无自动化测试（无单元测试/端到端测试脚本）。

## 15. 版本策略

- 版本在 `package.json`、`manifest.chrome.json`、`manifest.firefox.json` 保持一致。
- 每次构建会自动执行 +0.1（满十进一）。

---

如果你要继续扩展本项目，建议先从以下文件入手：

- 交互主逻辑：`src/js/app.js`
- 存储与配额：`src/js/storage.js`
- 图标系统：`src/js/icons.js`
- Firefox 构建关键：`scripts/bundle-firefox.mjs`
