import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
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
  it("plans the required fixed default token 9", async () => {
    const result = runSetup(["--dry-run"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Token=已设置/);
    const source = await readFile(script, "utf8");
    assert.match(source, /TOKEN="9"/);
    assert.doesNotMatch(source, /randomBytes|自动轮换/);
  });

  it("accepts the explicitly required token 9", () => {
    const result = runSetup(["--dry-run", "--token", "9"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Token=已设置/);
  });
});
