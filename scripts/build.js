const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const target = args[0];
const watch = args.includes("--watch");

if (!target || !["chrome", "firefox"].includes(target)) {
  console.error("Usage: node scripts/build.js <chrome|firefox> [--watch]");
  process.exit(1);
}

const rootDir = path.resolve(__dirname, "..");
const srcDir = path.join(rootDir, "src");
const distDir = path.join(rootDir, "dist", target);

const manifestSrc =
  target === "chrome"
    ? path.join(rootDir, "manifest.chrome.json")
    : path.join(rootDir, "manifest.firefox.json");

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function cleanDir(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
  ensureDir(dirPath);
}

function copyDir(src, dest) {
  fs.cpSync(src, dest, { recursive: true });
}

function copyFile(src, dest) {
  ensureDir(path.dirname(dest));
  fs.copyFileSync(src, dest);
}

function buildOnce() {
  console.log(`Building for ${target}...`);
  cleanDir(distDir);

  copyFile(manifestSrc, path.join(distDir, "manifest.json"));
  copyFile(path.join(srcDir, "newtab.html"), path.join(distDir, "newtab.html"));
  copyFile(path.join(srcDir, "popup.html"), path.join(distDir, "popup.html"));

  copyDir(path.join(srcDir, "js"), path.join(distDir, "js"));
  copyDir(path.join(srcDir, "css"), path.join(distDir, "css"));
  copyDir(path.join(srcDir, "icons"), path.join(distDir, "icons"));
  copyDir(path.join(srcDir, "locales"), path.join(distDir, "_locales"));

  console.log(`Build complete: dist/${target}/`);
}

buildOnce();

if (watch) {
  console.log("Watching for changes...");
  const watchTargets = [srcDir, manifestSrc];
  watchTargets.forEach((p) => {
    fs.watch(p, { recursive: true }, () => {
      try {
        buildOnce();
      } catch (err) {
        console.error(err);
      }
    });
  });
}
