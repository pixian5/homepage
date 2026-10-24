#!/usr/bin/env node
// Firefox 持久化 / 重装 / 导入导出 端到端验证。
//
// 只使用临时 profile 与临时扩展副本，不读取也不影响用户真实 Firefox 配置，
// 不需要联网，也不依赖 Chrome（谷歌浏览器），可在用户继续使用 Chrome 时运行。
//
// 覆盖：
//   1. 界面新增书签后落盘；重启浏览器后仍在；
//   2. 备份管理恢复能回滚设置；
//   3. 导出按钮产出完整 JSON；
//   4. 删除扩展存储（等价于卸载/重装）后数据确实丢失；
//   5. 用导出的 JSON 通过导入面板覆盖恢复，重启后仍在。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stopBrowser } from "../tests/helpers/browser-process.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const binary = process.env.FIREFOX_E2E_BINARY || "/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox";
const extensionSource = path.join(root, "dist", "firefox");
const results = [];

await access(binary).catch(() => {
  throw new Error(`Firefox（火狐浏览器）不存在：${binary}`);
});

const temp = await mkdtemp(path.join(os.tmpdir(), "homepage-firefox-persist-"));
const profile = path.join(temp, "profile");
const extension = path.join(temp, "extension");
await mkdir(profile, { recursive: true });
await cp(extensionSource, extension, { recursive: true });

// Firefox 的 storage.local 落在 profile/storage/default/moz-extension+++<uuid>。
// 临时扩展的 UUID 每次安装可能变化，按目录内容识别，而不是写死。
async function extensionStorageDirs() {
  const base = path.join(profile, "storage", "default");
  const entries = await readdir(base, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("moz-extension+++"))
    .map((entry) => path.join(base, entry.name));
}

async function prepareRunner(phase, payload = {}) {
  const config = { phase, ...payload };
  await writeFile(
    path.join(extension, "js/persist-runner.js"),
    `globalThis.HOMEPAGE_PERSIST = ${JSON.stringify(config)};\n${await readFile(
      path.join(root, "tests/firefox-persistence/runner.js"),
      "utf8",
    )}`,
  );
  const htmlFile = path.join(extension, "newtab.html");
  const html = await readFile(htmlFile, "utf8");
  if (!html.includes("js/persist-runner.js")) {
    const patched = html.replace(
      /<script(?: type="module")? src="js\/app(?:\.ff)?\.js"><\/script>/,
      '<script src="js/persist-runner.js"></script>',
    );
    assert.notEqual(patched, html, "缺少打包入口脚本");
    await writeFile(htmlFile, patched);
  }
  // 每次启动都打开新标签页：首次安装用 onInstalled，之后用 onStartup。
  await writeFile(
    path.join(extension, "js/persist-open.js"),
    [
      "const api = globalThis.browser || chrome;",
      'const open = () => api.tabs.create({ url: "newtab.html" });',
      "api.runtime.onInstalled.addListener(open);",
      "api.runtime.onStartup.addListener(open);",
    ].join("\n"),
  );
  const manifestFile = path.join(extension, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  if (!manifest.background.scripts.includes("js/persist-open.js")) {
    manifest.background.scripts.push("js/persist-open.js");
    await writeFile(manifestFile, JSON.stringify(manifest));
  }
  // 首次启动需要 xpi；后续启动沿用已安装扩展，但重写 xpi 保证代码一致。
  const xpi = path.join(profile, "extensions", `${manifest.browser_specific_settings.gecko.id}.xpi`);
  await mkdir(path.dirname(xpi), { recursive: true });
  await rm(xpi, { force: true });
  await new Promise((resolve, reject) => {
    const zip = spawn("zip", ["-X", "-r", "-q", xpi, "."], { cwd: extension, stdio: "ignore" });
    zip.once("error", reject);
    zip.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`扩展压缩失败：${code}`))));
  });
}

