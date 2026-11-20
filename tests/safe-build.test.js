import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));

// 只在临时目录跑真实入口，替身记录系统命令；不探测用户窗口，更不启动真实 Safari。
it("默认构建只打包；显式安装发现 Safari 在运行或探测失败时，在快照和编译前退出", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "homepage-safe-build-"));
  try {
    for (const dir of ["scripts/lib", "dist", "bin", "src"]) await mkdir(path.join(tmp, dir), { recursive: true });
    for (const file of [
      "scripts/build.sh",
      "scripts/build-macos.command",
      "scripts/lib/safari-signing.sh",
      "dist/build-macos.command",
      "dist/run-build.command",
    ]) {
      await copyFile(path.join(root, file), path.join(tmp, file));
      await chmod(path.join(tmp, file), 0o755);
    }
    for (const file of ["manifest.chrome.json", "manifest.firefox.json", "manifest.safari.json"])
      await writeFile(path.join(tmp, file), "{}");
    const log = path.join(tmp, "calls");
    for (const [name, body] of Object.entries({
      rsync: 'for last; do :; done; mkdir -p "$last"',
      zip: 'touch "$4"',
      node: ":",
      pgrep: 'exit "$PGREP_STATUS"',
      ...Object.fromEntries(
        ["osascript", "open", "killall", "pkill", "xcodebuild", "xcrun", "pluginkit", "python3", "sudo", "ditto"].map(
          (key) => [key, "exit 98"],
        ),
      ),
    })) {
      const file = path.join(tmp, "bin", name);
      await writeFile(file, `#!/bin/sh\nprintf '%s\\n' '${name}' >> "$CALL_LOG"\n${body}\n`, { mode: 0o755 });
    }
    const env = {
      ...process.env,
      PATH: `${tmp}/bin:/usr/bin:/bin`,
      CALL_LOG: log,
      PGREP_STATUS: "0",
      SKIP_BUMP: "1",
      NO_PAUSE: "1",
      SAFARI_LAUNCH_AFTER_BUILD: "1",
    };
    await run("/bin/bash", ["dist/run-build.command"], { cwd: tmp, env });
    const calls = (await readFile(log, "utf8")).trim().split("\n");
    assert.equal(calls.filter((x) => x === "zip").length, 3);
    assert.ok(
      calls.every((x) => ["rsync", "node", "zip"].includes(x)),
      calls.join(","),
    );
    for (const PGREP_STATUS of ["0", "2"]) {
      await writeFile(log, "");
      await assert.rejects(
        run("/bin/bash", ["dist/run-build.command", "--install"], { cwd: tmp, env: { ...env, PGREP_STATUS } }),
        { code: 3 },
      );
      assert.equal((await readFile(log, "utf8")).trim(), "pgrep");
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
