import { promises as fs } from "fs";
import path from "path";

const root = process.cwd();
const srcDir = path.join(root, "src");
const distDir = path.join(root, "dist");
const target = process.argv[2] || "chrome";

const manifestName = target === "firefox" ? "manifest.firefox.json" : "manifest.chrome.json";

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
  await fs.rm(distDir, { recursive: true, force: true });
  await copyDir(srcDir, distDir);
  await fs.copyFile(path.join(root, manifestName), path.join(distDir, "manifest.json"));
  console.log(`Built ${target} extension into dist/`);
}

build();
