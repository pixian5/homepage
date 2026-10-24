# Safari 无描述文件在 macOS 27 失效，数据通路复测（2026-10-24 22:51）

版本：25.9.6。环境：macOS 27.0.1（Darwin 27.0.0）、Safari 27.0.1、Xcode 27 SDK。
本文记录本轮“核对安装版本 → 数据保存 → 恢复”实测的结论，并修正 2026-10-08 的一条错误结论。

## 一、安装版本核对

| 项目 | 结果 |
|------|------|
| 仓库版本（VERSION / package.json / 三端清单） | 25.9.6 |
| 重建前 `/Applications` 与 `dist` | 仍是 25.9.3，落后仓库 |
| 本轮重建后 `dist/*.zip`、`dist/*.xpi` | 25.9.6 |
| 本轮重建后 `/Applications/我的首页 Safari.app` | 25.9.6 |
| `pluginkit` 注册 | 仅 1 条，25.9.6，指向 /Applications |

重建使用 `SKIP_BUMP=1`，没有递增版本：本轮只验证既有 25.9.6 代码，不改源码。

### 构建受阻与绕过

`dist/build-macos.command` 的 Xcode 步骤失败：

```
error: No Accounts: Add a new account in Accounts settings.
error: No profiles for 'com.aeroluna.homepage.safari.extension' were found
```

Xcode 当前没有登录任何 Apple 账户，`~/Library/Developer/Xcode/UserData/Provisioning Profiles`
为空，磁盘上也找不到可用的 `.provisionprofile`。因此改用：

1. `xcodebuild ... CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO` 先编译出 `.app`；
2. 从旧的 25.9.3 安装件读出宿主与扩展的 entitlements（备份在
   `.test-backups/write-test-20261024-203416/signing/`），对 `.appex`、`.app` 由内向外重新签名；
3. 校验深度签名、应用组权限后安装到 `/Applications`。

签名与安装均通过，扩展新标签页正常显示（标题「我的首页」，33 个卡片）。

## 二、关键发现：无描述文件在 macOS 27 会被秒杀

### 现象

| 探针 | 结果 |
|------|------|
| 直接执行 `/Applications/我的首页 Safari.app/Contents/MacOS/我的首页 Safari` | **exit=137（SIGKILL）** |
| 直接执行扩展 `.appex` 内的可执行文件 | **exit=137（SIGKILL）** |
| 旧备份（25.9.3，内嵌 2026-10-15 到期的 profile） | 同样 exit=137 |
| 把 `.appex` 重新签成“只保留 get-task-allow、去掉沙箱与应用组” | **不再被杀**，退出 134 并提示 “An XPC Service cannot be run directly.” |
| Safari 内 `chrome.runtime.sendNativeMessage` | `RBSLaunchRequest ... Launch failed ... launchd job spawn failed` |

结论：**在 macOS 27 上，带 App Sandbox 或 App Group 这类受限 entitlement 的 bundle，
如果没有有效的内嵌描述文件，launchd/AMFI 会直接 SIGKILL；这与 macOS 26 上的旧结论相反。**
去掉受限 entitlement 后进程可以正常启动，说明问题不是手工签名本身。

### 对旧文档的修正

[去掉描述文件免 7 天续期](20261008-2150-去掉描述文件免7天续期-GPT-6.md) 的 I/J 组实验
只证明了“`.app` bundle 在 macOS 26 上无 profile 也能启动”。macOS 27 收紧了校验，
该结论不再成立；而且 `.appex` 由 launchd 以插件方式启动，实际更接近“裸 Mach-O”的
受检路径，本来就不能套用 `.app` 的结论。

另外，[App Group 数据共享验证](20261008-2130-AppGroup数据共享验证-GPT-6.md) 中
“新标签页能看到书签 ⇒ App Group 通”的推断不成立：那些书签来自 Safari WebExtension
自己的 SQLite 存储，不是 App Group 文件。实际 App Group 文件从 2026-08-14 起就没有再更新。

## 三、数据通路复测

### 主存储（Safari WebExtension SQLite）：通过

| 测试 | 操作 | 结果 |
|------|------|------|
| 写入 | 在扩展页写入临时书签 `__WRITE_TEST__` | 节点数 45 → 46，分组节点 3 → 4 |
| 刷新 | `location.reload()` | 数据仍在 |
| 重启 | 退出并重开 Safari | 数据仍在（46 节点） |
| 清理 | 删除临时节点 | 回到 45 节点 |

### 导出 / 导入 / 备份恢复（真实 UI 处理函数）：通过

