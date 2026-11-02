# Chrome 永久误报「同步已多次失败，自动重试已停止」（2026-11-02 17:25）

## 结论

**当前同步是健康的，横幅是误报。**
根因是存储里躺着一条 **2026 年 7 月** 的旧队列项，它的目标是已经废弃的浏览器 `storage.sync`，
这条记录永远发不出去，也没人清得掉，于是提示条按「队列重试已耗尽」永久亮着。

## 取证过程

### 1. 服务端没问题

```
launchd 任务 com.aeroluna.homepage.sync-server : running（pid 88308，10-30 起连续运行）
端口 : node 127.0.0.1:8787 LISTEN
/health : 200
```

### 2. 同步状态也没问题

`homepage_sync_state`（Chrome）：

```
status             : idle
lastError          : (空)
lastPullAt         : 2026-11-01 12:02:24
lastRemoteRevision : 75
```

拉取正常、状态正常——所以横幅不是由 `status === "error"` 触发的。

### 3. 横幅只可能来自「队列耗尽」分支

`sync-banner.js` 的判定：

```js
const exhausted = outbox.some((item) =>
  Number(item?.attempts || 0) >= Number(item?.maxAttempts || 12));
if (exhausted) return { show: true, reason: "outbox_exhausted" };
```

而 `getOutboxSummary()` 返回的是存储里**全部**队列项。

### 4. 队列项藏在压缩的 SST 里

Chrome 的 `storage.local` 是 LevelDB，`.ldb` 数据块用 snappy 压缩，`grep`/`strings` 都看不见。
本机没有 snappy 库，于是临时写了个纯 Python 的 snappy + LevelDB 表解析器（`/tmp/ldb_dump.py`），
从 `000558.ldb` 里挖出这条记录：

```json
[{
  "targetKey": "storage.sync|homepage",
  "attempts": 12,
  "lastError": "Failed to fetch",
  "createdAtMs": "2026-07-23 12:02:15",
  "lastAttemptAtMs": "2026-08-06 14:15:16",
  "nextRetryAtMs": "2026-08-06 14:36:36",
  "payload": { ... 45 个节点的完整快照 ... }
}]
```

这条记录最后一次写入是 10-30 18:51，此后三个月没动过。

## 为什么它清不掉

| 环节 | 行为 |
|---|---|
| 当前传输目标 | `SYNC_OUTBOX_TARGET = "http-server\|homepage"` |
| 这条记录的目标 | `storage.sync\|homepage`（早期走浏览器 sync 时留下的） |
| `clearOutboxSuccess()` | 只删 `targetKey === 当前目标` 的项 → **删不到它** |
| `flushOutbox()` | 只找当前目标的项 → **永远不会重试它** |
| `getOutboxSummary()` | 返回全部项 → **横幅看得见它** |

三个环节各做对了一半，合起来就是：一条永远发不出去、永远不清、永远被展示的僵尸记录。

## 修法

新增 `filterCurrentOutbox()`，只保留当前传输目标：

```js
function filterCurrentOutbox(list) {
  return (Array.isArray(list) ? list : [])
    .filter((item) => item.targetKey === SYNC_OUTBOX_TARGET);
}
```

接在两处：

1. `getOutboxSummary()` —— 横幅再也看不到废弃目标的记录；
2. `loadState()` —— 加载时顺手把僵尸项从存储里**物理删除**（长度变化才写，只发生一次）。

## 回归测试

`tests/sync-engine.test.js` 新增 `sync_engine outbox hygiene`：
存储里同时放一条 `storage.sync|homepage`（attempts 12）和一条 `http-server|homepage`，
`getOutboxSummary()` 必须只返回后者。

全量：**252 项全过**；`npm run check` 85 个文件无告警。

## 为什么只有 Chrome 中招

Safari 的队列是空的（`[]`），没有这条历史包袱；火狐同理。
Chrome 恰好从 7 月那个版本一直用到现在、中间经历过传输方式切换，所以把旧记录带进了新世界。

## 生效后

- 横幅消失（Chrome 刷新扩展即生效）。
- 以后不会再出现「明明同步正常却一直提示失败」的情况。
- 若还有真实失败，`flushOutbox` 仍会正常记录 error 并提示——这次只屏蔽「废弃目标」这一类噪音。

## 版本

26.5.9 → **26.6.0**
