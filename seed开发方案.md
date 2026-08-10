# 「我的首页」扩展开发方案

## 一、项目现状分析

### 1.1 项目概览

- **项目名称**：我的首页 - 新标签页浏览器扩展
- **当前版本**：24.0
- **支持平台**：Chrome / Firefox / Safari 三端
- **代码总量**：约 14,700 行（含测试）
- **技术栈**：原生 JavaScript (ES Modules) + 自定义构建脚本
- **测试框架**：Node.js 内置 test runner
- **代码检查**：Biome

### 1.2 目录结构

```
homepage/
├── src/                          # 源代码
│   ├── js/
│   │   ├── app.js               # 主应用（5,567 行 - 核心问题）
│   │   ├── storage.js           # 存储层（561 行）
│   │   ├── icons.js             # 图标系统（766 行）
│   │   ├── bing-wallpaper.js    # Bing 壁纸
│   │   ├── popup.js             # Popup 弹窗（541 行）
│   │   ├── sync_*.js            # 同步模块（10 个文件，~1,700 行）
│   │   ├── data-utils.js        # 数据工具
│   │   ├── shared-utils.js      # 通用工具
│   │   ├── bookmark-*.js        # 书签侧边栏
│   │   ├── visit-history.js     # 访问历史（Safari 兼容）
│   │   ├── content-toast.js     # 页面 Toast
│   │   ├── background.js        # Service Worker
│   │   ├── error-bootstrap.js   # 错误兜底
│   │   └── types.js             # 类型定义（JSDoc）
│   ├── newtab.html              # 新标签页
│   ├── popup.html               # 弹窗
│   ├── styles.css               # 样式
│   └── assets/                  # 图标资源
├── scripts/                      # 构建脚本
│   ├── build.sh                 # 主构建（bash）
│   ├── build-macos.command      # macOS 一键构建
│   ├── bundle-firefox.mjs       # Firefox ESM 打包
│   ├── bump-version.mjs         # 版本号递增
│   ├── sync-server.mjs          # 同步服务器
│   └── setup-sync-server.sh     # 服务器部署脚本
├── tests/                        # 单元测试
├── docs/                         # 现有文档
└── manifest.*.json              # 三端 manifest
```

### 1.3 核心问题诊断

#### 🔴 严重问题

1. **app.js 过于庞大（5,567 行）**
   - 包含了渲染、交互、拖拽、模态框、设置、导入导出等所有逻辑
   - 单一文件承担了太多职责，维护成本极高
   - 状态变量散落在全局（约 40+ 个全局变量）

2. **Firefox 构建方案脆弱**
   - 自定义的 `bundle-firefox.mjs` 通过正则移除 import/export 实现打包
   - 没有真正的模块依赖解析，容易出现顺序问题
   - 缺少 source map，调试困难

3. **缺少类型安全**
   - 仅使用 JSDoc 注释，没有 TypeScript
   - 数据结构变更容易引发隐性 bug

#### 🟡 中等问题

1. **样式没有模块化**
   - 所有样式在单个 `styles.css` 文件中
   - 缺乏 CSS 变量体系的系统性使用
   - 没有 CSS 预处理器或 CSS-in-JS

2. **测试覆盖不完整**
   - 核心的 app.js 几乎没有单元测试
   - 缺少端到端（E2E）测试的浏览器自动化
   - 同步模块有测试但交互场景覆盖不足

3. **构建系统原始**
   - bash + Node.js 脚本组合，依赖系统工具（rsync、zip、xcrun）
   - 没有热更新开发模式
   - 跨平台兼容性问题（Windows 支持弱）

4. **状态管理混乱**
   - 全局 `let data` + 几十个零散状态变量
   - 没有统一的状态更新机制
   - 渲染触发依赖手动调用 `render()`

#### 🟢 良好现状

1. **同步模块设计优秀**
   - 10 个职责单一的小文件
   - 有完整的测试覆盖
   - 有墓碑（tombstone）机制处理删除同步
   - outbox 机制处理离线场景

