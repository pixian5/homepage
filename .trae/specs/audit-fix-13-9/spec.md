# 13.9 复核修复 Spec

## Why
对上一轮 13.9 修复做深度复核，确认修复是否成功落地、是否引入副作用，并扫描当前项目是否还有遗漏的真实问题。复核发现 2 个真实存在的问题需要修复：`fetchTitleViaTab` 的 try/catch 遗漏、Safari Xcode 旧 build 产物残留陈旧资源。

## What Changes
- 修复 `src/js/app.js` 中 `fetchTitleViaTab` 函数：把 `api.tabs.onUpdated.addListener(onUpdated)` 包进 try/catch，同步抛错时调 `finish("")` 安全收尾，避免触发 `error-bootstrap.js` 弹出"加载失败"面板。
- 修复 `scripts/build.sh`：在 `build_safari_project` 函数末尾加 `rm -rf "${SAFARI_PROJECT_DIR}/build"`，让 `npm run build` 也清理 xcodebuild 旧产物，避免 `dist/safari-app/build/` 残留陈旧 .appex（含已删除的孤立模块和旧版本号 manifest）。
- 版本号 bump 到 13.10（满十进一）。

## Impact
- Affected code:
  - `src/js/app.js`（`fetchTitleViaTab` 函数，约第 3378-3399 行）
  - `scripts/build.sh`（`build_safari_project` 函数末尾）
  - `package.json` + 三端 `manifest.*.json`（版本号）

## ADDED Requirements
### Requirement: fetchTitleViaTab 同步异常安全
`fetchTitleViaTab` 中 `api.tabs.onUpdated.addListener` 调用 SHALL 包在 try/catch 内，catch 分支 SHALL 调用 `finish("")` 安全清理（移除监听器、关闭标签、resolve 空字符串），不得让同步异常冒泡到 `error-bootstrap.js`。

#### Scenario: addListener 同步抛错
- **WHEN** `api.tabs.onUpdated.addListener(onUpdated)` 因权限被收回或 API 异常同步抛错
- **THEN** catch 分支调用 `finish("")`，标签被 `api.tabs.remove` 关闭，Promise resolve 空字符串，不触发全局 error 面板

### Requirement: npm run build 清理 Safari Xcode 旧产物
`scripts/build.sh` 的 `build_safari_project` 函数 SHALL 在返回前 `rm -rf "${SAFARI_PROJECT_DIR}/build"`，确保 `dist/safari-app/build/` 不残留上次 xcodebuild 的陈旧 .appex 产物。

#### Scenario: npm run build 后无陈旧产物
- **WHEN** 执行 `npm run build`
- **THEN** `dist/safari-app/build/` 目录不存在或为空，不包含任何 `.appex` 或陈旧 manifest.json

## MODIFIED Requirements
### Requirement: Safari 构建产物一致性
`scripts/build.sh` 执行后，`dist/safari/`（扩展资源源）与 `dist/safari-app/Shared (Extension)/Resources/`（Xcode 工程资源）SHALL 通过 `rsync --delete` 保持一致；`dist/safari-app/build/`（xcodebuild 编译产物）SHALL 不残留上次编译的陈旧资源。
