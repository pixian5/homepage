import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const files = ["package.json", "manifest.chrome.json", "manifest.firefox.json", "manifest.safari.json"];

export function bumpVersion(version) {
  if (!/^\d+\.\d+(?:\.\d+)?$/.test(version)) throw new Error(`无效版本号：${version}`);
  const [major, minor, patch = 0] = version.split(".").map(Number);
  const nextPatch = patch + 1;
  const nextMinor = minor + Math.floor(nextPatch / 10);
  return [major + Math.floor(nextMinor / 10), nextMinor % 10, nextPatch % 10].join(".");
}

export async function run() {
  const root = process.cwd();
  // 以 package.json 为唯一输入，统一所有版本源，避免旧锁文件或清单各自递增后继续漂移。
  const entries = await Promise.all(
    files.map(async (file) => {
      const text = await fs.readFile(path.join(root, file), "utf8");
      return { file, json: JSON.parse(text.replace(/^\uFEFF/, "")) };
    }),
  );
  const version = bumpVersion(entries[0].json.version);
  try {
    const json = JSON.parse(await fs.readFile(path.join(root, "package-lock.json"), "utf8"));
    if (json.packages?.[""]) json.packages[""].version = version;
    entries.push({ file: "package-lock.json", json });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  for (const { file, json } of entries) {
    json.version = version;
    await fs.writeFile(path.join(root, file), JSON.stringify(json, null, 2) + "\n", "utf8");
  }
  await fs.writeFile(path.join(root, "VERSION"), `${version}\n`, "utf8");
  // JSON.stringify 的数组展开格式与 Biome 要求不一致（短数组应压成单行）。
  // 写完后走一次 Biome 格式化，避免每次构建都把 manifest 改成 Biome 眼中的错误格式。
  try {
    const { execFileSync } = await import("node:child_process");
    const targets = entries.map((e) => e.file);
    execFileSync("npx", ["biome", "check", "--write", ...targets], {
      cwd: root,
      stdio: "ignore",
      timeout: 60000,
    });
  } catch {
    // Biome 不可用（如 CI 精简环境）时保持原样，不阻断构建
  }
  console.log(`版本已同步：${version}`);
}

const modulePath = fileURLToPath(import.meta.url);
const scriptPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (scriptPath && modulePath === scriptPath) {
  run();
}