2. **安全意识到位**
   - 统一的 HTML 转义工具
   - CSS.escape 防止 XSS
   - 内容脚本注入守卫
   - 存储读取重试机制

3. **三端兼容处理完善**
   - Safari 宿主 App 自动构建与签名
   - Firefox CSP 问题有专门解决方案
   - Safari history API 缺失有降级方案

4. **备份与容错机制**
   - 自动备份与撤销删除
   - 存储配额不足时逐级清理
   - 图标失败定时重试

---

## 二、架构重构方案

### 2.1 目标架构

采用 **渐进式重构** 策略，不重写全部代码，而是分模块拆分：

```
src/
├── core/                         # 核心层（框架无关）
│   ├── store/                    # 状态管理
│   │   ├── index.js             # Store 主入口
│   │   ├── state.js             # 初始状态定义
│   │   ├── mutations.js         # 状态变更
│   │   └── selectors.js         # 状态查询
│   ├── models/                   # 数据模型
│   │   ├── item.js              # 卡片模型
│   │   ├── folder.js            # 文件夹模型
│   │   ├── group.js             # 分组模型
│   │   └── backup.js            # 备份模型
│   ├── services/                 # 业务服务
│   │   ├── storage.js           # 存储服务（重构现有 storage.js）
│   │   ├── sync/                # 同步服务（复用现有 sync_*.js）
│   │   ├── icons.js             # 图标服务（重构现有 icons.js）
│   │   ├── wallpaper.js         # 壁纸服务
│   │   └── history.js           # 历史记录服务
│   └── utils/                    # 工具函数
│       ├── dom.js               # DOM 工具
│       ├── html.js              # HTML 安全渲染
│       ├── drag.js              # 拖拽工具
│       └── i18n.js              # 国际化
├── ui/                           # UI 层
│   ├── components/               # 组件（按功能拆分）
│   │   ├── Tile/                # 卡片组件
│   │   ├── Group/               # 分组组件
│   │   ├── FolderOverlay/       # 文件夹覆盖层
│   │   ├── Toolbar/             # 工具栏
│   │   ├── Sidebar/             # 侧边栏
│   │   ├── Modal/               # 模态框
│   │   ├── Settings/            # 设置面板
│   │   ├── Toast/               # Toast 提示
│   │   ├── ContextMenu/         # 右键菜单
│   │   └── Search/              # 搜索框
│   ├── hooks/                    # 交互 hooks（如果用框架）
│   ├── app-renderer.js           # 主渲染器
│   └── event-handlers.js         # 事件处理
├── entry/                        # 入口文件
│   ├── newtab.js                # 新标签页入口
│   ├── popup.js                 # Popup 入口
│   └── background.js            # Service Worker
└── assets/
```

### 2.2 分阶段重构计划

#### 阶段一：基础设施搭建（风险低，收益高）

**目标**：建立模块化基础，不改变现有功能

1. **引入 Vite 作为构建工具**
   - 替换自定义 bash + bundle-firefox.mjs
   - 支持热更新（HMR）开发模式
   - 自动处理 ESM 打包，三端统一构建流程
   - 内建 source map 支持

   ```bash
   npm install -D vite @vitejs/plugin-legacy
   ```

   构建配置思路：
   ```javascript
   // vite.config.js
   export default defineConfig({
     build: {
       target: 'es2020',
       rollupOptions: {
         input: {
           newtab: 'src/entry/newtab.html',
           popup: 'src/entry/popup.html',
         }
       }
     }
   })
   ```

2. **拆分通用工具**
   - 从 app.js 中提取 `escapeHtml`、`html` 模板标签、`rafThrottle`、`$`/`qs`/`qsa` 到 `core/utils/`
   - 提取常量定义到单独文件
   - 这一步纯拆分，不改动逻辑

