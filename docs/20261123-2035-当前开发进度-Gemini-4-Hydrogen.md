# 27.2.1：Popup 单页保存位置时钟对齐与全端多语言补齐

## 问题与实现

1. **Popup 单页保存补齐 `placementClock` 与单调时钟推进（`src/js/popup-batch-save.js`、`src/popup.js`）**：
   - 原先仅「批量保存所有标签」（`popup-batch-save.js`）和「网页侧边栏保存」（`background.js`）会写入 `data._syncMeta.placementClock[node.id]`，而 Popup 单页保存入口 `saveToContainer()` 直接拼接节点且未登记 `placementClock`，也未通过 `nextSyncTimestamp()` 单调推进容器时钟与 `data.lastUpdated`。
   - 现抽出共享纯函数 `appendTabsToContainer()` 供 `saveTabsToContainer()` 与新增的 `saveSingleTabToContainer()` 共用：统一通过 `nextSyncTimestamp()` 推进父容器 `updatedAt` 与 `data.lastUpdated`（防止时钟偏斜导致 `storage-listener` 误判回声而跳过重载），并在 `data._syncMeta.placementClock` 中为新建节点写入 `parentKind`、`parentId`、`index`、`updatedAt`、`updatedBy`。

2. **清理 `import-export.js`、`settings-controller.js` 与 `popup.js` 硬编码并扩展至 8 语言（`src/js/app-i18n.js`、`src/js/popup-i18n.js`、`src/js/bookmark-sidebar.js`）**：
   - 在 `src/js/app-i18n.js` 中补齐导入导出、导入网址、备份管理、清空数据/卡片失败等 **43 项**词条的 8 语言翻译（`zh-CN` / `zh-TW` / `en` / `ja` / `ko` / `de` / `fr` / `es`），并在 `src/js/import-export.js` 与 `src/js/settings-controller.js` 中全面替换为 `t(...)`（对未注入 `ui.t` 的轻量单元测试提供 `translateAppText("zh-CN", ...)` 兜底）。
   - 新增独立模块 `src/js/popup-i18n.js`，将 Popup 弹窗语言支持从 3 种扩展至与主应用一致的 **8 种语言**；修复 `applyPopupI18n()` 遗漏更新 `#addBookmarkLabel` 与侧栏按钮 `aria-label`/错误提示的问题，消除 `src/popup.js` 内全部硬编码中文。
   - 同步为内容脚本 `src/js/bookmark-sidebar.js` 增加基于 `data.settings.language` 的 8 语言本地化文案。

## 验证

- 新增 `tests/popup-i18n.test.js`，扩展 `tests/popup-batch-save.test.js`（覆盖单页保存 `placementClock`、时钟偏斜单调推进与非法 URL 拦截）和 `tests/import-export.test.js`（验证导入导出/备份管理弹窗在英文与日文模式下不残留中文硬编码）。
- 运行 `bash dist/build-macos.command` 生成 `27.2.1` 四份扩展包（`chrome.zip`、`firefox.zip`、`firefox.xpi`、`safari.zip`），仅打包不退出或替换已安装应用。
- 运行 `bash scripts/run-all-smoke.sh` 一键全量回归全部通过：
  - 残余进程/临时目录清扫：0 孤儿、0 遗留；
  - 全量单元测试：**153 个套件、580/580 项全部通过**；
  - Biome 检查：**162 个文件 0 告警**；
  - Firefox 拓扑打包校验通过（`app.ff.js + background.ff.js`）；
  - 双端无头浏览器冒烟（Google Chrome for Testing 159.0.8154.6 + Mozilla Firefox 161.0b5）100% 通过。
