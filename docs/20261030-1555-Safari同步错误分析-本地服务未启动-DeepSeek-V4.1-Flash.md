# Safari 同步错误分析：本地同步服务没有启动（2026-10-30 15:55）

## 结论先说

**这不是 Safari 的兼容性问题，是同步服务端没在跑。**

扩展配置的服务器是 `http://127.0.0.1:8787`，而本机 8787 端口当前没有任何进程监听。
Safari 的 `fetch` 连接被拒绝后，WebKit 统一报一句 `Load failed`，
这个字符串被原样存进了同步状态，于是新标签页弹「同步失败：Load failed · http://127.0.0.1:8787/v1/sync/state」。

Chrome 走同一条代码路径，只是它把同一件事报成 `Failed to fetch`。所以这是**服务端缺失**，不是浏览器差异。

## 证据链

### 1. 扩展里存着错误状态

Safari 扩展的存储（`LocalStorage.db` → `homepage_sync_state`）：

```json
{
  "status": "error",
  "lastError": "Load failed · http://127.0.0.1:8787/v1/sync/state",
  "lastPullAt": 1793208190925,
  "lastPushAt": 1793208190951,
  "lastRemoteRevision": 91,
  "lastRemoteEtag": "\"26f974ab364672d5e0805723deda40e7\"",
  "docId": "doc_13d6ed8f6e144b6d9e56335903079f8c"
}
```

`lastRemoteRevision = 91` 和 etag 都在，说明**以前是同步成功的**，不是从没通过。

### 2. 端口确实没人监听

```bash
lsof -nP -iTCP:8787 -sTCP:LISTEN     # 无输出
curl -m 3 http://127.0.0.1:8787/v1/sync/state   # exit=7（连接被拒绝）
```

### 3. 时间线对得上

- 开机时间：**2026-10-29 10:06**
- 最后一次同步时间戳：**2026-10-29 01:23**（重启之前）

也就是说：重启之前服务还在（可能是手动 `npm run sync-server` 起的），重启之后没人把它拉起来。

### 4. 本机没有托管服务

`launchctl list` 里只有 `com.aeroluna.homepage.safari-signing-refresh`（Safari 签名续期），
没有任何同步服务条目。`scripts/setup-sync-server.sh` 是给 **Ubuntu + systemd** 用的，
macOS 上没有对应的开机自启。

## 为什么提示是 "Load failed" 而不是「连不上服务器」

`src/js/sync_http_transport.js` 的 catch：

```js
const detail = e?.name === "AbortError" ? "请求超时（10 秒）" : e?.message || String(e);
return { ok: false, reason: "network_error", error: `${detail} · ${url}` };
```

它直接把 `e.message` 当文案。WebKit 对**所有**网络层失败（连接被拒、DNS 失败、CORS 拒绝、断网）
都只给一句 `Load failed`，没有任何区分度。这是本次排查唯一费劲的地方——文案本身不指向根因。

## 影响

- 同步状态一直是 `error`；错误持续 10 分钟后，新标签页弹提示条（`sync-banner.js`）。
- 本地改动进入 outbox 排队（当前 **1 条**待推），不会丢；服务恢复后会自动补推。
- 多设备之间不会互相更新。

## 恢复

在 `~/code/homepage` 下启动服务：

```bash
npm run sync-server
```

如果服务端之前设置过 `TOKEN` 环境变量，启动时要带同一个值：

```bash
TOKEN=<原值> npm run sync-server
```

起好之后，在新标签页点提示条上的「立即重试」，或等一个同步周期（默认间隔）自动恢复。
验证服务是否真的起来了：

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8787/health   # 期望 200
```

## 长期方案（避免下次重启又断）

三条路，按省事程度排：

1. **本机 launchd 自启（推荐给本机自用）**
   写一个用户级 `LaunchAgent`，登录即启动 `node scripts/sync-server.mjs`，崩溃自动拉起。
   好处：不用记着手动开；坏处：只在这台 Mac 上有效。
   可以直接复用 `scripts/setup-safari-signing-refresh.sh` 那套 `install/status/uninstall/logs` 的管理方式。

2. **放到已有的 Ubuntu 服务器**
   仓库里已经有 `scripts/setup-sync-server.sh`（systemd 托管），一条命令装好。
   好处：多设备共用、关机也不影响；代价：要给服务器配 HTTPS 证书，客户端 URL 要改成域名。

3. **维持手动**
   每次重启后自己 `npm run sync-server`。最省事，但这次的故障就是它导致的。

## 顺带值得改的代码（两处，都很小）

1. **网络错误分类**
   在 `sync_http_transport.js` 里把 `TypeError`（`Load failed` / `Failed to fetch`）映射成
   `无法连接同步服务器（连接被拒绝或网络不可达）`，并保留 URL。
   这样下次同类故障，提示条直接告诉用户「服务没开」，不用再像今天这样翻存储。

2. **设置页加「测试连接」**
   调 `GET /health`，把结果分成「连不上 / 401 / 正常」三种显示。
   成本很低，但能把「服务没启动」和「令牌不对」一眼分开。
