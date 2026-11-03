# Safari 扩展又「消失」了：包还在，注册没了（2026-11-03 15:25）

## 现象

Safari 里看不到「我的首页」，新标签页变回系统默认页。

## 取证：包是完好的，掉的是系统注册

| 检查 | 结果 |
|---|---|
| `/Applications/我的首页 Safari.app` | 存在，版本 26.5.5 |
| 内嵌 appex | 存在 |
| 签名 | `Identifier=com.aeroluna.homepage.safari`、`TeamIdentifier=WY97WQFBKC` |
| 深度校验 | `valid on disk` / `satisfies its Designated Requirement` |
| 内嵌描述文件 | 无（方案 B 生效中） |
| `pluginkit -m -A -v` | **完全查不到**（连禁用项都没有） |
| LaunchServices | 有 18 条相关记录（App 本身是认识的） |
| Safari `Extensions.plist` | `Enabled: True`，但 **`RemovedDate: 2026-11-03 07:12:39 UTC`（本地 15:12）** |

结论：**不是包坏了，是扩展的内嵌插件（appex）在系统注册表里被摘掉了**。
Safari 侧因此把它标记成「已移除」，界面上就当作没装过。

## 修复（三步，全部幂等）

```bash
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
APP="/Applications/我的首页 Safari.app"
EX="$APP/Contents/PlugIns/我的首页 Safari Extension.appex"

"$LSREGISTER" -f "$APP"                                  # 刷新 LaunchServices
pluginkit -a "$EX"                                       # 重新注册 appex
pluginkit -e use -i com.aeroluna.homepage.safari.extension   # 显式启用
```

执行后：

```
+  com.aeroluna.homepage.safari.extension(26.5.5)  ...  /Applications/.../我的首页 Safari Extension.appex
```

`+` 表示已启用。重开 Safari 后 `Extensions.plist` 变成 `Enabled: True / Removed: None`，扩展回来了。

## 自动化：新增 `scripts/safari-repair-registration.sh`

幂等，可反复执行：

```bash
bash scripts/safari-repair-registration.sh            # 修复
bash scripts/safari-repair-registration.sh --dry-run  # 只检查
bash scripts/safari-repair-registration.sh --quiet    # 静默（给定时任务用）
```

内置四道检查：

1. `/Applications` 里的 App 是否存在；
2. 内嵌 `.appex` 是否存在；
3. `codesign -v` 签名是否有效（无效则提示重建，不再乱注册）；
4. 注册后用 `pluginkit -m -A` 复查，确认真的回到列表。

### 挂进已有的每日体检

`safari-refresh-signing.sh`（launchd 每天 09:00 / 21:00 跑）开头新增一次自愈调用：

```bash
bash "${SCRIPT_DIR}/safari-repair-registration.sh" --quiet || true
```

这样「包在、注册丢」的状态最多存活半天，而不是等用户发现。

## 一个值得记住的坑

脚本第一版用 `pluginkit ... | grep -q "${EXT_ID}"` 判断是否已注册，结果**误判成「未注册」**——
`grep -q` 匹配到就立刻退出，`pluginkit` 收到 SIGPIPE，在 `set -o pipefail` 下整条管道返回失败。
改成先捕获输出再判断：

```bash
BEFORE="$(pluginkit -m -A -v 2>/dev/null | grep "${EXT_ID}" || true)"
[[ -n "${BEFORE}" ]]
```

任何 `set -euo pipefail` 的脚本里，`cmd | grep -q` 都是同一颗雷。

## 遗留：新标签页覆盖需要重新选一次

`Extensions.plist` 里 `IdentifierOfExtensionWithOverridePageForNewTabs` 在移除时被清空了。
注册恢复后，如果新标签页还是系统默认页，需要在
**Safari → 设置 → 扩展 → 我的首页** 里重新选择「覆盖新标签页」。
这是 Safari 的用户级授权，脚本无法代为设置。

## 为什么会掉注册（尚未完全确定）

包没有被替换（mtime 是 11-01 01:13，不是今天），签名也一直有效。
最可能是 LaunchServices / pluginkit 数据库在做清理时把这条记录丢了，
或者上一次替换 App 时旧记录被注销、新记录没写进去。

不论原因，**这个自愈脚本都能兜住**——因为它只依赖「App 包还在」这一个前提。

## 版本

26.6.0 → **26.6.1**
