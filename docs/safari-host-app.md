# Safari 宿主 App 行为

## 退出按钮

Safari Web Extension 转换出的宿主 App 会通过 `SFSafariApplication.showPreferencesForExtension` 打开扩展设置。旧逻辑在自动打开设置失败时会再尝试启动 Safari，并弹出“请手动打开 Safari 扩展设置”的提示。

当前产品行为改为：

- 成功打开 Safari 扩展设置后，宿主 App 直接退出。
- 自动打开失败后也直接退出。
- 不再弹出手动打开浏览器或扩展设置的提示框。

原因：用户点击 App 内退出/打开扩展设置动作后，不应再被二次弹窗打断；如果系统级权限或 Safari 自动跳转失败，保持安静退出更符合这个宿主 App 的注册工具定位。

## 维护位置

- 模板：`scripts/templates/safari/ViewController.swift`
- 当前生成工程：`dist/safari-app/我的首页 Safari/Shared (App)/ViewController.swift`

构建脚本会复用已有 Xcode 工程，所以修改此类宿主 App 行为时需要同时更新模板和当前生成工程源文件。

## 版本同步

构建时 `scripts/sync-safari-version.mjs` 会读取根目录 `package.json`，把扩展版本同步到 Safari Xcode 工程所有宿主和扩展配置的 `MARKETING_VERSION`。`CURRENT_PROJECT_VERSION` 使用相同版本转换出的单调数字，例如 `24.0 -> 2400`，避免 `.app`/`.appex` 长期停留在转换器默认的 `1.0 (1)`。
