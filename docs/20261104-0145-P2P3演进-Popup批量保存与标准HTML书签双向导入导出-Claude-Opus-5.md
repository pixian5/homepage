# P2/P3 演进：Popup 批量保存标签页 + Netscape 标准 HTML 书签双向导入导出（26.7.9）

> 模型：Claude Opus 5 ｜ 日期：2026-11-04 01:45 ｜ 版本：26.7.8 → 26.7.9

## 一、P2.1 Popup 批量保存当前窗口所有标签页

### 入口（`src/popup.html` + `src/popup.js`）

- 弹窗菜单「添加书签」下方新增 **「保存当前窗口所有标签」**（`#saveAllTabsMenu`），结构与添加书签完全一致：点击展开目标树（分组 + 嵌套文件夹，复用 `collectBookmarkFolders`），选中即批量归档。
- 两个菜单的树渲染抽成公共函数 `buildFolderMenuTree` + `bindMenuToggle`，消除原 `renderBookmarkFolderMenu` 的整段重复。
- 菜单样式全复用现有 `menu-parent / menu-submenu / menu-folder-row` 类，零新增 CSS。

### 核心逻辑（新模块 `src/js/popup-batch-save.js`，纯函数便于单测）

- `filterSavableTabs(tabs)`：`normalizeUrl` 协议白名单（仅 http/https/ftp）天然排除 `chrome://`、`edge://`、`about:`、`chrome-extension://`、空 URL；同 URL 去重（同页多标签只存一份）；空标题回退 hostname。
- `saveTabsToContainer(data, savableTabs, {containerId, deviceId, now})`：
  - 每个标签经 `createItemNode` 生成独立节点（iconPending 交给后台抓取 favicon）；
  - 按序追加到 `group.nodes` / `folder.children`（缺失时自动初始化）；
  - **为每个新节点登记结构时钟 `_syncMeta.placementClock`**（parentKind/parentId/index/updatedAt/updatedBy，与后台 `homepage_save_bookmark` 路径一致，保证多端并发放置裁决准确）；
  - 推进父容器 `updatedAt`、`data.lastUpdated`、`settings.lastActiveGroupId`。
- popup.js 侧 `saveAllTabsToContainer`：查询窗口标签 → 过滤 → 写入 → `storageSet(local)`（本地权威，newtab 监听变更后 schedulePush 上传投影，与单个保存路径一致）；无可保存标签时 toast `noValidTabs`，成功 toast「已保存 N 个标签页到分组：X」（在当前网页注入）。
- `POPUP_I18N` 三语新增 5 个 key（saveAllTabs / savedAllToGroup / noValidTabs / saveAllFailed 等）。

## 二、P3.1 Netscape 标准 HTML 书签双向导入导出

### 新模块 `src/js/bookmark-html.js`

- **`exportNetscapeBookmarksHtml(data)`**：输出标准 `<!DOCTYPE NETSCAPE-Bookmark-file-1>` 文件；分组/folder → `<DT><H3 ADD_DATE LAST_MODIFIED>` 嵌套 `<DL><p>`；书签 → `<DT><A HREF ADD_DATE ICON>`；文本与属性严格 HTML 转义（防 XSS）；内嵌 `data:` 图标导出为 `ICON`（>32KB 跳过）；`deletedAt`/`purgedAt` 节点与循环引用防御性跳过。单根「全部」模型的子级直接置于顶层（不额外包一层），旧多分组形态每个分组一层 H3。
- **`parseNetscapeBookmarksHtml(htmlText)`**：**自研按行扫描状态机，不依赖 DOMParser**（浏览器与 Node 测试环境行为完全一致）：`<H3>` 挂起待 `<DL>` 开层、`<A HREF>` 记书签、`</DL>` 弹栈；根 `<DL>` 只标记进入根容器不构成层级（修复过程中发现的层级偏移缺陷）；对未闭合 `<H3>`/`<A>`、缺失/多余 `</DL>`、无 HREF 锚点、纯垃圾输入全部容错；属性大小写不敏感、支持单/双引号；完整 HTML 实体解码（命名 + 十进制 + 十六进制，代理区码位替换 U+FFFD）。顶层散落书签归入 name 为空的首分组。
- **`bookmarksToHomepageData(parsed, {now, updatedBy, knownUrls})`**：顶层分组 → 「全部」根下顶层 folder，书签 → item（`iconType:"data"` + data URI；Netscape 裸 base64 自动补 `data:image/png;base64,` 前缀，>16KB 丢弃）；`ADD_DATE` 秒 → 毫秒 createdAt；**`knownUrls` 按 URL 去重**——重复导入同一文件不翻倍，去重后变空的文件夹自动丢弃。

### 设置面板接入（`settings-controller.js` + `app-i18n.js`）

- 备份区新增「导出为标准 HTML 书签」「导入 HTML 书签」两按钮 + 隐藏文件选择框。
- 导出：生成 HTML → Blob 下载 `homepage-bookmarks-YYYYMMDD.html`（Chrome/Firefox/Safari/Edge 书签管理器可直接导入）。
- 导入：读取 → parse → 收集现有全部书签 URL 作为 knownUrls → 转换 → `pushBackup()` 保险快照 → `mergeRootBookmarkData` 并入「全部」根（同 ID 本机优先、只追加缺失）→ persistData + render + 后台图标抓取 + 同步状态刷新。

### 架构纪律

- `bookmark-html.js` 被 app 链路（app.js import → settings-controller 注入）引用 → **已在 `scripts/firefox-modules.json` 的 app 组按拓扑注册**（data-utils.js 之后），`validateModuleTopology` 门禁与 `assertClassicScript` 校验通过。
- `popup-batch-save.js` 仅被 popup.js 引用；Firefox 的 popup 是 ESM 直拷（不参与拼接），无需注册，构建产物已验证存在。

## 三、测试与验证

新增 20 项测试：

- `tests/bookmark-html.test.js`（13 项）：标准头/嵌套/时间戳导出、XSS 转义、图标导出与删除节点忽略、legacy 多分组、Chrome 标准样例解析、未闭合标签与垃圾输入容错、实体解码、数据形状转换（含裸 base64 前缀与超大图标丢弃）、knownUrls 幂等合并、导出→解析往返保真。
- `tests/popup-batch-save.test.js`（7 项）：协议过滤、去重与标题回退、分组/文件夹批量写入与 placementClock 登记顺序、children 缺失初始化、异常拒绝（无有效标签/未知容器/数据未初始化/目标非容器）。

**验证结果：`npm test` 302/302 通过（282 基线 + 20 新增），`npm run check` Biome 零告警，Firefox bundle 与三端完整构建成功（产物含全部新模块），Chrome + Firefox 真实浏览器冒烟 5 项检查全部通过。**

实现过程中修复的两个自身缺陷（测试先行发现）：① 解析器把根 `<DL>` 当作文件夹层级导致顶层分组被包进无名分组；② legacy 多分组导出时把分组名误读为 `title` 字段（实际是 `name`）。

## 四、遗留与下一步

- P1 收尾：客户端持久化 deviceSecret 并在同步引擎自动使用 Device 凭据；墓碑回收常态化脚本；退役设备恢复入口。
- 书签 HTML 导入目前只有「并入全部根」一种模式，可按需增加「导入为独立新分组」选项。
