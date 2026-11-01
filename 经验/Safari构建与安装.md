# Safari 构建与安装经验

## 正确入口

- `dist/build.sh` 负责生成 Chrome、Firefox、Safari 扩展包和 Safari Xcode 工程。
- `scripts/build-macos.command` 才是完整 Safari 流程：Xcode 编译、手工签名、安装、注册、存储校验和新标签页选择校验。
- 不要把扩展包构建成功当成 Safari 宿主 App 安装成功。

## Xcode 工程格式

- 旧 converter 生成 `project.pbxproj`。
- Xcode 27.2 converter 可能生成带尾随逗号的 JSON 风格 `project.xcproj`。
- 构建脚本必须按 target 名称分别配置宿主 App 和 Extension，不能硬编码只处理 PBX 工程。
- JSON 工程修改前要兼容尾随逗号，修改后校验 Bundle ID、版本和 entitlements。

## 签名与存储

- 宿主 App 无 App Sandbox；Safari Extension 保留 sandbox，并使用共享目录例外。
- 安装前后比较共享数据文件的哈希、节点数、分组数和备份数。
- 构建产物副本应从 LaunchServices 中清理，避免出现重复扩展条目。
- `CoreSimulator` 版本警告不等于 macOS 构建失败；以 `BUILD SUCCEEDED`、签名验证和安装校验为准。

## 推荐命令

```bash
SKIP_BUMP=1 bash dist/build.sh
SKIP_BUMP=1 NO_PAUSE=1 SAFARI_LAUNCH_AFTER_BUILD=0 bash scripts/build-macos.command
```

完整流程至少检查：三端 zip、Safari App 签名、appex 注册、共享数据哈希和新标签页/新窗口接管。
