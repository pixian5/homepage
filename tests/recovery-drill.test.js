import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

describe("sync recovery drill", () => {
  it("validates restore and preserves the recovered state after startup failure", async () => {
    const { stdout } = await execFileAsync("bash", [path.join(root, "scripts/run-sync-recovery-drill.sh")], {
      cwd: root,
      env: process.env,
    });
    assert.match(stdout, /backup validation, restore, and startup rollback passed/);
  });
});
