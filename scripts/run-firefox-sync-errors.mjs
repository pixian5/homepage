#!/usr/bin/env node
// Firefox 同步异常分支 + 同步包文件入口端到端验证。
//
// 结构：真实 sync-server（127.0.0.1 临时端口）+ 故障注入代理（另一个临时端口）。
// 浏览器只连接代理，代理可切换 pass / 401 / 500 / timeout / reset，
// 因此无需改生产代码就能验证客户端在各种失败下的表现。
//
// 覆盖：
//   1. 正常同步（基线）
//   2. 错误 Token → 401 提示
//   3. 服务端 500 → 错误状态 + outbox 入队
//   4. 连接被重置 → network_error 提示
//   5. 请求超时（10 秒客户端超时）
//   6. 恢复后 outbox 自动补发、状态回到 idle
//   7. 同步包「导出文件 / 导入文件」真实入口
//
// 全程临时 profile + 临时扩展副本 + 临时数据文件，不碰真实配置与生产服务器。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { httpPullState } from "../src/js/sync_http_transport.js";
import { stopBrowser } from "../tests/helpers/browser-process.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const binary = process.env.FIREFOX_E2E_BINARY || "/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox";
const token = "hp-sync-errors-token";
const temp = await mkdtemp(path.join(os.tmpdir(), "homepage-firefox-sync-errors-"));
const profile = path.join(temp, "profile");
const extension = path.join(temp, "extension");
const stateFile = path.join(temp, "state.json");

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function startSyncServer(port) {
  const child = spawn(process.execPath, [path.join(root, "scripts/sync-server.mjs")], {
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), TOKEN: token, DATA_FILE: stateFile },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return { child, output: () => output };
    } catch {
      // 继续等待
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`同步服务未能就绪：\n${output}`);
}

