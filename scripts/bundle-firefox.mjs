import { promises as fs } from "node:fs";
import path from "node:path";

const root = process.cwd();
const srcDir = path.join(root, "src", "js");
const firefoxDir = path.join(root, "dist", "firefox");
const outDir = path.join(firefoxDir, "js");
const outFile = path.join(outDir, "app.ff.js");
const bgOutFile = path.join(outDir, "background.ff.js");
const htmlPath = path.join(firefoxDir, "newtab.html");

const files = [
  "shared-utils.js",
  "data-utils.js",
  "storage.js",
  "icons.js",
  "bing-wallpaper.js",
  "visit-history.js",
  "sync_policy.js",
  "sync_ids.js",
  "sync_projection.js",
  "sync_merge.js",
  "sync_bundle.js",
  "sync_pack.js",
  "sync_outbox.js",
  "sync_http_transport.js",
  "sync_engine.js",
  "app.js",
];
const backgroundFiles = ["shared-utils.js", "visit-history.js", "background.js"];

export function stripImports(code) {
  return code.replace(/^\s*import[\s\S]*?;\s*/gm, "");
}

/**
 * \u5265\u79BB\u5168\u90E8 ESM export \u5F62\u6001\uFF0C\u4F9B Firefox \u7ECF\u5178\u811A\u672C\u62FC\u63A5\uFF1A
 * - export { a, b } / export { a } from "..."
 * - export * from "..."
 * - export default ...
 * - export function/const/let/var/class/async
 */
export function stripExports(code) {
  return code
    .replace(/\bexport\s+\{[^}]*\}\s*(from\s+['"][^'"]+['"])?\s*;?/g, "")
    .replace(/\bexport\s+\*\s*(?:as\s+\w+\s+)?from\s+['"][^'"]+['"]\s*;?/g, "")
    .replace(/\bexport\s+default\s+/g, "")
    .replace(/\bexport\s+(?=async|function|const|let|var|class)/g, "");
}

/**
 * \u6821\u9A8C\u62FC\u63A5\u7ED3\u679C\u53EF\u88AB\u7ECF\u5178\u811A\u672C\u89E3\u6790\uFF0C\u5E76\u62D2\u7EDD\u6B8B\u7559 import/export\u3002
 * @param {string} code
 * @param {{ Script?: typeof import("node:vm").Script }} [vmApi]
 */
export function assertClassicScript(code, vmApi) {
  if (/^\s*import\b/m.test(code)) {
    throw new Error("Firefox bundle still contains import statements");
  }
  // \u53EA\u5339\u914D\u771F\u6B63\u7684 ESM export \u8BED\u53E5\uFF0C\u907F\u514D\u8BEF\u4F24 i18n \u952E\u540D\u5982 settings.action.export
  if (
    /^\s*export\b/m.test(code) ||
    /\bexport\s+(?:async\s+)?(?:function|const|let|var|class|default|\{|\*)\b/.test(code)
  ) {
    throw new Error("Firefox bundle still contains export statements");
  }
  const Script = vmApi?.Script;
  if (Script) {
    // \u8BED\u6CD5\u89E3\u6790\uFF1A\u4E0D\u80FD\u6267\u884C\uFF08\u4F9D\u8D56 browser DOM\uFF09\uFF0C\u53EA\u9A8C\u8BC1\u53EF parse
    // eslint-disable-next-line no-new
    new Script(code, { filename: "app.ff.js" });
  }
}

export async function bundle({ src = srcDir, out = outDir, target = outFile, list = files, validate = false } = {}) {
  await fs.mkdir(out, { recursive: true });
  const chunks = [];
  for (const file of list) {
    const fullPath = path.join(src, file);
    let code = await fs.readFile(fullPath, "utf8");
    code = code.replace(/^\uFEFF/, "");
    code = stripExports(stripImports(code));
    chunks.push(code.trimEnd());
  }
  const output = ["/* Firefox bundle (no ESM imports) */", ...chunks, ""].join("\n\n");
  if (validate) {
    const vm = await import("node:vm");
    assertClassicScript(output, vm);
  }
  await fs.writeFile(target, output, "utf8");
  return output;
}

export async function patchHtml(htmlPathArg = htmlPath) {
  const html = await fs.readFile(htmlPathArg, "utf8");
  const externalScript = `<script src="js/app.ff.js"></script>`;
  // 仅处理 ESM 入口 -> 外部 bundle 的替换；若已是目标则无需改动
  const updated = html.replace(/<script\s+type="module"\s+src="js\/app\.js"\s*><\/script>/i, externalScript);
  if (updated === html && !/<script\s+src="js\/app\.ff\.js"\s*><\/script>/i.test(html)) {
    throw new Error("newtab.html missing app script tag");
  }
  await fs.writeFile(htmlPathArg, updated, "utf8");
}

async function main() {
  // 真实模块图必须能作为经典脚本 parse，否则 Firefox 新标签页整页失效
  await bundle({ validate: true });
  await bundle({
    target: bgOutFile,
    list: backgroundFiles,
    validate: true,
  });
  await patchHtml();
  console.log("Firefox bundle generated (app.ff.js + background.ff.js)");
}

const isMain = (() => {
  try {
    return path.resolve(process.argv[1] ?? "") === path.resolve(new URL(import.meta.url).pathname);
  } catch {
    return false;
  }
})();

if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
