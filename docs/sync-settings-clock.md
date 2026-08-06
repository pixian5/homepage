# 同步设置项独立时钟

## 背景

旧同步合并逻辑用远端 `SyncDocument.writtenAt` 与本机 `lastUpdated` 裁决整份 `settings`。这会导致一个问题：远端设备只修改书签时，远端文档时间也会更新，随后它携带的旧设置可能覆盖本机较新但尚未推送的设置。

## 方案

- 本地完整状态仍以 `storage.local` 为权威工作副本。
- 每个可同步设置项在 `data._syncMeta.settingsClock` 中记录独立时间戳与设备 ID。
- 同步投影把该元数据写入 `SyncDocument.settingsMeta`。
- 合并时只比较同一个 setting key 的 clock，不再用整份文档时间覆盖全部设置。
- 旧版远端缺少 `settingsMeta` 时，只补本地缺失字段，不覆盖本地已有设置。
- 同步只走 HTTP 服务器；`syncServerToken`、服务器地址和同步开关均为本机配置，不进入同步投影。

## 合并规则

1. 本地和远端都有 clock：`updatedAt` 大者胜；相同时间用 `updatedBy` 做确定性裁决。
2. 远端有 clock、本地无 clock：接受远端，表示另一端已升级并明确修改过该设置。
3. 远端无 clock：只填充本地缺失字段，保护本机现有设置。
4. `syncEnabled` 继续以本机开关为准，避免远端关闭同步后锁死本机。

## 验证

覆盖的回归场景：

- 远端书签更新不覆盖本机较新设置。
- 远端较新的单个设置只覆盖该设置，不影响其它本机较新设置。
- 旧版远端缺少设置 clock 时不会覆盖本地已有设置。
- `syncServerToken`、`syncServerUrl`、`syncEnabled` 和 `syncInterval` 不进入 `SyncDocument.settings` 或 `settingsMeta`。
