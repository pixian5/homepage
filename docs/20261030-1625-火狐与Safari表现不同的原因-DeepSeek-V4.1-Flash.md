# 为什么 Safari 和火狐不一样：火狐还停在 22.0（2026-10-30 16:25）

## 结论

**不是浏览器差异，是版本差异。** Firefox 里装的「我的首页」是 **22.0**（2026-08-06 的包），
Safari 里是今天的 **26.4.2**。中间隔了 **89 个提交**，其中 **15 个是同步相关修复**。

所以两边看到的行为不同很正常，**Safari 那边是新的、对的**。

## 证据

### 1. Firefox 装的确实是 22.0

`~/Library/Application Support/Firefox/Profiles/bbegm7ye.dev-edition-default/extensions.json`：

```
id         : homepage@pixian5.github.io
version    : 22.0
installDate: 2026-07-06
updateDate : 2026-08-06
path       : .../extensions/homepage@pixian5.github.io.xpi
```

xpi 文件时间戳也是 **8 月 6 日**。

### 2. 这份 xpi 永远不会自己变新

它的 `manifest.json` 里只有：

```json
"browser_specific_settings": { "gecko": { "id": "homepage@pixian5.github.io", "strict_min_version": "115.0" } }
```

**没有 `update_url`**。这是手动「从文件安装」的包，Firefox 不会去任何地方检查新版本，
所以它会一直停在 22.0，除非你手动换包。

（Safari 那边不存在这个问题：每次 `safari:package` 都会重新构建并覆盖 `/Applications`。）

### 3. 22.0 之后有 15 个同步相关修复

```
af5e2b9 26.3.0 新增同步失败提示条与跨标签页状态同步
2e9c381 26.2.3 修复 412 重试两缺陷（采纳服务端新 etag、重试重取合并后快照）
cb88617 26.1.6 墓碑回收第二阶段
18b86a3 26.1.5 服务端设备表第一阶段
9626456 26.1.0 修复多标签页把冲突写回
ac0a733 26.0.7 修复冲突上下文不持久导致解决冲突失效
cf9b0dd 25.8  修复同步服务一致性与冲突处理
95f1f50 25.7  修复同步更新来源误判
5961f7b 23.8  修复多端同步冲突与墓碑复活
9c18995 23.5  修复书签位置同步与导入合并
1440a6e 23.4  修复书签位置重复与同步排序
7c695dc 23.3  改为全部唯一书签根目录
77e2c75 23.2  增加全部书签根分组与混排
bd3a89c 22.2  修复多设备删除同步复活
94971cc 22.1  修复删除同步墓碑丢失
```

换成白话，22.0 存在这些问题（都已修）：

- 在一台设备上**删掉的条目，同步后可能在另一台复活**（墓碑丢失 / 墓碑复活）。
- **书签位置**（排序、所属文件夹）同步会重复或错乱。
- **冲突**发生时上下文不持久，刷新后「解决冲突」会失效。
- 多标签页同时操作时，会把冲突结果错误写回。
- 推送遇到 412（版本冲突）时的重试逻辑有缺陷，可能采纳旧 etag 或丢掉合并后的快照。
- 同步断了**没有任何提示**（26.3.0 才加的失败提示条）。

这也解释了为什么你觉得 Safari 更对：Safari 跑的是修完这些之后的版本。

## 怎么把 Firefox 也更新

Firefox 没有自动更新通道，只能重新装一次：

```bash
cd ~/code/homepage
SAFARI_SKIP_APP_BUILD=1 bash scripts/build.sh   # 只出扩展包，不动 Safari 工程
```

产物是 `dist/firefox.xpi`。然后在 Firefox：

1. `about:addons` → 右上角齿轮 → **从文件安装附加组件**
2. 选 `dist/firefox.xpi`，确认替换旧版

> 说明：这是自签名/未上架 AMO 的包，Firefox 正式版可能拒绝安装未签名扩展；
> 开发者版（Developer Edition，你现在用的就是 `dev-edition-default` 配置）允许。

### 升级前建议

1. 先在 Firefox 里导出一次数据（设置 → 导入导出 → 导出备份）。
2. 22.0 → 26.x 之间改过书签根目录结构（23.2/23.3），首次启动会走数据迁移；
   有备份的话出问题可以回退。
3. 升级后确认同步设置里的服务器地址是 `http://127.0.0.1:8787`（26.4.0 才切到本地，
   22.0 里可能还指向旧的 `oh.sbbz.tech`）。

## 已执行升级（2026-10-30 16:26）

```bash
SAFARI_SKIP_APP_BUILD=1 bash scripts/build.sh   # 26.4.3 → 26.4.4，产出 dist/firefox.xpi
```

升级前的备份（旧 xpi + `extensions.json` + 整个扩展 idb 目录）：

```
.test-backups/firefox-22.0-20261030-162507/
```

安装方式：Firefox 运行中无法用 AppleScript 退出，所以采用**原子替换**——
新包先写到 `...xpi.new`，再 `mv` 覆盖。正在运行的进程继续持有旧 inode，不会被写坏；
下次启动时 Firefox 重新扫描 profile 的 `extensions/` 目录即可读到新版。

重启后核验：

| 检查 | 结果 |
|---|---|
| `extensions.json` 里 `homepage@pixian5.github.io` 的 version | **26.4.4** |
| `active` / `userDisabled` / `appDisabled` | True / False / False |
| 扩展数据目录 | 1.2 MB，升级后仍有写入（sqlite 16:26 更新） |
| 本地同步服务 `revision` | 21 → **30**（升级后仍在正常推拉） |

## 长期建议

如果打算继续用 Firefox 这一份，别每次手动装 xpi——可以二选一：

- 把 xpi 放到一个固定目录做本地更新源（`update_url` 指向它），Firefox 就会自动升级；
- 或者接受「Safari 主力、Firefox 偶尔验证」，那就每次验证前重装一遍。

现在这种「装一次就不管」的状态是最糟的：它看起来能用，但同步逻辑落后 15 个修复。
