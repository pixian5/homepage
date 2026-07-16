# Tasks
- [x] Task 1: 修复 `fetchTitleViaTab` 同步异常安全
  - [x] SubTask 1.1: 在 `src/js/app.js` 中把 `api.tabs.onUpdated.addListener(onUpdated)` 包进 try/catch，catch 分支调用 `finish("")`
  - [x] SubTask 1.2: `node --check src/js/app.js` 验证语法
- [x] Task 2: 修复 Safari Xcode 旧 build 产物残留
  - [x] SubTask 2.1: 在 `scripts/build.sh` 的 `build_safari_project` 函数末尾加 `rm -rf "${SAFARI_PROJECT_DIR}/build"`
  - [x] SubTask 2.2: 运行 `npm run build` 验证 `dist/safari-app/build/` 被清理
- [x] Task 3: 版本号 bump 与构建验证
  - [x] SubTask 3.1: `npm run build` 触发 `bump-version.mjs`，版本号 bump 到 13.10
  - [x] SubTask 3.2: 验证三端 manifest 和 package.json 版本号一致为 13.10
  - [x] SubTask 3.3: 验证 `dist/firefox/js/app.ff.js` 中 `fetchTitleViaTab` 的 try/catch 已合并
- [x] Task 4: 提交并推送 git
  - [x] SubTask 4.1: `git add` 相关文件，`git commit` 用中文消息开头是版本号
  - [x] SubTask 4.2: `git push origin main`

# Task Dependencies
- [Task 2] 和 [Task 1] 无依赖，可并行
- [Task 3] 依赖 [Task 1] 和 [Task 2]
- [Task 4] 依赖 [Task 3]
