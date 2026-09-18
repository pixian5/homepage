import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const script = path.join(root, "scripts", "setup-sync-server.sh");

function runSetup(args) {
  return spawnSync("bash", [script, ...args], {
    cwd: root,
    env: { ...process.env, SYNC_TOKEN: "" },
    encoding: "utf8",
  });
}

describe("setup-sync-server", () => {
  it("plans a generated token instead of using a fixed default", () => {
    const result = runSetup(["--dry-run"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Token=已设置/);
    assert.doesNotMatch(result.stdout, /当前 Token|TOKEN=9|默认 9/);
  });

  it("rejects an explicitly supplied weak token", () => {
    const result = runSetup(["--dry-run", "--token", "9"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /至少需要 16 个字符/);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /当前 Token/);
  });
});