3. **引入 TypeScript（可选但推荐）**
   - 渐进式迁移：先让 `.ts` 和 `.js` 共存
   - 为数据模型定义 interface：
     ```typescript
     interface HomepageData {
       schemaVersion: number;
       settings: Settings;
       groups: Group[];
       nodes: Record<string, ItemNode | FolderNode>;
       backups: Backup[];
       lastUpdated: number;
     }
     ```
   - 优先为 storage、sync、icons 模块加类型

**时间预估**：1-2 天
**风险**：低
**验证方式**：现有测试全部通过，功能无变化

---

#### 阶段二：状态管理重构（中等风险，高收益）

**目标**：解决全局变量混乱问题，建立可预测的状态流

1. **实现简单的响应式 Store**
   - 不需要引入 Redux/Zustand 等重型库
   - 基于发布-订阅模式实现轻量 Store：

   ```javascript
   // core/store/index.js
   class Store {
     constructor(initialState) {
       this.state = initialState;
       this.listeners = new Set();
     }
     
     getState() { return this.state; }
     
     dispatch(mutation) {
       const prevState = this.state;
       this.state = mutation(prevState);
       this.notify(prevState, this.state);
     }
     
     subscribe(listener) {
       this.listeners.add(listener);
       return () => this.listeners.delete(listener);
     }
     
     notify(prev, next) {
       this.listeners.forEach(fn => fn(next, prev));
     }
   }
   ```

2. **整理状态分组**
   - 将现有全局变量分类：
     - **持久化数据**：`data`（settings/groups/nodes/backups）
     - **UI 状态**：`activeGroupId`、`openFolderId`、`selectionMode`、`selectedIds`、`settingsOpen` 等
     - **临时状态**：`dragState`、`touchDragState`、`pendingDeletion`、`tooltipTimer` 等

3. **使用 Selector 模式查询状态**
   ```javascript
   // core/store/selectors.js
   export const selectActiveGroup = (state) => 
     state.data.groups.find(g => g.id === state.ui.activeGroupId);
   
   export const selectCurrentNodes = (state) => {
     if (state.ui.openFolderId) {
       const folder = state.data.nodes[state.ui.openFolderId];
       return folder?.children.map(id => state.data.nodes[id]) || [];
     }
     const group = selectActiveGroup(state);
     return group?.nodes.map(id => state.data.nodes[id]) || [];
   };
   ```

4. **Mutation 集中管理**
   ```javascript
   // core/store/mutations.js
   export const addNode = (node, groupId) => (state) => ({
     ...state,
     data: {
       ...state.data,
       nodes: { ...state.data.nodes, [node.id]: node },
       groups: state.data.groups.map(g => 
         g.id === groupId ? { ...g, nodes: [...g.nodes, node.id] } : g
       )
     }
   });
   ```

**时间预估**：2-3 天
**风险**：中（需要仔细处理状态依赖）
**验证方式**：每迁移一个功能点手动验证，最后运行完整测试

---

#### 阶段三：UI 组件拆分（高风险，高收益）

**目标**：将 5,567 行的 app.js 拆分为独立组件

**拆分优先级**：
1. **低风险独立组件**（先拆）：
   - Toast 提示
   - Tooltip
   - 右键菜单
   - 背景渲染
   - 空状态提示

2. **中等复杂度组件**：
   - 工具栏（新增/批量删/设置/搜索）
   - 侧边栏分组列表
   - 卡片 Tile（含图标渲染）
   - 文件夹覆盖层

3. **高复杂度组件**（最后拆）：
   - 拖拽系统（鼠标+触摸）
   - 框选功能
   - 模态框系统（新增/编辑/设置/导入导出/备份）
   - 主网格布局

**组件设计原则**：
- 每个组件是一个纯函数或类，接收 props/state，返回 DOM 或 HTML 字符串
- 组件不直接修改全局状态，通过 dispatch action
- 组件自身的 DOM 事件监听在组件内部管理
- 示例组件结构：