let reportServer;
let reportResolve;
let reportPromise;
function startReportServer() {
  reportServer = createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(404).end();
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    res.end("ok");
    reportResolve(JSON.parse(body));
  });
  return new Promise((resolve) => reportServer.listen(0, "127.0.0.1", () => resolve(reportServer.address().port)));
}
function nextReport() {
  reportPromise = new Promise((resolve) => {
    reportResolve = resolve;
  });
  return reportPromise;
}

async function launch(phase, payload) {
  await prepareRunner(phase, { ...payload, reportUrl: `http://127.0.0.1:${reportPort}/report` });
  const child = spawn(binary, ["--headless", "--no-remote", "--new-instance", "--profile", profile, "about:blank"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, MOZ_HEADLESS: "1", MOZ_NO_REMOTE: "1" },
    detached: process.platform !== "win32",
  });
  let output = "";
  const capture = (chunk) => {
    output = (output + chunk).slice(-8000);
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  const timer = setTimeout(() => reportResolve({ phase, failure: `超时\n${output}` }), 60000);
  const report = await reportPromise;
  clearTimeout(timer);
  await stopBrowser(child);
  if (report.failure) throw new Error(`${phase} 失败：${report.failure}\n${output}`);
  results.push(report);
  console.log(JSON.stringify(report));
  return report;
}

let reportPort;
try {
  reportPort = await startReportServer();

  await writeFile(
    path.join(profile, "user.js"),
    [
      'user_pref("xpinstall.signatures.required", false);',
      'user_pref("extensions.autoDisableScopes", 0);',
      'user_pref("extensions.enabledScopes", 15);',
      'user_pref("browser.shell.checkDefaultBrowser", false);',
      'user_pref("app.update.disabledForTesting", true);',
      'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
      'user_pref("browser.startup.homepage_override.mstone", "ignore");',
    ].join("\n"),
  );

  // 阶段 1：新增书签 + 备份恢复 + 导出
  nextReport();
  const seeded = await launch("seed");

  // 阶段 2：同一 profile 重启，数据应保留；同时验证导出与备份恢复
  nextReport();
  const restarted = await launch("verify", { exportText: seeded.exportText });

  // 阶段 3：删除扩展存储（等价卸载/重装），数据应丢失；再用导出的 JSON 导入恢复
  const dirs = await extensionStorageDirs();
  assert.ok(dirs.length > 0, "找不到 Firefox 扩展存储目录");
  // 临时扩展每次安装的 UUID 可能不同，会留下多个目录；全部删掉才等价于卸载。
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  // Firefox 还会把扩展存储元数据写在 storage-sync-v2.sqlite 等处，一并清掉。
  for (const name of ["storage-sync-v2.sqlite", "storage-sync-v2.sqlite-wal", "storage-sync-v2.sqlite-shm"]) {
    await rm(path.join(profile, name), { force: true });
  }
  nextReport();
  const reinstalled = await launch("reinstall", { importText: seeded.exportText });

  // 阶段 4：再次重启，确认导入结果持久化
  nextReport();
  const final = await launch("verify-import");

  const summary = {
    seeded: { nodes: seeded.nodeCount, backups: seeded.backupCount, exportedBytes: seeded.exportText.length },
    restart: { nodes: restarted.nodeCount, kept: restarted.keptTestNode },
    reinstall: { storageCleared: reinstalled.storageWasEmpty, importedNodes: reinstalled.nodeCount },
    final: { nodes: final.nodeCount, kept: final.keptTestNode },
  };
  console.log("\n=== 汇总 ===");
  console.log(JSON.stringify(summary, null, 2));
  await writeFile(
    path.join(root, "logs", "firefox-persistence-summary.json"),
    JSON.stringify({ at: new Date().toISOString(), summary, results }, null, 2),
  );
} finally {
  reportServer?.closeAllConnections();
  await new Promise((resolve) => reportServer?.close(resolve));
  await rm(temp, { recursive: true, force: true });
}
