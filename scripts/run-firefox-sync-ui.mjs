#!/usr/bin/env node
// Firefox 同步设置界面端到端验证（真实 UI 事件 + 本地同步服务）。
//
// 覆盖单元测试覆盖不到的部分：设置面板里的同步开关、服务器地址/Token 输入、
// “测试服务器”“立即同步”按钮，以及同步后服务端是否真的收到数据。
//
// 全程使用临时 Firefox profile、临时扩展副本和临时数据文件；
// 不读取用户真实配置，不连接生产服务器，也不需要联网。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { httpPullState } from "../src/js/sync_http_transport.js";
import { stopBrowser } from "../tests/helpers/browser-process.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const binary = process.env.FIREFOX_E2E_BINARY || "/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox";
const token = "hp-sync-ui-local-token";
const temp = await mkdtemp(path.join(os.tmpdir(), "homepage-firefox-sync-ui-"));
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
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return { child, output: () => output };
    } catch {
      // 继续等待
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`同步服务未能就绪：\n${output}`);
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

async function prepareExtension(baseUrl, reportUrl) {
  await mkdir(profile, { recursive: true });
  await cp(path.join(root, "dist", "firefox"), extension, { recursive: true });
  const runner = await readFile(path.join(root, "tests/firefox-sync-ui/runner.js"), "utf8");
  await writeFile(
    path.join(extension, "js/sync-ui-runner.js"),
    `globalThis.HOMEPAGE_SYNC_UI = ${JSON.stringify({ token, baseUrl, reportUrl })};\n${runner}`,
  );
  const htmlPath = path.join(extension, "newtab.html");
  const html = await readFile(htmlPath, "utf8");
  const patched = html.replace(
    /<script(?: type="module")? src="js\/app(?:\.ff)?\.js"><\/script>/,
    '<script src="js/sync-ui-runner.js"></script>',
  );
  assert.notEqual(patched, html, "缺少打包入口脚本");
  await writeFile(htmlPath, patched);

  const manifestPath = path.join(extension, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.background.scripts.push("js/sync-ui-open.js");
  await writeFile(manifestPath, JSON.stringify(manifest));
  await writeFile(
    path.join(extension, "js/sync-ui-open.js"),
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
    ].join("\n"),
  );
  await packExtension();
}

let exitCode = 0;
let server;
try {
  let reportResolve;
  const reportPromise = new Promise((resolve) => {
    reportResolve = resolve;
  });
  const reportServer = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    res.end("ok");
    reportResolve(JSON.parse(body));
  });
  await new Promise((resolve) => reportServer.listen(0, "127.0.0.1", resolve));
  const reportUrl = `http://127.0.0.1:${reportServer.address().port}/report`;
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  server = await startSyncServer(port);
  await prepareExtension(baseUrl, reportUrl);

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
  const timer = setTimeout(() => reportResolve({ failure: `超时\n${output}` }), 90000);
  const report = await reportPromise;
  clearTimeout(timer);
  await stopBrowser(browser);
  if (report.failure) throw new Error(report.failure);

  // 服务端断言：同步确实落到独立数据文件，revision 推进且节点存在
  const pulled = await httpPullState({ baseUrl, token });
  assert.equal(pulled.ok, true, `服务端拉取失败：${pulled.reason}`);
  assert.ok(pulled.revision >= 2, `服务端 revision 未推进：${pulled.revision}`);
  const nodeCount = Object.keys(pulled.doc.nodes || {}).length;
  assert.ok(nodeCount >= 1, "服务端没有收到节点");
  const disk = JSON.parse(await readFile(stateFile, "utf8"));
  assert.equal(disk.revision, pulled.revision, "磁盘与内存 revision 不一致");

  console.log(
    JSON.stringify(
      { status: "passed", checks: report.checks, revision: pulled.revision, serverNodes: nodeCount },
      null,
      2,
    ),
  );
  reportServer.closeAllConnections();
  await new Promise((resolve) => reportServer.close(resolve));
} catch (error) {
  exitCode = 1;
  console.error(`Firefox 同步界面验证失败：${error?.message || error}`);
} finally {
  if (server) await stopBrowser(server.child);
  await rm(temp, { recursive: true, force: true });
}

process.exit(exitCode);
