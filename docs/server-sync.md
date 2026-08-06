# 服务器同步

## 当前策略

20.3 起客户端只使用自建 HTTP JSON 服务同步，不再读取或写入浏览器 `storage.sync`。完整工作副本始终保存在本机 `storage.local`，断网时照常编辑，联网后由同步引擎拉取、合并并重试推送。

仓库已有服务器组件：[scripts/sync-server.mjs](../scripts/sync-server.mjs)。它提供：

- `GET /health`
- `GET /v1/sync/state`
- `PUT /v1/sync/state`
- ETag / `If-Match` 并发保护
- 原子写入 JSON 状态文件
- 可选 Bearer Token 鉴权

当前没有单独的一键安装脚本。服务器只需要 Node.js，直接从项目运行即可。

## 本机启动

```bash
PORT=8787 TOKEN='请放入终端环境变量' npm run sync-server
```

不设置 `TOKEN` 时服务不鉴权，仅适合 `127.0.0.1` 或受信任局域网。默认数据文件为 `data/homepage-sync-state.json`，也可以指定：

```bash
PORT=8787 TOKEN="$SYNC_TOKEN" DATA_FILE=/var/lib/homepage-sync/state.json npm run sync-server
```

扩展设置中填写服务器 URL 和同一个 Token，然后启用同步。

## 远程部署

远程服务器应使用 HTTPS 反向代理，Node 服务只监听内网端口。例如 Nginx/Caddy 负责 TLS，Node 服务监听 `127.0.0.1:8787`。Token 只通过 `Authorization: Bearer` 请求头发送，不写入仓库或 URL。

服务器数据文件必须纳入独立备份。恢复备份前应停止 Node 进程，避免并发覆盖。

## 运行语义

- 服务器保存单个 `SyncDocument`，不保存每台设备的 Token。
- 客户端先拉取再合并；HTTP `412 Precondition Failed` 会触发重新拉取、合并和重试。
- 服务器不可用时，本机数据不被清空；变更进入本地 outbox，恢复连接后继续推送。
- 浏览器账号同步中的旧数据不会再自动读取，避免旧整包按 `lastUpdated` 覆盖本机状态。

## 验证

```bash
npm run check
npm test
SKIP_BUMP=1 npm run build
```
