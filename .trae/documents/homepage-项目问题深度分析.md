# homepage 项目问题深度分析报告

> 任务范围：**仅深度分析项目问题，不修改代码**。项目定位为多浏览器新标签页扩展 demo。
> 分析覆盖：构建系统、架构、JS 代码质量、HTML/CSS/资源、安全、性能、可维护性。

---

## 一、项目概览

| 项目 | 说明 |
|---|---|
| 类型 | 浏览器扩展（新标签页 + 工具栏 popup） |
| 三端 | Chrome MV3 / Firefox MV2 / Safari MV3 |
| 当前版本 | 13.7（`package.json:3`，三端 manifest 一致 ✅） |
| 主入口 | `src/newtab.html` + `src/js/app.js`（4024 行，"上帝模块"） |
| popup 入口 | `src/popup.html` + `src/popup.js` |
| 依赖 | 无 `dependencies` / `devDependencies`，仅用 Node 内置模块构建 |
| 测试 / Lint / CI | 全部缺失（无 `.eslintrc`、`tsconfig`、`jest.config`、`.github/workflows/`） |

模块依赖关系：
```
app.js ──┬──> storage.js
         ├──> icons.js ──> storage.js
         └──> bing-wallpaper.js ──> storage.js

popup.js ──> storage.js

孤立模块（无任何运行时引用）:
  constants.js / dom-utils.js / shared.js / toast.js / tooltip.js
  （仅彼此互相 import，且与 app.js 内实现重复）
```

---

## 二、架构问题

### 2.1 [P0] Safari 真正构建入口位于 git 忽略目录

**问题**：Safari 宿主 App 的真正构建入口 `dist/build-macos.command`（包含 `xcodebuild`、Apple Development