```javascript
// ui/components/Tile/index.js
export function createTileElement(node, context) {
  const el = document.createElement('div');
  el.className = 'tile';
  el.dataset.id = node.id;
  
  // 渲染图标
  const iconEl = createTileIcon(node, context);
  el.appendChild(iconEl);
  
  // 渲染标题
  const titleEl = document.createElement('div');
  titleEl.className = 'tile-title';
  titleEl.textContent = node.title;
  el.appendChild(titleEl);
  
  // 绑定事件
  attachTileEvents(el, node, context);
  
  return el;
}
```

**时间预估**：5-7 天
**风险**：高（拖拽和触摸交互容易出 bug）
**验证方式**：每拆完一个组件对比原功能，最后做完整回归测试

---

#### 阶段四：构建与开发体验优化（低风险，中收益）

1. **完善 Vite 构建**
   - 配置多入口构建（newtab/popup/background/content-scripts）
   - Firefox 适配：使用 Vite 的 lib 模式或 @crxjs/vite-plugin
   - 自动生成 manifest.json（根据环境变量区分三端）
   - 构建产物校验（检查是否有残留 import/export）

2. **开发模式**
   - `npm run dev`：启动 Chrome 扩展热重载
   - 集成 `web-ext` 或类似工具自动重载扩展
   - Source map 支持，断点调试友好

3. **三端构建命令简化**：
   ```json
   {
     "scripts": {
       "dev": "vite",
       "build": "vite build",
       "build:chrome": "TARGET=chrome vite build",
       "build:firefox": "TARGET=firefox vite build",
       "build:safari": "TARGET=safari vite build",
       "build:all": "npm run build:chrome && npm run build:firefox && npm run build:safari",
       "package": "node scripts/package.mjs",
       "test": "vitest",
       "lint": "biome check"
     }
   }
   ```

**时间预估**：2-3 天
**风险**：低中
**验证方式**：三端构建产物都能正常加载运行

---

#### 阶段五：测试体系完善（中风险，长期收益）

1. **引入 Vitest 替换原生 test runner**
   - 更好的 ESM 支持
   - 快照测试能力
   - 覆盖率报告
   - Watch 模式

2. **单元测试补全**
   - Store mutations/selectors 100% 覆盖
   - 数据模型和工具函数 100% 覆盖
   - 同步模块保持现有覆盖

3. **组件测试**
   - 使用 @testing-library/dom 测试组件渲染和交互
   - 重点测试：卡片渲染、拖拽逻辑、模态框表单

4. **E2E 测试强化**
   - 现有 Playwright 测试可以扩展
   - 三端关键流程测试：添加卡片→拖拽→创建文件夹→同步
   - 模拟 Firefox CSP 环境验证打包产物

**时间预估**：持续进行（与功能开发并行）
**风险**：中
**验证方式**：CI 通过率，覆盖率报告

---

## 三、功能增强建议

### 3.1 高优先级（用户感知强）

1. **卡片自定义图标增强**
   - 支持 emoji 作为图标
   - 内置图标库（Lucide 等）选择
   - 图标颜色自定义

2. **布局灵活性提升**
   - 支持卡片大小自由调整（鼠标拖拽调整）
   - 磁贴尺寸多样化（2x1、2x2 等大小卡片）
   - 分组内布局记忆（不同分组不同列数）

3. **搜索增强**
   - 支持搜索分组名称
   - 支持拼音搜索
   - 搜索历史记录
   - `/` 快捷键聚焦搜索框

### 3.2 中优先级（体验优化）

1. **键盘导航完善**
   - 方向键移动选择卡片
   - 快捷键支持：
     - `N`：新增卡片
     - `Ctrl/Cmd + F`：搜索
     - `Delete`：删除选中
     - `Ctrl/Cmd + Z`：撤销
     - `E`：编辑选中卡片
     - `F`：新建文件夹

