import { promises as fs } from "fs";
import path from "path";

const root = process.cwd();
const srcDir = path.join(root, "src", "js");
const firefoxDir = path.join(root, "dist", "firefox");
const outDir = path.join(firefoxDir, "js");
const outFile = path.join(outDir, "app.ff.js");
const htmlPath = path.join(firefoxDir, "newtab.html");

const files = [
  "storage.js",
  "icons.js",
  "bing-wallpaper.js",
  "app.js",
];

function stripImports(code) {
  return code.replace(/^\s*import[\s\S]*?;\s*/gm, "");
}

function stripExports(code) {
  return code.replace(/\bexport\s+(?=async|function|const|let|var|class)/g, "");
}

async function bundle() {
  await fs.mkdir(outDir, { recursive: true });
  const chunks = [];
  for (const file of files) {
    const fullPath = path.join(srcDir, file);
    let code = await fs.readFile(fullPath, "utf8");
    code = code.replace(/^\uFEFF/, "");
    code = stripExports(stripImports(code));
    chunks.push(code.trimEnd());
  }
  const output = [
    "/* Firefox bundle (no ESM imports) */",
    ...chunks,
    "",
  ].join("\n\n");
  await fs.writeFile(outFile, output, "utf8");
}

async function patchHtml() {
  let html = await fs.readFile(htmlPath, "utf8");
  const externalScript = `<script src="js/app.ff.js"></script>`;
  let updated = html.replace(
    /<script\s+src="js\/app\.ff\.js"\s*><\/script>/i,
    externalScript
  );
  if (updated === html) {
    updated = html.replace(
      /<script\s+type="module"\s+src="js\/app\.js"\s*><\/script>/i,
      externalScript
    );
  }
  if (updated === html) {
    throw new Error("newtab.html missing app script tag");
  }
  await fs.writeFile(htmlPath, updated, "utf8");
}

async function main() {
  await bundle();
  await patchHtml();
  console.log("Firefox bundle generated");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
