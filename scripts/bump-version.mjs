import { promises as fs } from "fs";
import path from "path";

const root = process.cwd();
const files = ["package.json", "manifest.chrome.json", "manifest.firefox.json"];

function bumpVersion(version) {
  const parts = version.split(".").map((n) => Number(n));
  if (parts.length < 2) return version;
  let major = parts[0] || 0;
  const minor = parts[1] || 0;
  const nextMinor = minor + 1;
  major += Math.floor(nextMinor / 10);
  return [major, nextMinor % 10].join(".");
}

async function run() {
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

run();
