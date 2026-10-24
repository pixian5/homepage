#!/usr/bin/env node
// Firefox 同步“分支流程”端到端：冲突弹窗三选一、同步包导入、周期同步。
//
// 与 run-firefox-persistence / run-firefox-sync-ui 一样：
//   - 临时 profile + 临时扩展副本；
//   - 本机临时同步服务（独立临时数据文件），不连生产、不联网；
//   - 只点真实 UI 控件，不直接调用同步引擎。
//
// 依赖真实 index.html 里的按钮 id：
//   btnConflictMerge / btnConflictLocal / btnConflictRemote / btnConflictCancel
//   btnSyncExportBundle / btnSyncImportBundle / btnSyncExportFile / btnSyncImportFile
//   settingSyncInterval
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultData } from "../src/js/storage.js";
import { httpPullState, httpPushState } from "../src/js/sync_http_transport.js";
import { toSyncDocument } from "../src/js/sync_projection.js";
import { stopBrowser } from "../tests/helpers/browser-process.js";

const root = fileURLToPath(new URL("../", import.meta.url));
// 冲突弹窗有三个分支，各跑一次独立 profile，避免上一轮的 docId 影响下一轮。
const choiceArg = process.argv.find((arg) => arg.startsWith("--choice="));
const conflictChoice = choiceArg ? choiceArg.split("=")[1] : "merge";
assert.ok(["merge", "local", "remote"].includes(conflictChoice), "--choice 只能是 merge / local / remote");
const binary = process.env.FIREFOX_E2E_BINARY || "/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox";
const token = "hp-sync-flows-token";
const temp = await mkdtemp(path.join(os.tmpdir(), "homepage-firefox-sync-flows-"));
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
  const runner = await readFile(path.join(root, "tests/firefox-sync-flows/runner.js"), "utf8");
  await writeFile(
    path.join(extension, "js/sync-flows-runner.js"),
    `globalThis.HOMEPAGE_SYNC_FLOWS = ${JSON.stringify({ token, baseUrl, reportUrl, conflictChoice })};\n${runner}`,
  );
  const htmlPath = path.join(extension, "newtab.html");
  const html = await readFile(htmlPath, "utf8");
  const patched = html.replace(
    /<script(?: type="module")? src="js\/app(?:\.ff)?\.js"><\/script>/,
    '<script src="js/sync-flows-runner.js"></script>',
  );
  assert.notEqual(patched, html, "缺少打包入口脚本");
  await writeFile(htmlPath, patched);

  const manifestPath = path.join(extension, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.background.scripts.push("js/sync-flows-open.js");
  await writeFile(manifestPath, JSON.stringify(manifest));
  await writeFile(
    path.join(extension, "js/sync-flows-open.js"),
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
let server;
let reportServer;
try {
  let reportResolve;
  const reportPromise = new Promise((resolve) => {
    reportResolve = resolve;
  });
  reportServer = createServer(async (req, res) => {
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

  // 预置一个“别人的”云端文档：docId 与浏览器本地随机 docId 必然不同，
  // 用来触发真实的 doc_conflict 分支。同时放一张独有书签，验证 merge/remote 分支。
  const remoteSeed = defaultData();
  remoteSeed.settings.language = "zh-CN";
  remoteSeed.nodes.remote_only = {
    id: "remote_only",
    type: "item",
    title: "云端独有书签",
    url: "https://example.invalid/remote-only",
    iconType: "letter",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  remoteSeed.groups[0].nodes.push("remote_only");
  const seedDoc = toSyncDocument(remoteSeed, {
    deviceId: "remote_device",
    docId: "doc_remote_seed",
    revision: 1,
    writtenAt: Date.now(),
  });
  const seeded = await httpPushState({ baseUrl, token }, seedDoc, { idempotencyKey: `sync-flows-seed-${Date.now()}` });
  assert.equal(seeded.ok, true, `预置云端失败：${seeded.reason}`);

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
  const timer = setTimeout(() => reportResolve({ failure: `超时\n${output}` }), 150000);
  const report = await reportPromise;
  clearTimeout(timer);
  await stopBrowser(browser);
  if (report.failure) throw new Error(report.failure);

  const pulled = await httpPullState({ baseUrl, token });
  console.log(
    JSON.stringify(
      { status: "passed", choice: conflictChoice, report, server: { revision: pulled.revision } },
      null,
      2,
    ),
  );
} catch (error) {
  exitCode = 1;
  console.error(`Firefox 同步分支流程验证失败：${error?.message || error}`);
} finally {
  if (server) await stopBrowser(server.child);
  if (reportServer) {
    reportServer.closeAllConnections();
    await new Promise((resolve) => reportServer.close(resolve));
  }
  await rm(temp, { recursive: true, force: true });
}

process.exit(exitCode);
