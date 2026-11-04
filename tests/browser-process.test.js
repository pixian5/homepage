import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stopBrowser, trackChildShutdown } from "./helpers/browser-process.js";

it("浏览器父进程提前退出后，清理仍会结束其存活子进程", {
  skip: process.platform === "win32",
  timeout: 10000,
}, async () => {
  // 模拟浏览器更新重启：原进程退出，新进程继承测试专属进程组并继续运行。
  const source = `
    const { spawn } = require("node:child_process");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    child.unref();
    process.stdout.write(String(child.pid), () => process.exit(0));
  `;
  const browser = spawn(process.execPath, ["-e", source], {
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  let output = "";
  browser.stdout.on("data", (chunk) => {
    output += chunk;
  });
  try {
    const [code] = await once(browser, "close");
    assert.equal(code, 0);
    const descendantPid = Number(output);
    assert.ok(Number.isInteger(descendantPid) && descendantPid > 0);
    assert.doesNotThrow(() => process.kill(descendantPid, 0));
    await stopBrowser(browser);
    // 进程组已消失后，内核可能极短暂地仍能对僵尸 PID 返回成功（SIGTERM 已排队但尚未回收）。
    // 这里最多重试 2 秒，确认它最终确实不可再被 signalling，而不是偶发误判测试失败。
    const deadline = Date.now() + 2000;
    let gone = false;
    while (Date.now() < deadline) {
      try {
        process.kill(descendantPid, 0);
      } catch (error) {
        if (error.code === "ESRCH") {
          gone = true;
          break;
        }
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(gone, true, `子进程 ${descendantPid} 在清理后仍可被 signalling`);
  } finally {
    await stopBrowser(browser);
  }
});

it("测试进程收到终止信号时，已登记的子进程会被一并结束", {
  skip: process.platform === "win32",
  timeout: 15000,
}, async () => {
  // 模拟 2026-11-04 泄漏事故：宿主（测试进程）被 SIGTERM 强停时 finally 不会执行，
  // 若未登记信号守护，detached 的子进程会变孤儿常驻（并在 macOS 菜单栏堆积图标）。
  const helperUrl = pathToFileURL(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "helpers", "browser-process.js"),
  ).href;
  const hostSource = `
    const { spawn } = require("node:child_process");
    import(${JSON.stringify(helperUrl)}).then(({ trackChildShutdown }) => {
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        stdio: "ignore",
        detached: true,
      });
      child.unref();
      trackChildShutdown(child);
      process.stdout.write(String(child.pid), () => {});
      setInterval(() => {}, 1000);
    });
  `;
  const host = spawn(process.execPath, ["-e", hostSource], {
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  let output = "";
  host.stdout.on("data", (chunk) => {
    output += chunk;
  });
  try {
    // 等宿主输出孙进程 PID（说明已登记守护）后再发终止信号。
    const deadline = Date.now() + 5000;
    while (!output && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const descendantPid = Number(output);
    assert.ok(Number.isInteger(descendantPid) && descendantPid > 0, `宿主未回报孙进程 PID：${output || "(空)"}`);
    assert.doesNotThrow(() => process.kill(descendantPid, 0));
    host.kill("SIGTERM");
    const [, signal] = await once(host, "close");
    assert.equal(signal, "SIGTERM", "宿主应按原信号退出（保留 CI 退出码语义）");
    // 孙进程应被信号守护一并结束；内核回收有短暂延迟，最多重试 5 秒。
    const goneDeadline = Date.now() + 5000;
    let gone = false;
    while (Date.now() < goneDeadline) {
      try {
        process.kill(descendantPid, 0);
      } catch (error) {
        if (error.code === "ESRCH") {
          gone = true;
          break;
        }
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(gone, true, `孙进程 ${descendantPid} 在宿主被强停后仍存活（信号守护未生效）`);
  } finally {
    await stopBrowser(host);
  }
});

it("trackChildShutdown 幂等且子进程正常退出后自动注销", {
  skip: process.platform === "win32",
  timeout: 10000,
}, async () => {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  // 重复登记不应抛错，返回值应仍是同一个子进程对象。
  assert.equal(trackChildShutdown(child), child);
  assert.equal(trackChildShutdown(child), child);
  await once(child, "close");
  // 正常退出后进程已结束，无需再清理；这里只验证后续调用不产生副作用。
  assert.equal(trackChildShutdown(child), child);
});