2. **拖拽视觉优化**
   - 拖拽时卡片半透明跟随
   - 放置位置预览指示线
   - 拖拽到侧边栏分组自动切换

3. **主题与样式增强**
   - 自定义主题色
   - 卡片毛玻璃效果
   - 背景模糊强度调节
   - 更多内置壁纸源（Unsplash、Wallhaven 等）

4. **备份与同步增强**
   - WebDAV 同步支持（Nextcloud、坚果云等）
   - 备份文件加密
   - 自动定时备份导出到文件
   - 版本历史回溯（保留更多历史版本）

### 3.3 低优先级（技术驱动）

1. **PWA 支持**：可以作为独立网页应用使用
2. **快捷指令**：自定义 URL 协议（如 `homepage://add?url=xxx`）
3. **统计面板**：显示最常访问网站、点击次数统计
4. **多用户配置文件**：不同场景不同配置（工作/生活）

---

## 四、Firefox 专项优化

### 4.1 当前问题
- 自定义 `bundle-firefox.mjs` 正则替换方案脆弱
- 每次构建需要特殊处理
- background.js 也需要对应打包（当前 manifest.firefox.json 引用的是 `background.ff.js`，但源码只有 background.js）

### 4.2 改进方案
1. **使用 Vite 统一处理**
   - Vite 构建时自动为 Firefox 生成 IIFE 格式
   - 不需要单独的打包脚本
   - 自动处理 content scripts 和 background

2. **CSP 问题根治**
   - 构建产物中不出现 `import`/`export` 语句
   - 考虑使用 `content_security_policy.extension_pages` 适当放宽（但保持安全）

---

## 五、Safari 专项优化

### 5.1 当前状态
- 有完整的 Xcode 项目自动生成流程
- 自动签名和安装到 /Applications
- 处理了历史 API 降级

### 5.2 可改进点
1. **Safari Web Extension 权限优化**
   - 研究 `optional_permissions` 动态申请
   - 更好的首次引导授权流程

2. **iCloud 同步**
   - 除了自建服务器，可以考虑利用 Safari 的 iCloud 同步能力
   - 通过 `browser.storage.sync` 在 Safari 中通过 iCloud 同步（但需要测试配额问题）

3. **Touch Bar 支持**（可选）
   - macOS Safari 宿主 App 可以添加 Touch Bar 快捷操作

---

## 六、性能优化建议

### 6.1 渲染性能
1. **虚拟滚动**：当卡片数量很多时（>100），只渲染可视区域卡片
2. **防抖优化**：搜索输入、窗口 resize 等使用防抖
3. **离屏渲染**：图标加载时使用骨架屏占位
4. **懒加载**：不在当前视图的分组不提前渲染

### 6.2 存储性能
1. **增量保存**：现在是整包写入，可以只保存变更部分
2. **IndexedDB 替代**：对于大量数据和图标缓存，考虑使用 IndexedDB 代替 chrome.storage.local
3. **图标缓存压缩**：图标 dataURL 可以考虑 WebP 格式减小体积

### 6.3 启动性能
1. **关键渲染路径优化**：先渲染骨架，再异步加载数据和图标
2. **预加载**：使用 `link rel="preload"` 预加载关键资源
3. **后台初始化**：非关键服务（图标刷新、同步）在首屏渲染后启动

---

## 七、代码质量规范

### 7.1 编码规范
- 继续使用 Biome 作为 linter 和 formatter
- 补充 ESLint 规则（如果引入 TypeScript 则用 typescript-eslint）
- 强制要求 JSDoc/TS 注释所有公共函数

### 7.2 Git 规范
- 使用 Conventional Commits 格式：
  - `feat:` 新功能
  - `fix:` 修复
  - `refactor:` 重构
  - `docs:` 文档
  - `test:` 测试
  - `chore:` 构建/工具
- 每个 PR 对应一个功能或修复
- 要求 PR 描述包含：变更内容、测试方式、风险点

