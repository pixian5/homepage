/**
 * 墓碑回收 launchd 安装脚本（setup-tombstone-reclaim.sh）测试：
 * 全程注入假 launchctl（LAUNCHCTL_BIN）与临时 HOME，不触碰真实用户会话。
 * - install：生成 plist（Label/ProgramArguments/--force/StartCalendarInterval/环境变量/日志路径），
 *   env 文件权限 600，重复安装幂等（load 前先 unload）；
 * - 自定义 --hour 与 --dry-run 默认；
 * - uninstall：删除 plist 与 env 文件并 unload；
 * - status：未安装退出码 2；
 * - 非法参数（未知动作 / 非法时间）退出码 1。
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.join(root, "scripts", "setup-tombstone-reclaim.sh");

let tempHome = "";
let fakeBinDir = "";

function runScript(args, extraEnv = {}) {
  return new Promise((resolve) => {
    execFile(
      "bash",
      [scriptPath, ...args],
      {
        cwd: root,
        env: {
          ...process.env,
          HOME: tempHome,
          LAUNCHCTL_BIN: path.join(fakeBinDir, "launchctl"),
          ...extraEnv,
        },
      },
      (error, stdout, stderr) => resolve({ stdout: String(stdout), stderr: String(stderr), code: error?.code ?? 0 }),
    );
  });
}

before(async () => {
  tempHome = await mkdtemp(path.join(os.tmpdir(), "homepage-reclaim-launchd."));
  fakeBinDir = path.join(tempHome, "fake-bin");
  await mkdir(fakeBinDir, { recursive: true });
  // 假 launchctl：记录调用、恒定成功
  await writeFile(
    path.join(fakeBinDir, "launchctl"),
    `#!/bin/bash
echo "launchctl $*" >> "${path.join(fakeBinDir, "calls.log")}"
exit 0
`,
    { mode: 0o755 },
  );
});

after(async () => {
  if (tempHome) await rm(tempHome, { recursive: true, force: true }).catch(() => {});
});

async function launchctlLog() {
  try {
    return (await readFile(path.join(fakeBinDir, "calls.log"), "utf8")).trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

describe("setup-tombstone-reclaim.sh", () => {
  const plistPath = () => path.join(tempHome, "Library", "LaunchAgents", "com.homepage.tombstone-reclaim.plist");

  it("installs a launch agent with force mode and custom hour", async () => {
    const result = await runScript([
      "install",
      "--force",
      "--hour",
      "04:15",
      "--url",
      "http://127.0.0.1:9999",
      "--token",
      "secret-token",
    ]);
    assert.equal(result.code, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
    assert.match(result.stdout, /已安装 com\.homepage\.tombstone-reclaim：每天 04:15 执行 --force/);

    const plist = await readFile(plistPath(), "utf8");
    assert.match(plist, /<string>com\.homepage\.tombstone-reclaim<\/string>/);
    assert.match(plist, new RegExp(path.join(root, "scripts", "run-tombstone-reclaim.sh").replace(/\./g, "\\.")));
    assert.match(plist, /<string>--force<\/string>/);
    assert.match(plist, /<key>Hour<\/key>\s*<integer>4<\/integer>/);
    assert.match(plist, /<key>Minute<\/key>\s*<integer>15<\/integer>/);
    assert.match(plist, /http:\/\/127\.0\.0\.1:9999/);
    assert.match(plist, /secret-token/);
    assert.match(plist, /tombstone-reclaim\.log/);
    assert.match(plist, /<key>RunAtLoad<\/key>\s*<false\/>/, "不得装载即跑（等待每日定时）");

    // env 文件权限 600（Token 落盘收紧）
    const envStat = await stat(path.join(tempHome, "Library", "LaunchAgents", "com.homepage.tombstone-reclaim.env"));
    assert.equal(envStat.mode & 0o777, 0o600);

    // 幂等：重复 install 先 unload 再 load
    const again = await runScript(["install", "--force", "--hour", "04:15"]);
    assert.equal(again.code, 0);
    const log = await launchctlLog();
    assert.ok(
      log.some((line) => line.includes("unload")),
      "重复安装前先卸载旧作业",
    );
    assert.ok(log.filter((line) => line.includes("load ")).length >= 2, "再次 load 新作业");
  });

  it("defaults to dry-run mode at 03:30", async () => {
    const result = await runScript(["install"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /每天 03:30 执行 --dry-run/);
    const plist = await readFile(plistPath(), "utf8");
    assert.match(plist, /<string>--dry-run<\/string>/);
    assert.match(plist, /<key>Hour<\/key>\s*<integer>3<\/integer>/);
  });

  it("status reports installed state and plist details", async () => {
    const result = await runScript(["status"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /\[status\] plist:/);
    assert.match(result.stdout, /run-tombstone-reclaim/);
  });

  it("uninstall removes the plist and env file", async () => {
    const result = await runScript(["uninstall"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /已卸载/);
    await assert.rejects(readFile(plistPath()));
    await assert.rejects(
      readFile(path.join(tempHome, "Library", "LaunchAgents", "com.homepage.tombstone-reclaim.env")),
    );
    // 再次卸载：未安装但退出码 2（非错误路径仍算成功清理）
    const again = await runScript(["uninstall"]);
    assert.equal(again.code, 2);
    assert.match(again.stdout, /未安装/);
    // 未安装时 status 退出码 2
    const status = await runScript(["status"]);
    assert.equal(status.code, 2);
  });

  it("rejects unknown actions and invalid hour values", async () => {
    const badAction = await runScript(["explode"]);
    assert.equal(badAction.code, 1);
    assert.match(badAction.stderr, /未知动作/);

    const badFlag = await runScript(["install", "--nuke"]);
    assert.equal(badFlag.code, 1);
    assert.match(badFlag.stderr, /未知参数/);

    const badHour = await runScript(["install", "--hour", "25:00"]);
    assert.equal(badHour.code, 1);
    assert.match(badHour.stderr, /小时必须在 0-23/);

    const badFormat = await runScript(["install", "--hour", "3pm"]);
    assert.equal(badFormat.code, 1);
    assert.match(badFormat.stderr, /HH:MM/);
  });
});
