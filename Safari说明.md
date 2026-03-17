# Safari 说明

## 1. 适用场景

本文档只说明本项目的 Safari 开发测试版用法，目标是：

- 在本机长期自用
- 通过项目内脚本直接构建
- 让 Safari 新标签页稳定接管到“我的首页”

## 2. 当前构建方式

项目内统一使用：

```bash
cd /Users/x/code/homepage
NO_PAUSE=1 ./dist/build-macos.command
```

这条命令会自动完成以下动作：

1. 版本号自动加 `0.1`
2. 构建 `dist/chrome`、`dist/firefox`、`dist/safari`
3. 复用并更新 `dist/safari-app` 下的 Safari Xcode 工程
4. 默认使用 Xcode `Release` 配置构建 Safari 宿主 App
5. 若本机钥匙串存在 `Apple Development` 证书，则自动对 Safari 宿主 App 和 `.appex` 进行二次开发签名
6. 结束旧的 `我的首页 Safari` 进程
7. 删除旧构建目录并启动新宿主 App

## 3. 为什么 Safari 版之前会失败

这次排查确认了两个关键原因：

### 3.1 Debug 产物会注入调试 dylib

Safari Web Extension 的 Debug 构建里会出现：

- `__preview.dylib`
- `*.debug.dylib`

这会让宿主 App 和扩展主程序依赖调试注入物，Safari 很容易出现：

- 新标签页空白
- 页面没有真正加载扩展资源
- 扩展接管看起来开启了，但实际还是起始页

所以现在脚本默认改成了 `Release` 构建。

### 3.2 `Sign to Run Locally` 会让 Safari 清空接管设置

只用 Xcode 默认的 `Sign to Run Locally` 时，Safari 虽然能看到扩展，但启动后会把“新标签页由扩展接管”的内部记录清空。

这次已验证可用的方案是：

- 先用 Xcode `Release` 产出干净的宿主 App
- 再用本机 `Apple Development` 证书对宿主 App 和 `.appex` 做二次开发签名

当前脚本已经自动完成这一步。

## 4. 当前成功条件

当前可用链路满足以下条件：

- 宿主 App 路径：
  - `/Users/x/code/homepage/dist/safari-app/build/Build/Products/Release/我的首页 Safari.app`
- 宿主 App 已启动
- 扩展 bundle id：
  - `com.aeroluna.homepage.safari.extension`
- 实际签名团队号：
  - `PSTNW3UN4R`
- Safari 新标签页实际 URL 会变成：
  - `safari-web-extension://.../newtab.html`

## 5. 安装与启用

### 5.1 构建并启动宿主 App

```bash
cd /Users/x/code/homepage
NO_PAUSE=1 ./dist/build-macos.command
```

### 5.2 在 Safari 中启用

1. 打开 Safari
2. `Safari -> 设置 -> 扩展`
3. 启用 `我的首页`
4. 打开 `Safari -> 设置 -> 通用`
5. 确认：
   - `新建窗口时打开` = `我的首页`
   - `新建标签页时打开` = `我的首页`

## 6. 长期自用建议

如果你是自己在这台 Mac 上长期使用，推荐始终走项目内脚本，不要直接依赖 Xcode 的 Debug 运行按钮。

推荐流程：

```bash
cd /Users/x/code/homepage
NO_PAUSE=1 ./dist/build-macos.command
```

原因：

- 这条命令已经固定走 `Release`
- 会自动重签 Safari 宿主 App
- 会结束旧程序并启动新程序
- 不需要手动把 App 拖到“应用程序”目录

## 7. 出问题时先检查什么

### 7.1 新标签页又变回起始页

先确认宿主 App 是否还在运行：

```bash
ps aux | rg --pcre2 '我的首页 Safari(?! Extension)'
```

如果宿主 App 没在运行，Safari 很可能回退到起始页。

### 7.2 构建后 Safari 又空白

先确认当前产物是否为 Release：

```bash
find /Users/x/code/homepage/dist/safari-app/build/Build/Products/Release -maxdepth 3 -name '*.app' -o -name '*.appex'
```

再确认没有调试 dylib：

```bash
find "/Users/x/code/homepage/dist/safari-app/build/Build/Products/Release/我的首页 Safari.app" -name '__preview.dylib' -o -name '*.debug.dylib'
```

正常情况下，这两个文件不应再出现。

### 7.3 签名是否正确

检查扩展团队号：

```bash
/usr/bin/codesign -dv --verbose=4 "/Users/x/code/homepage/dist/safari-app/build/Build/Products/Release/我的首页 Safari.app/Contents/PlugIns/我的首页 Safari Extension.appex" 2>&1 | rg 'Identifier=|TeamIdentifier=|Authority='
```

当前正确结果应包含：

- `Identifier=com.aeroluna.homepage.safari.extension`
- `TeamIdentifier=PSTNW3UN4R`
- `Authority=Apple Development: ...`

## 8. 当前结论

本项目 Safari 版现在的稳定链路是：

- 构建走 `Release`
- 构建后自动二次开发签名
- 再由 Safari 加载并接管新标签页

不要再回到只靠 `Sign to Run Locally` 的旧方式，否则 Safari 很可能再次清空新标签页接管状态。