### 7.3 文档规范
- 每个模块有 README 说明职责和使用方式
- 公共 API 有 JSDoc 注释
- 复杂算法有设计决策说明
- 三端差异在文档中明确标注

---

## 八、里程碑规划

### v25.0（基础重构，1-2 周）
- [ ] 引入 Vite 构建，替换自定义打包脚本
- [ ] 拆分通用工具函数到独立文件
- [ ] 补全核心模块单元测试
- [ ] 保持所有现有功能不变
- [ ] 三端构建验证通过

### v26.0（状态管理，1 周）
- [ ] 实现轻量 Store
- [ ] 重构状态更新逻辑
- [ ] 整理和分组所有状态
- [ ] 引入 Selector 和 Mutation 模式

### v27.0（组件拆分第一期，1-2 周）
- [ ] 拆分独立小组件（Toast、Tooltip、ContextMenu、Background）
- [ ] 拆分工具栏和侧边栏
- [ ] 拆分卡片 Tile 组件
- [ ] 功能验证无回归

### v28.0（组件拆分第二期，1-2 周）
- [ ] 拆分文件夹覆盖层
- [ ] 拆分模态框系统
- [ ] 拆分设置面板
- [ ] 重写拖拽系统（支持更好的触摸交互）

### v29.0（功能增强，持续迭代）
- [ ] emoji 图标支持
- [ ] 键盘快捷键完善
- [ ] 搜索拼音支持
- [ ] 壁纸源扩展

### v30.0（TypeScript 迁移，可选，2 周）
- [ ] 配置 TypeScript 编译
- [ ] 为核心模块添加类型
- [ ] 逐步迁移所有文件到 .ts
- [ ] 修复类型错误

---

## 九、风险与注意事项

### 9.1 重构风险
1. **功能回归**：大重构容易引入新 bug，每一步都需要测试
2. **三端差异**：Chrome/Firefox/Safari 各有特性，重构时需持续验证三端
3. **用户数据**：数据结构变更必须写迁移逻辑，不能破坏用户现有数据
4. **同步兼容**：新代码必须能和旧版本同步，考虑版本向量或格式协商

### 9.2 缓解措施
1. **小步提交**：每次改动小范围，及时验证
2. **特性开关**：重构中的新代码可以用开关控制，出问题快速回退
3. **金丝雀发布**：先自己用，没问题再发布
4. **回滚预案**：每个里程碑保留可以工作的 tag

---

## 十、立即可以动手的任务

不需要等到完整重构，现在就可以开始：

1. **✅ 安装 Vite 并做一个 hello world 构建尝试**
   - 看看 Vite 能不能顺利构建出三端可以加载的产物
   - 验证 Firefox 打包问题是否在 Vite 下自动解决

2. **✅ 从 app.js 提取前 500 行的常量和工具函数**
   - 把 `$`、`qs`、`qsa`、`escapeHtml`、`html`、`rafThrottle`、常量定义等
   - 提取到 `src/js/utils/` 下，app.js 从这些文件 import
   - 这是纯物理移动，风险极低

3. **✅ 把现有测试从 node:test 迁移到 Vitest**
   - 体验更好的测试框架
   - 为后续组件测试打基础

4. **✅ 补充 app.js 关键流程的注释**
   - 给复杂的拖拽逻辑、持久化逻辑写注释
   - 方便后续拆分时理解逻辑

---

## 十一、总结

这个项目的代码质量整体不错，尤其是同步模块和安全处理体现了很好的工程素养。最大的问题是 `app.js` 过于庞大，随着功能增加会越来越难维护。

**建议从最小风险的工具函数拆分和 Vite 引入开始**，不要上来就想重写整个项目。重构是一个渐进的过程，每个阶段都应该保持项目可运行、可发布，而不是憋一个大版本。

现有同步模块设计很优秀，不要轻易动，直接复用即可。重点放在 app.js 的拆分和开发体验提升上。