通过页面内的真实按钮与事件处理器驱动（`#btnExport`、`#btnImport`、`.backup-restore`）：

| 测试 | 操作 | 结果 |
|------|------|------|
| 导出 | 点击「设置 → 导出」 | 剪切板得到 96 KB JSON，45 节点、6 个备份、schemaVersion 1 |
| 导入（覆盖） | 把 `fontSize` 改为 17 后导入 | 存储与界面变为 17，节点数仍 45 |
| 备份恢复 | 恢复最新备份（fontSize 19） | 恢复为 19，节点 45，备份仍 6 |
| 重装恢复 | 本轮重装 25.9.6 + 重启 Safari | 45 个节点、6 个备份、fontSize 19 全部保留 |

测试数据已清理；本轮前后用户数据一致（45 节点、1 个分组、6 个备份、fontSize 19）。
原始文件与导出件保存在 `.test-backups/write-test-20261024-203416/`（已被 git 忽略）。

### App Group 兜底文件：写入失败

```
~/Library/Group Containers/group.com.aeroluna.homepage.safari/homepage-data.json
mtime = 2026-08-14 16:15:54，44 节点，size 36685
```

写入测试后该文件完全不变；`sendNativeMessage` 报 `RBSLaunchRequest ... Launch failed`。
原因是原生处理器所在的 `.appex` 无有效描述文件，被系统拒绝启动，于是
`writeSafariStableHomepage()` 永远失败，而 `saveData()` 忽略返回值，页面没有任何提示。

当前风险：如果 Safari 的 WebExtension 存储被系统清理，兜底文件会恢复成 8 月 14 日的旧数据，
比现状少 1 个节点。主存储目前健康，但兜底不等于可用。

## 四、可选修复路线

### A. 重新登录 Xcode，恢复内嵌描述文件

- 需要用户在有图形界面的 Xcode「设置 → 账户」登录 Apple ID（免费账户即可）。
- 之后正常跑 `bash dist/build-macos.command`，Xcode 会签发 7 天有效的 profile。
- 优点：保留沙箱与 App Group，原生消息、宿主 App、兜底写入全部恢复。
- 缺点：回到 7 天续期；现有 `scripts/safari-refresh-signing.sh` 与 launchd 定时任务可继续使用，
  但必须设 `SAFARI_STRIP_PROFILE=0`，不能再剥掉描述文件。

### B. 去掉沙箱与 App Group，改用普通共享文件

- `.app` 与 `.appex` 只签 `get-task-allow`（或空 entitlements），不再需要 profile，也就没有 7 天续期。
- Swift 原生处理器改为读写 `~/Library/Application Support/我的首页/homepage-data.json`；
  宿主 App 使用同一路径。
- 优点：免描述文件、免续期，符合“免费账号长期可用”的目标。
- 缺点：失去 App Sandbox（安全边界变弱），不能上架 App Store；需要改 Swift 模板、工程 entitlements、
  构建脚本，并重新验证原生消息。按项目规则可先备份旧数据再重构，不考虑旧数据兼容。

### C. 暂不修，只保留 WebExtension 存储

- 移除或明确标注“App Group 兜底不可用”，避免文档继续误导。
- 优点：零改动。
- 缺点：重装/系统清理后仍有丢数据风险，兜底形同虚设。

**待用户决定。** 在决定前，`.app` 保持当前 25.9.6 安装状态：扩展可用，宿主 App 无法打开，
App Group 兜底不写入。

## 五、复现命令

```bash
# 检查安装版本与签名
/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' \
  '/Applications/我的首页 Safari.app/Contents/Info.plist'
python3 scripts/safari-signing-status.py

# 复现 SIGKILL（137）
'/Applications/我的首页 Safari.app/Contents/MacOS/我的首页 Safari'; echo $?

# 查看 App Group 兜底文件时间
stat -f '%Sm %z %N' -t '%Y-%m-%d %H:%M:%S' \
  "$HOME/Library/Group Containers/group.com.aeroluna.homepage.safari/homepage-data.json"
```

## 相关文档

- [去掉描述文件免 7 天续期](20261008-2150-去掉描述文件免7天续期-GPT-6.md)（结论已在 macOS 27 上失效）
- [App Group 数据共享验证](20261008-2130-AppGroup数据共享验证-GPT-6.md)（读取结论需修正）
- [配置文件为何必需与去掉 7 天续期路线](20261008-2135-配置文件为何必需与去掉7天续期路线-GPT-6.md)
- [免费账号签名自动续期](20261008-2100-免费账号签名自动续期-GPT-6.md)
