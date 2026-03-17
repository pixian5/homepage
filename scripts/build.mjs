import { promises as fs } from "fs";
import path from "path";

const root = process.cwd();
const srcDir = path.join(root, "src");
const distDir = path.join(root, "dist");
const target = process.argv[2] || "chrome";

const manifestMap = {
  chrome: "manifest.chrome.json",
  firefox: "manifest.firefox.json",
  safari: "manifest.safari.json",
};
const manifestName = manifestMap[target] || manifestMap.chrome;

async function copyDir(from, to) {
  await fs.mkdir(to, { recursive: true });
  const entries = await fs.readdir(from, { withFileTypes: true });
  for (const entry of entries) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) {
      await copyDir(src, dest);
    } else {
      await fs.copyFile(src, dest);
    }
  }
}

async function build() {
  const targetDir = path.join(distDir, target);
  await fs.rm(targetDir, { recursive: true, force: true });
  await copyDir(srcDir, targetDir);
  await fs.copyFile(path.join(root, manifestName), path.join(targetDir, "manifest.json"));
  console.log(`Built ${target} extension into dist/${target}/`);
}

build();
