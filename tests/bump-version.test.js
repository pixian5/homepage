import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

const originalCwd = process.cwd();

describe("bump-version", async () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bump-version-"));
    process.chdir(tmpDir);
    await fs.writeFile(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ name: "test", version: "1.2" }) + "\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(tmpDir, "manifest.chrome.json"),
      JSON.stringify({ manifest_version: 3, version: "1.2" }) + "\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(tmpDir, "manifest.firefox.json"),
      JSON.stringify({ manifest_version: 2, version: "1.2" }) + "\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(tmpDir, "manifest.safari.json"),
      JSON.stringify({ manifest_version: 3, version: "1.2" }) + "\n",
      "utf8",
    );
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("bumps 1.2 to 1.3", async () => {
    const { run } = await import("../scripts/bump-version.mjs");
    await run();

    const pkg = JSON.parse(await fs.readFile(path.join(tmpDir, "package.json"), "utf8"));
    assert.equal(pkg.version, "1.3");
  });

  it("bumps all manifest versions", async () => {
    const { run } = await import("../scripts/bump-version.mjs");
    await run();

    for (const file of ["manifest.chrome.json", "manifest.firefox.json", "manifest.safari.json"]) {
      const json = JSON.parse(await fs.readFile(path.join(tmpDir, file), "utf8"));
      assert.equal(json.version, "1.3");
    }
  });
});
