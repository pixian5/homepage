import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("app.js wiring contracts", () => {
  it("connects hover tooltip callbacks to tooltipMgr showTooltip/hideTooltip", () => {
    const appSource = fs.readFileSync(path.join(REPO_ROOT, "src/js/app.js"), "utf8");
    const tooltipSource = fs.readFileSync(path.join(REPO_ROOT, "src/js/tooltip-manager.js"), "utf8");

    assert.match(tooltipSource, /return\s*\{[\s\S]*showTooltip[\s\S]*hideTooltip[\s\S]*\}/);
    assert.match(appSource, /showTooltip:\s*\(text,\s*x,\s*y\)\s*=>\s*tooltipMgr\?\.showTooltip\?\.\(text,\s*x,\s*y\)/);
    assert.match(appSource, /hideTooltip:\s*\(\)\s*=>\s*tooltipMgr\?\.hideTooltip\?\.\(\)/);
    assert.doesNotMatch(appSource, /tooltipMgr\?\.show\?\./);
    assert.doesNotMatch(appSource, /tooltipMgr\?\.hide\?\./);
  });

  it("wires command palette folder navigation through openFolder and sync banner storage via storageArea(false)", () => {
    const appSource = fs.readFileSync(path.join(REPO_ROOT, "src/js/app.js"), "utf8");

    assert.match(
      appSource,
      /navigateToFolder:\s*\(\{\s*id,\s*rootGroupId\s*\}\)\s*=>\s*\{[\s\S]*target\?\.\s*type\s*!==\s*"folder"[\s\S]*openFolder\(id\);/,
    );
    assert.match(appSource, /startSyncOnLaunch\(\{[\s\S]*getStorage:\s*\(\)\s*=>\s*storageArea\(false\)/);
  });

  it("suppresses storage self-echo around initSyncEngine saveLocal writes", () => {
    const appSource = fs.readFileSync(path.join(REPO_ROOT, "src/js/app.js"), "utf8");
    assert.match(
      appSource,
      /initSyncEngine\(\{[\s\S]*saveLocal:\s*async\s*\(next\)\s*=>\s*\{[\s\S]*setSuppressStorageUntil[\s\S]*saveData\(next,\s*false\)/,
    );
  });
});
