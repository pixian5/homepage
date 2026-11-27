import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { defaultSettings } from "../src/js/storage.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("types.js contract alignment", () => {
  it("declares every defaultSettings key in Settings typedef and excludes obsolete keys", async () => {
    const source = await readFile(path.join(root, "src/js/types.js"), "utf8");
    const settingsBlockMatch = /@typedef\s+\{Object\}\s+Settings([\s\S]*?)\*\//.exec(source);
    assert.ok(settingsBlockMatch, "Settings typedef block must exist in src/js/types.js");
    const block = settingsBlockMatch[1];

    const documentedKeys = new Set(
      Array.from(block.matchAll(/@property\s+\{[^}]+\}\s+\[?([a-zA-Z0-9_]+)\]?/g), (m) => m[1]),
    );

    const defaults = defaultSettings();
    const missing = Object.keys(defaults).filter((key) => !documentedKeys.has(key));
    assert.deepEqual(missing, [], `src/js/types.js Settings 缺少 DEFAULT_SETTINGS 字段：${missing.join(", ")}`);

    for (const staleKey of ["density", "showSearchBox", "customSearchUrl", "backgroundBing"]) {
      assert.equal(documentedKeys.has(staleKey), false, `不应残留过期字段 ${staleKey}`);
    }

    // 校验 BackupSnapshot 结构已对齐为 { id, ts, data }
    const backupBlockMatch = /@typedef\s+\{Object\}\s+BackupSnapshot([\s\S]*?)\*\//.exec(source);
    assert.ok(backupBlockMatch);
    assert.match(backupBlockMatch[1], /@property\s+\{number\}\s+ts\b/);
    assert.match(backupBlockMatch[1], /@property\s+\{HomepageData\}\s+data\b/);
  });
});
