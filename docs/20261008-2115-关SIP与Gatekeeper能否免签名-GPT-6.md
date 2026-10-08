# 关掉 SIP 与 Gatekeeper，能免签名直接用吗？（实测：不能）

> 记录时间：2026-10-08 21:15　模型：GPT-6
> 触发问题：新电脑上 Gatekeeper 和 SIP 都关闭的情况下，是不是不用做任何签名操作就能直接用？

## 一句话结论

**不能。关 SIP 和关 Gatekeeper 都不解除代码签名强制。**
本机实测：在 **SIP 已关闭 + Gatekeeper 已关闭** 的状态下，adhoc（无证书）签名一旦带上 App Sandbox，
进程照样被系统杀掉（exit 133）。代码签名强制由 **AMFI**（Apple Mobile File Integrity，苹果移动文件完整性）
负责，它独立于 SIP，关 SIP 不会连带关掉它。

## 实测环境（先看清楚这台机器的真实状态）

| 项目 | 实测值 |
|------|--------|
| 系统版本 | macOS 27.0.1 |
| Gatekeeper | `assessments disabled`（**已关**） |
| SIP | `System Integrity Protection status: disabled.`（**已关**） |
| `boot-args` | 未设置 → **AMFI 未被关闭** |
| `amfid` 守护进程 | 2 个进程在运行 → AMFI 用户态校验**仍在工作** |

也就是说，用户设想的「双关」条件在本机已经完全满足，可以直接验证。

## 实测矩阵（在 SIP 关 + Gatekeeper 关的状态下跑的）

用同一个 Swift 探针（尝试写入 App Group 容器），只改签名方式：

| 序号 | 签名方式 | App Sandbox | App Group | 结果 |
|------|----------|-------------|-----------|------|
| 1 | adhoc（`codesign -s -`） | 是 | 否 | **exit=133，被杀，零输出** |
| 2 | adhoc | 是 | 是 | **exit=133，被杀，零输出** |
| 3 | adhoc | 否 | — | 正常运行，exit=0 |
| 4 | 完全不签名 | — | — | 正常运行，exit=0 |

**读法**：

- 第 1、2 行是决定性证据。SIP 和 Gatekeeper 都关着，adhoc + 沙箱**照样死**。
  所以「关了就免签名」这个假设在实测面前不成立。
- 第 3、4 行看似「成功」，但**不能用**：它们能跑恰恰是因为**没有沙箱**。
  而 Safari 的 `.appex`（应用扩展）强制启用 App Sandbox，这个开关关不掉。
  一个没有沙箱的进程能跑，不代表 Safari 会加载一个没有沙箱的扩展。

## 为什么关 SIP 没用：三道彼此独立的门禁

很多人把这三件事混为一谈，它们其实各管一段：

| 门禁 | 开关方式 | 实际管什么 |
|------|----------|-----------|
| **Gatekeeper** | `spctl --master-disable` | 只管「从网上下载的应用首次打开」的评估。不管运行时代码签名。 |
| **SIP** | Recovery 里 `csrutil disable` | 只管系统路径（`/System`、`/usr`）保护、`task_for_pid`、调试注入。不管签名。 |
| **AMFI** | `nvram boot-args="amfi_get_out_of_my_way=1"` | **管代码签名与 entitlement 强制**。这才是拦我们的那道。 |

关键点：**关 SIP 只是让你「有资格」去设置 boot-args 关 AMFI，它本身不会关掉 AMFI。**
因为设置 `boot-args` 在 SIP 开启时是被阻止的。所以「关 SIP」只是通往「关 AMFI」的前置步骤，不是终点。

AMFI 自身还分两层：

| 层 | 组件 | 检查内容 | 能否绕过 |
|----|------|----------|----------|
| 内核层 | `AMFI.kext` | 受限 entitlement（`com.apple.private.*`） | **即使关掉 SIP 也无法绕过** |
| 用户态层 | `amfid` 守护进程 | 代码签名解析、cdhash 计算、entitlement 验证 | 需 `amfi_get_out_of_my_way=1` |

## 就算把 AMFI 也关了，还剩两道坎

1. **Safari 的 `.appex` 强制 App Sandbox。** 这是 Apple 对 App Extension 的硬性要求，
   不是本项目能选的配置。当前正式扩展的 entitlements 里就带着 `com.apple.security.app-sandbox`。
2. **App Group 需要 Team ID。** adhoc 签名没有 Team Identifier，
   拿不到 `com.apple.security.application-groups` 授权 → 宿主 App 与扩展之间数据不通，功能直接残缺。
   - 补充实测细节：无沙箱进程确实能直接写进 `~/Library/Group Containers/...` 目录（因为没有沙箱拦它），
     但这**不代表**沙箱内的扩展能访问——沙箱内进程必须有 entitlement 授权。别被这个假象误导。

## 代价对比：这笔账不划算

| 方案 | 安全性代价 | 维护成本 |
|------|-----------|----------|
| 关 SIP + 关 AMFI | **全局**：任意进程可篡改系统文件、注入守护进程、绕过文件系统保护、执行任意未签名代码；TCC 权限弹窗也会失效 | 需重启进 Recovery 操作；系统升级后 boot-args 可能失效要重来 |
| 免费 Apple ID 签名 | **无**（本机开发签名，系统安全模型完整保留） | 已自动化：launchd 每天 09:00/21:00 自动续期，用户完全无感 |

对比之下结论很直白：签名是**免费的**，而且已经被自动化到不需要你管；
关 SIP 是拿整台机器的安全边界去换一个本来零成本的东西。

## 建议动作

1. **把 SIP 开回来**：重启按住 `Command+R` 进 Recovery → 实用工具 → 终端 → `csrutil enable` → 重启。
2. **把 Gatekeeper 开回来**：`sudo spctl --master-enable`。
   （之前已经确认过：本地 Xcode 构建产物不带 `com.apple.quarantine`，本来就不会被 Gatekeeper 拦，
   当初关它是多余的。）
3. 签名续期交给 `scripts/setup-safari-signing-refresh.sh` 装的定时任务，不用手动管。

## 什么情况下才该考虑关 SIP

基本只有内核扩展（KEXT）开发、安全研究、越狱/虚拟化这类场景。
日常自用 App + Safari 扩展**不在其中**。

## 相关文档

- [免签名与 adhoc 可行性实测](20261008-2046-免签名与adhoc可行性实测-GPT-6.md) — 首轮探针矩阵，结论一致
- [免费账号签名自动续期](20261008-2100-免费账号签名自动续期-GPT-6.md) — 零成本替代方案，已落地
- [Safari 扩展换机重签名](20261008-1956-Safari扩展换机重签名-GPT-6.md) — 换机时的正规流程
