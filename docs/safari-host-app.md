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

## 扩展图标与重复注册

Safari 的扩展管理页读取嵌入 `.appex` 的原生 Bundle 图标，不读取 Web Extension `manifest.json` 的 `icons`。构建脚本会生成 `ExtensionIcon.icns`，将其登记到 Extension target 的 Resources 阶段，并在扩展 `Info.plist` 设置 `CFBundleIconFile`。验收时必须同时检查字段和安装包内的实际图标文件。

同一 Bundle ID 曾用不同开发团队或无签名构建时，Safari 的 `Extensions.plist` 会把它们视作不同身份，表现为多个同名扩展。`scripts/clean-safari-homepage-registrations.mjs` 只清理当前项目已确认的历史身份 `PSTNW3UN4R` 和 `UNSIGNED`，保留当前 `WY97WQFBKC` 及所有其他扩展。每个被修改的 plist 都会先在原目录生成带 UTC 时间戳的备份，并在原子替换前通过 `plutil -lint`。Safari 运行时会把内存中的旧状态写回，因此构建安装流程会先让 Safari 正常退出；单独运行清理命令时若 Safari 尚未退出则直接报错，不会制造清理成功的假象。

## 更新时的数据保护

主页业务数据不再只依赖 Safari 按扩展注册身份管理的 WebExtension SQLite。Safari 版会通过 `nativeMessaging` 把 `homepage_data` 同步写入稳定 App Group `group.com.aeroluna.homepage.safari` 的 `homepage-data.json`：

- 普通保存成功后双写 WebExtension local storage 与 App Group 文件。
- 新版本首次加载时，如果扩展 local storage 缺失、退回默认值，或快捷按钮/备份意外变空，而 App Group 副本保留有效数据，则自动恢复；空主页用户的设置和备份同样受保护。
- 用户主动“清空数据”时同步清除两处，避免把明确删除误判为更新丢失。
- App Group 权限必须同时存在于宿主 App 与嵌入扩展签名；构建脚本缺一即失败。

Safari 扩展更新的第一步必须是退出 Safari，并在任何 converter、Xcode 注册或 App 替换发生前运行 `scripts/safari-storage-guard.py snapshot`。快照同时保存结构化的全部 `extension_storage` 键值和 SQLite/WAL 原始文件，位置为忽略提交的 `.test-backups/safari-storage/`。

安装后必须运行 `verify --restore-on-regression`：Safari 在快照后保持退出，因此更新前后的 `homepage_data` 哈希必须完全一致；只要快捷按钮、设置、备份或其他字段被安装过程改写，就自动把结构化快照写回当前签名身份的数据库，并让构建失败报警。这样构建不能再把“扩展安装成功但用户数据被默认值替换”报告成成功。

## 新标签页接管

Safari 26 将扩展声明的 `chrome_url_overrides.newtab` 与用户实际选择的“新建标签页时打开”分开管理。仅检查 manifest、签名或扩展启用状态都不能证明 `Cmd+T` 会显示首页。

安装脚本在 Safari 已退出时，会将“新建标签页时打开”和“新建窗口时打开”重新关联到当前签名身份的 `我的首页`，然后用 `scripts/safari-newtab-selection.py verify` 校验两项偏好。该步骤只写 Safari 的两项入口选择，不读取或修改扩展书签数据。若校验失败，构建失败而不是把未接管的新标签页当作成功。
