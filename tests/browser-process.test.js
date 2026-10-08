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
    assert.throws(() => process.kill(descendantPid, 0), { code: "ESRCH" });
  } finally {
    await stopBrowser(browser);
  }
});