// 故障注入代理：mode 由测试驱动切换，浏览器始终只看到这一个地址。
function startFaultProxy(targetPort, port) {
  const state = { mode: "pass", requests: 0 };
  const server = createServer((req, res) => {
    state.requests += 1;
    const mode = state.mode;
    if (mode === "401") {
      res.writeHead(401, { "Content-Type": "application/json" }).end('{"error":"unauthorized"}');
      return;
    }
    if (mode === "500") {
      res.writeHead(500, { "Content-Type": "application/json" }).end('{"error":"injected_failure"}');
      return;
    }
    if (mode === "timeout") {
      // 客户端 10 秒超时，这里拖到 12 秒
      setTimeout(() => {
        if (!res.destroyed) res.writeHead(504).end('{"error":"too_slow"}');
      }, 12000);
      return;
    }
    if (mode === "reset") {
      req.socket.destroy();
      return;
    }
    const upstream = net.connect(targetPort, "127.0.0.1", () => {
      const headers = Object.entries(req.headers)
        .map(([key, value]) => `${key}: ${value}`)
        .join("\r\n");
      upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${headers}\r\n\r\n`);
      req.pipe(upstream);
    });
    upstream.on("data", (chunk) => res.write(chunk));
    upstream.on("end", () => res.end());
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502).end('{"error":"upstream"}');
      else res.destroy();
    });
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve({ server, state }));
  });
}

async function packExtension() {
  const manifest = JSON.parse(await readFile(path.join(extension, "manifest.json"), "utf8"));
  const xpi = path.join(profile, "extensions", `${manifest.browser_specific_settings.gecko.id}.xpi`);
  await mkdir(path.dirname(xpi), { recursive: true });
  await rm(xpi, { force: true });
  await new Promise((resolve, reject) => {
    const zip = spawn("zip", ["-X", "-r", "-q", xpi, "."], { cwd: extension, stdio: "ignore" });
    zip.once("error", reject);
    zip.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`扩展压缩失败：${code}`))));
  });
}

async function prepareExtension(proxyUrl, reportUrl, controlUrl) {
  await mkdir(profile, { recursive: true });
  await cp(path.join(root, "dist", "firefox"), extension, { recursive: true });
  const runner = await readFile(path.join(root, "tests/firefox-sync-errors/runner.js"), "utf8");
  await writeFile(
    path.join(extension, "js/sync-errors-runner.js"),
    `globalThis.HOMEPAGE_SYNC_ERRORS = ${JSON.stringify({ token, proxyUrl, reportUrl, controlUrl })};\n${runner}`,
  );
  const htmlPath = path.join(extension, "newtab.html");
  const html = await readFile(htmlPath, "utf8");
  const patched = html.replace(
    /<script(?: type="module")? src="js\/app(?:\.ff)?\.js"><\/script>/,
    '<script src="js/sync-errors-runner.js"></script>',
  );
  assert.notEqual(patched, html, "缺少打包入口脚本");
  await writeFile(htmlPath, patched);

  const manifestPath = path.join(extension, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.background.scripts.push("js/sync-errors-open.js");
  await writeFile(manifestPath, JSON.stringify(manifest));
  await writeFile(
    path.join(extension, "js/sync-errors-open.js"),
    [
      "const api = globalThis.browser || chrome;",
      'const open = () => api.tabs.create({ url: "newtab.html" });',
      "api.runtime.onInstalled.addListener(open);",
      "api.runtime.onStartup.addListener(open);",
    ].join("\n"),
  );
  await writeFile(
    path.join(profile, "user.js"),
    [
      'user_pref("xpinstall.signatures.required", false);',
      'user_pref("extensions.autoDisableScopes", 0);',
      'user_pref("extensions.enabledScopes", 15);',
      'user_pref("browser.shell.checkDefaultBrowser", false);',
      'user_pref("app.update.disabledForTesting", true);',
      'user_pref("browser.startup.page", 0);',
      'user_pref("browser.sessionstore.resume_from_crash", false);',
      'user_pref("browser.download.folderList", 2);',
      `user_pref("browser.download.dir", ${JSON.stringify(path.join(temp, "downloads"))});`,
      'user_pref("browser.download.useDownloadDir", true);',
      'user_pref("browser.helperApps.neverAsk.saveToDisk", "application/json");',
      // 临时 profile 也会连 Firefox 账号同步、扩展推荐与遥测，测试期间全部关闭。
      'user_pref("identity.fxaccounts.enabled", false);',
      'user_pref("services.sync.engine.addons", false);',
      'user_pref("services.sync.engine.bookmarks", false);',
      'user_pref("services.sync.engine.history", false);',
      'user_pref("services.sync.engine.prefs", false);',
      'user_pref("services.sync.engine.tabs", false);',
      'user_pref("extensions.getAddons.cache.enabled", false);',
      'user_pref("extensions.systemAddon.update.enabled", false);',
      'user_pref("browser.discovery.enabled", false);',
      'user_pref("app.update.auto", false);',
      'user_pref("app.update.enabled", false);',
      'user_pref("toolkit.telemetry.enabled", false);',
      'user_pref("toolkit.telemetry.archive.enabled", false);',
      'user_pref("browser.newtabpage.activity-stream.feeds.section.topstories", false);',
    ].join("\n"),
  );
  await packExtension();
}

let exitCode = 0;
let syncServer;
let proxy;
let reportServer;
try {
  let reportResolve;
  const reportPromise = new Promise((resolve) => {
    reportResolve = resolve;
  });
  reportServer = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    if (req.method === "POST" && req.url === "/control") {
      const { mode } = JSON.parse(body);
      proxy.state.mode = mode;
      res.end(JSON.stringify({ mode }));
      return;
    }
    res.end("ok");
    reportResolve(JSON.parse(body));
  });
  await new Promise((resolve) => reportServer.listen(0, "127.0.0.1", resolve));
  const controlUrl = `http://127.0.0.1:${reportServer.address().port}/control`;
  const reportUrl = `http://127.0.0.1:${reportServer.address().port}/report`;

  const serverPort = await freePort();
  const proxyPort = await freePort();
  syncServer = await startSyncServer(serverPort);
  proxy = await startFaultProxy(serverPort, proxyPort);
  await prepareExtension(`http://127.0.0.1:${proxyPort}`, reportUrl, controlUrl);

  const browser = spawn(binary, ["--headless", "--no-remote", "--new-instance", "--profile", profile, "about:blank"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, MOZ_HEADLESS: "1", MOZ_NO_REMOTE: "1" },
    detached: process.platform !== "win32",
  });
  let output = "";
  const capture = (chunk) => {
    output = (output + chunk).slice(-8000);
  };
  browser.stdout.on("data", capture);
  browser.stderr.on("data", capture);
  const timer = setTimeout(() => reportResolve({ failure: `超时\n${output}` }), 180000);
  const report = await reportPromise;
  clearTimeout(timer);
  await stopBrowser(browser);
  console.log("browser report:", JSON.stringify(report).slice(0, 3000));
  if (report.failure) throw new Error(report.failure);

  // 恢复后 outbox 应被清空，且服务端拿到数据
  const pulled = await httpPullState({ baseUrl: `http://127.0.0.1:${proxyPort}`, token });
  console.log(
    JSON.stringify(
      { status: "passed", checks: report.checks, server: { revision: pulled.revision, controlUrl } },
      null,
      2,
    ),
  );
} catch (error) {
  exitCode = 1;
  console.error(`Firefox 同步异常分支验证失败：${error?.message || error}`);
} finally {
  if (syncServer) await stopBrowser(syncServer.child);
  if (proxy) {
    proxy.server.closeAllConnections();
    await new Promise((resolve) => proxy.server.close(resolve));
  }
  if (reportServer) {
    reportServer.closeAllConnections();
    await new Promise((resolve) => reportServer.close(resolve));
  }
  await rm(temp, { recursive: true, force: true });
}

process.exit(exitCode);
