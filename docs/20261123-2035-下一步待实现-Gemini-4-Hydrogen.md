# 下一步：单测提速、千行模块精简与原生安装验收

1. **单元测试提速（`src/js/touch-drag-manager.js` & `tests/touch-drag-manager.test.js`）**：目前全套 580 项测试耗时约 24s，其中 `touch-drag-manager.test.js` 因真实等待 6 次 3000ms 长按独占 20.3s；可注入可配置长按阈值（`tileLongPressMs` / `tileMenuHoldMs` / `groupLongPressMs`）将全量测试缩短至 4s 以内。
2. **千行模块继续拆分**：将 `src/js/settings-controller.js`（1,134 行）中的同步状态面板与协同设备仪表盘拆出为独立模块，并将 `src/js/sync_engine.js`（1,233 行）中的设备配对/退役熔断抽离。
3. **Manifest 内容脚本按需注入收敛评估**：评估移除 `manifest.*.json` 中 `<all_urls>` 静态 `content_scripts` 注入，统一走 `popup.js` 已有的按需动态注入以减少日常网页内存开销。
4. **原生安装正向路径验收**：仅在用户另行同意并自行退出 Safari 后执行 `bash dist/build-macos.command --install`，核对宿主签名、插件登记与数据快照。
