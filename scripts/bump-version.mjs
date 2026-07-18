import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const files = ["package.json", "manifest.chrome.json", "manifest.firefox.json", "manifest.safari.json"];

export function bumpVersion(version) {
  const parts = version.split(".").map((n) => Number(n));
  if (parts.length < 2) return version;
  let major = parts[0] || 0;
  const minor = parts[1] || 0;
  const nextMinor = minor + 1;
  major += Math.floor(nextMinor / 10);
  return [major, nextMinor % 10].join(".");
}

export async function run() {
  const root = process.cwd();
  for (const file of files) {
    const full = path.join(root, file);
    const text = await fs.readFile(full, "utf8");
    const json = JSON.parse(text.replace(/^\uFEFF/, ""));
    if (!json.version) continue;
    json.version = bumpVersion(json.version);
    await fs.writeFile(full, JSON.stringify(json, null, 2) + "\n", "utf8");
  }
  console.log("version bumped");
}

const modulePath = fileURLToPath(import.meta.url);
const scriptPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (scriptPath && modulePath === scriptPath) {
  run();
}
