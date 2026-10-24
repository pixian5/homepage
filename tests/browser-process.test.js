import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { it } from "node:test";
import { stopBrowser } from "./helpers/browser-process.js";

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
