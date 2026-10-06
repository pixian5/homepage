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

  it("旧两段版本补零后按 +0.0.1 递增", async () => {
    const { run } = await import("../scripts/bump-version.mjs");
    await run();

    const pkg = JSON.parse(await fs.readFile(path.join(tmpDir, "package.json"), "utf8"));
    assert.equal(pkg.version, "1.2.1");
  });

  it("bumps all manifest versions", async () => {
    const { run } = await import("../scripts/bump-version.mjs");
    await run();

    for (const file of ["manifest.chrome.json", "manifest.firefox.json", "manifest.safari.json"]) {
      const json = JSON.parse(await fs.readFile(path.join(tmpDir, file), "utf8"));
      assert.equal(json.version, "1.2.1");
    }
  });

  it("版本文件、锁文件及漂移的清单统一跟随包版本", async () => {
    await fs.writeFile(
      path.join(tmpDir, "package-lock.json"),
      JSON.stringify({
        version: "0.0.0",
        packages: { "": { version: "0.0.0" } },
      }),
    );
    await fs.writeFile(path.join(tmpDir, "manifest.firefox.json"), JSON.stringify({ version: "0.0.8" }));
    const { run } = await import("../scripts/bump-version.mjs");
    await run();
    const lock = JSON.parse(await fs.readFile(path.join(tmpDir, "package-lock.json"), "utf8"));
    assert.equal(lock.version, "1.2.1");
    assert.equal(lock.packages[""].version, "1.2.1");
    assert.equal((await fs.readFile(path.join(tmpDir, "VERSION"), "utf8")).trim(), "1.2.1");
    assert.equal(JSON.parse(await fs.readFile(path.join(tmpDir, "manifest.firefox.json"), "utf8")).version, "1.2.1");
  });
});

it("版本各段按十进制进位", async () => {
  const { bumpVersion } = await import("../scripts/bump-version.mjs");
  assert.equal(bumpVersion("0.0.9"), "0.1.0");
  assert.equal(bumpVersion("0.9.9"), "1.0.0");
  assert.equal(bumpVersion("25.9"), "25.9.1");
  assert.throws(() => bumpVersion("invalid"), /无效版本号/);
});
