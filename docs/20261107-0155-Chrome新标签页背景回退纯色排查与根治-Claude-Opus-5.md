# Chrome 新标签页背景回退纯色排查与根治（提交轮次 29.2，底包 27.1.5）

## 背景与问题现象

在 Chrome 扩展环境下，用户在设置面板中选择 Bing 每日壁纸（`backgroundType: "bing"`）或自定义图片壁纸（`backgroundType: "custom"`）后，每次重新打开 Chrome 新标签页，背景都会自动回退为纯色（`solid color`，即 `#0b0f14`）。

## 深度全链路根因分析

经过对数据层、存储迁移层、同步投影层、缓存管理层与 CSS 渲染层的逐层追踪，确认导致该问题的核心连锁诱因如下：

### 1. `schemaVersion` 漂移诱发 `MIGRATIONS[1]` 重复覆写（核心杀手）
- **触发逻辑**：在 `src/js/storage.js` 中定义了版本迁移规则：
  ```javascript
  const MIGRATIONS = {
    1: (data) => {
      if (data?.settings?.backgroundType === "bing") {
        data.settings.backgroundType = "color";
      }
      data.schemaVersion = 2;
      return data;
    },
  };
  ```
  该迁移原本设计用于历史 v1 用户一次性平滑迁移。
- **诱发点**：
  在同步与数据校验管线中：
  1. `src/js/sync_projection.js` 中的 `syncDocumentToHomepageShape` 硬编码返回 `schemaVersion: 1`；
  2. `src/js/sync_merge.js` 合并生成的 `state` 硬编码为 `schemaVersion: 1`；
  3. `src/js/sync_engine.js` 在两处 fallback 生成的 `state` 硬编码为 `schemaVersion: 1`；
  4. `src/js/data-utils.js` 中的 `repairHomepageData` 将缺失版本号强制填补为 `schemaVersion: 1`。
- **后果**：
  每当同步引擎执行、跨标签页通知或无版本号数据进入存储后，`schemaVersion` 便被重置为 `1`。每次打开新标签页调用 `loadData()` 时，`migrateData` 检查到版本为 `1 < 2`，立即重新执行 `MIGRATIONS[1]`，将用户设置的 `backgroundType: "bing"` 强行抹为 `"color"` 并写盘！

### 2. 缓存清理器 `pruneUnusedCachesQuietly` 级联删除壁纸缓存
- 当 `backgroundType` 在新标签页启动时被篡改为 `"color"`，尾部执行的 `pruneUnusedCachesQuietly` 判定当前背景类型不是 `bing`，立即执行 `saveBg({ ts: 0, url: "", dataUrl: "", date: "" })` 清空了本地已缓存的 Bing 壁纸数据。
- 导致即使后续网络恢复或重新手动选择，本地缓存已被彻底抹除，必须重新产生外部网络请求。

### 3. 同步投影中自定义背景图被抹除且缺少合并回填防护
- 在 `sync_projection.js` 中，为了节省同步流量与存储配额，`backgroundCustom`（可能达几百 KB 到数 MB 的 Base64 图片）在生成 `SyncDocument` 时被故意置空 `""`。
- 但在 `sync_engine.js` 的远端解决分支中，直接使用 `...(shape.settings || {})` 覆盖了本地数据，导致本地持久化的自定义图片被覆盖为空字符串 `""`，从而回退到 `setSolidBackgroundColor`。

### 4. CSS 简写属性 `background` 对布局样式的污染
- 在 `src/js/theme-manager.js` 的 `setSolidBackgroundColor` 中使用了简写属性 `el.style.background = safe;`，在真实浏览器中会隐式重置 `background-size: initial` 和 `background-position: initial`，导致后续再渲染壁纸图片时丢失样式表中定义好的 `background-size: cover` 与 `background-position: center`。

---

## 落地修复措施

1. **统一核心数据模型版本常量**：
   - 在 `src/js/sync_policy.js` 中导出权威常量 `export const HOMEPAGE_SCHEMA_VERSION = 2;`。
   - `src/js/storage.js` 统一导出 `export const CURRENT_SCHEMA_VERSION = HOMEPAGE_SCHEMA_VERSION;`。
2. **根除全链路 `schemaVersion: 1` 降级**：
   - `src/js/data-utils.js`：`repairHomepageData` 缺省版本规范归一为 `HOMEPAGE_SCHEMA_VERSION`（2）；
   - `src/js/sync_projection.js`：`syncDocumentToHomepageShape` 返回 `schemaVersion: HOMEPAGE_SCHEMA_VERSION`（2）；
   - `src/js/sync_merge.js`：合并生成结构使用 `schemaVersion: HOMEPAGE_SCHEMA_VERSION`（2）；
   - `src/js/sync_engine.js`：投影合并与回退分支全量统一为 `HOMEPAGE_SCHEMA_VERSION`（2）。
3. **加固自定义大图本地持久化隔离**：
   - 在 `src/js/sync_engine.js` 中，合并或直接采纳远端配置时，显式保全本地 `local.settings.backgroundCustom`，绝不允许被置空的云端投影抹去。
4. **CSS 属性精准设置与防重置保护**：
   - 在 `src/js/theme-manager.js` 中，`setSolidBackgroundColor` 优先设置 `backgroundColor`，`setBackground` 显式保证 `backgroundSize = "cover"`、`backgroundPosition = "center"` 与 `backgroundRepeat = "no-repeat"`。
5. **配套自动化单测固化**：
   - 新增 `tests/background-persistence.test.js`，5 项单测覆盖数据归一化、投影还原、同步合并、落地写盘再重载生命周期以及 DOM 样式防重置校验。

---

## 验证与验收结果

1. **自动化单测**：`npm test` 550 项单元测试全部通过（原 545 项 + 新增 5 项）。
2. **Biome 静态语法与规范**：`npm run check` 检查 156 个文件，0 错误 0 告警。
3. **Firefox 经典脚本拓扑**：`node scripts/bundle-firefox.mjs` 校验与打包正常。
4. **三端构建**：`bash dist/build.sh` 构建完成，版本自动递增至 27.1.5，Safari 宿主 App 安装成功。
5. **一键全流程回归门禁**：`bash scripts/run-all-smoke.sh` 5 步全量自动化回归（含无头 Chrome 和 Firefox 真实浏览器端到端冒烟）100% 绿灯。
