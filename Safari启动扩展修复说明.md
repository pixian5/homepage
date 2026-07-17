# Safari 启动时不显示扩展页面的说明

## 问题原因

这是 Safari 本身的限制，不是扩展 bug：

- `chrome_url_overrides.newtab` 只能覆盖 **新建标签页（⌘T）** 和 **新建窗口（⌘N）**
- Safari 偏好设置里的 **"启动 Safari 浏览器时打开"** 下拉框不支持扩展覆盖页
- 所以启动时第一个窗口打开的是 Safari 原生页面（空白/收藏夹/起始页），而不是扩展

## 临时解决方案

### 方案 1：启动 Safari 后按 ⌘T
最简单，每次启动 Safari 后按一下 ⌘T，新标签页会显示扩展页面。

### 方案 2：使用 AppleScript 自动化

1. 脚本位置：`scripts/safari-launch-workaround.scpt`
2. 把它添加到 macOS 登录项：
   - 系统设置 -> 通用 -> 登录项
   - 添加 `scripts/safari-launch-workaround.scpt`
3. 每次登录 macOS 时，脚本会自动启动 Safari 并新建一个标签页，触发扩展显示

### 方案 3：手动打开脚本
双击 `scripts/safari-launch-workaround.scpt` 运行。

## 测试状态

- 当前扩展版本：15.8（回滚基线）
- 新标签页覆盖：正常
- 新建窗口覆盖：正常
- 启动时覆盖：受 Safari 限制，无法通过扩展代码实现
