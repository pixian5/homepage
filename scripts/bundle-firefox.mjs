import { promises as fs } from "node:fs";
import path from "node:path";

const root = process.cwd();
const srcDir = path.join(root, "src", "js");
const firefoxDir = path.join(root, "dist", "firefox");
const outDir = path.join(firefoxDir, "js");
const outFile = path.join(outDir, "app.ff.js");
const htmlPath = path.join(firefoxDir, "newtab.html");

const files = ["storage.js", "icons.js", "bing-wallpaper.js", "app.js"];

export function stripImports(code) {
  return code.replace(/^\s*import[\s\S]*?;\s*/gm, "");
}

export function stripExports(code) {
  return code.replace(/\bexport\s+(?=async|function|const|let|var|class)/g, "");
}

export async function bundle({ src = srcDir, out = outDir, target = outFile, list = files } = {}) {
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
  await fs.writeFile(target, output, "utf8");
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
  await bundle();
  await patchHtml();
  console.log("Firefox bundle generated");
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
