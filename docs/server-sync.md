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

仓库提供一键创建脚本：[scripts/setup-sync-server.sh](../scripts/setup-sync-server.sh)。它只适用于 Ubuntu/systemd 服务器，不会把服务器 Token、数据文件或客户端 `dist/` 产物写入仓库。

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

在服务器上从仓库执行：

```bash
sudo scripts/setup-sync-server.sh
```

脚本会创建：

- `/opt/homepage-sync/sync-server.mjs`：服务代码
- `/var/lib/homepage-sync/homepage-sync-state.json`：同步数据
- `/etc/homepage-sync/homepage-sync.env`：权限 `600` 的 Token 和运行参数
- `/etc/systemd/system/homepage-sync.service`：自动重启和开机启动

首次安装未传入 Token 时，脚本默认使用 `9`；也可以通过 `--token` 或 `SYNC_TOKEN` 传入。配置会写入 `/etc/homepage-sync/homepage-sync.env`，重复执行且未显式传入新 Token 时会继续读取已有 Token，不会被默认值覆盖。不希望安装时启动服务可加 `--no-start`；只查看计划可用 `--dry-run`。更新服务代码时重新执行同一脚本即可，数据目录会保留。

远程服务器应使用 HTTPS 反向代理，Node 服务只监听内网端口。例如 Nginx/Caddy 负责 TLS，Node 服务监听 `127.0.0.1:8787`。Token 只通过 `Authorization: Bearer` 请求头发送，不写入仓库或 URL。

## Caddy 独立端口部署

如果服务器的 `80/443` 已被其他代理程序占用，可以让 Caddy 单独监听 `58443`，不影响现有服务。Caddy 使用 ACME 证书副本，反向代理到 Homepage：

```caddyfile
{
    auto_https off
}

:58443 {
    tls /etc/caddy/certs/sbbz.tech.fullchain.cer /etc/caddy/certs/sbbz.tech.key
    reverse_proxy 127.0.0.1:8787
}
```

证书目录和 Caddy 配置由服务器部署脚本之外的运维步骤管理。DNS 应将 `sf.sbbz.tech` 的 A 记录指向服务器公网 IP；扩展中的服务器 URL 使用 `https://sf.sbbz.tech:58443`。现有 `bz/xbz` 继续保留在 `80/443`。

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
