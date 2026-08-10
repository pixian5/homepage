#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, chmod, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { httpPullState, httpPushState } from "../src/js/sync_http_transport.js";
import { toSyncDocument } from "../src/js/sync_projection.js";
import { startCoordinator } from "../tests/browser-sync-e2e/coordinator.mjs";
import { wrapFirefoxE2ERunner } from "../tests/browser-sync-e2e/firefox-runner.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baseUrl = process.env.HOMEPAGE_E2E_BASE_URL || "https://sf.sbbz.tech:58444";
const token = String(process.env.HOMEPAGE_E2E_TOKEN || process.env.TOKEN || "").trim();
const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`;
const resultDir = path.resolve(
  process.env.HOMEPAGE_E2E_RESULT_DIR || path.join(root, "test-results", "browser-sync-e2e", runId),
);
const backupPath = path.join(resultDir, "cloud-backup.json");
const reportPath = path.join(resultDir, "report.json");
const nonce = randomBytes(24).toString("hex");
const docId = `browser_e2e_${runId.replace(/[^a-z0-9]/gi, "_").toLowerCase()}`;
const syncConfig = { baseUrl, token };
const events = [];
const children = [];
let coordinator = null;
let tempRoot = "";
let cloudBackup = null;
let cloudMutated = false;
const report = {
  runId,
  startedAt: new Date().toISOString(),
  baseUrl,
  docId,
  status: "running",
  events,
};

function normalizedHash(doc) {
  const value = structuredClone(doc);
  delete value.revision;
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function firstExecutable(candidates) {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Try the next installed browser.
    }
  }
  throw new Error(`browser executable not found: ${candidates.filter(Boolean).join(", ")}`);
}

async function findActiveFirefoxHomepageStorage() {
  const configuredProfile = process.env.HOMEPAGE_E2E_FIREFOX_PROFILE;
  const profilesRoot = path.join(os.homedir(), "Library", "Application Support", "Firefox", "Profiles");
  const profiles = configuredProfile
    ? [configuredProfile]
    : (await readdir(profilesRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(profilesRoot, entry.name));

  for (const profile of profiles) {
    try {
      const settings = JSON.parse(await readFile(path.join(profile, "extension-settings.json"), "utf8"));
      const entries = settings?.url_overrides?.newTabURL?.precedenceList || [];
      const current = entries.find((entry) => entry.id === "homepage@pixian5.github.io" && entry.enabled);
      const uuid = current?.value?.match(/^moz-extension:\/\/([a-f0-9-]+)\/newtab\.html$/i)?.[1];
      if (!uuid) continue;
      const storageDir = path.join(profile, "storage", "default", `moz-extension+++${uuid}`);
      const syncDatabase = path.join(profile, "storage-sync-v2.sqlite");
      await access(syncDatabase, fsConstants.R_OK);
      return { profile, uuid, storageDir, syncDatabase };
    } catch {
      // A profile without this extension is not a usable source.
    }
  }
  throw new Error("active Firefox homepage extension storage was not found");
}

async function sqliteBackup(source, destination) {
  await new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/sqlite3", [source, `.backup ${destination}`], { stdio: ["ignore", "pipe", "pipe"] });
    const errors = [];
    child.stderr.on("data", (chunk) => errors.push(Buffer.from(chunk)));
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`SQLite backup failed (${code}): ${Buffer.concat(errors).toString("utf8")}`));
    });
  });
}

async function sqliteExecute(database, command) {
  await new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/sqlite3", [database, command], { stdio: ["ignore", "pipe", "pipe"] });
    const errors = [];
    child.stderr.on("data", (chunk) => errors.push(Buffer.from(chunk)));
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`SQLite command failed (${code}): ${Buffer.concat(errors).toString("utf8")}`));
    });
  });
}

async function copyFirefoxHomepageStorage(source, profile) {
  const sourceRoot = path.dirname(source.storageDir);
  const destinationRoot = path.join(profile, "storage", "default");
  await mkdir(destinationRoot, { recursive: true, mode: 0o700 });
  const prefix = `moz-extension+++${source.uuid}`;
  const sourceDirs = (await readdir(sourceRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
    .map((entry) => entry.name);
  for (const name of sourceDirs) {
    const from = path.join(sourceRoot, name);
    const to = path.join(destinationRoot, name);
    await cp(from, to, { recursive: true, force: true });
    const localDatabase = path.join(from, "ls", "data.sqlite");
    try {
      await access(localDatabase, fsConstants.R_OK);
      await sqliteBackup(localDatabase, path.join(to, "ls", "data.sqlite"));
    } catch {
      // This origin uses IndexedDB instead of localStorage.
    }
  }
  const registry = path.join(profile, "storage.sqlite");
  await sqliteBackup(path.join(source.profile, "storage.sqlite"), registry);
  await sqliteExecute(registry, `DELETE FROM origin WHERE origin NOT LIKE 'moz-extension://${source.uuid}%';`);
}

async function copyFirefoxSyncStorage(source, profile) {
  const destination = path.join(profile, "storage-sync-v2.sqlite");
  await sqliteBackup(source.syncDatabase, destination);
  await sqliteExecute(
    destination,
    "DELETE FROM storage_sync_data WHERE ext_id <> 'homepage@pixian5.github.io'; DELETE FROM storage_sync_mirror WHERE ext_id IS NULL OR ext_id <> 'homepage@pixian5.github.io';",
  );
}

async function patchExtension(extensionDir, role, browser, coordinatorUrl) {
  const runnerSource = await readFile(path.join(root, "tests", "browser-sync-e2e", "runner.js"), "utf8");
  // Firefox 的 app.ff.js 是经典脚本；将 E2E runner 放进独立作用域，避免与
  // app.ff.js 的顶层 const/let 声明（例如 clone）发生 SyntaxError。
  const runner = browser === "firefox" ? wrapFirefoxE2ERunner(runnerSource) : runnerSource;
  const generatedConfig = {
    role,
    coordinator: coordinatorUrl,
    nonce,
    syncConfig,
    docId,
    deviceId: `${browser}_real_${role.toLowerCase()}`,
  };
  const configSource = `globalThis.HOMEPAGE_E2E_CONFIG = ${JSON.stringify(generatedConfig).replaceAll("<", "\\u003c")};\n`;
  await writeFile(path.join(extensionDir, "js", "e2e-config.js"), configSource, { mode: 0o600 });
  await writeFile(path.join(extensionDir, "js", "e2e-runner.js"), runner, { mode: 0o600 });
  const htmlPath = path.join(extensionDir, "newtab.html");
  const html = await readFile(htmlPath, "utf8");
  const runnerTag =
    browser === "firefox"
      ? '<script src="js/e2e-runner.js"></script>'
      : '<script type="module" src="js/e2e-runner.js"></script>';
  const injected = html.replace("</body>", `  <script src="js/e2e-config.js"></script>\n  ${runnerTag}\n</body>`);
  assert.notEqual(injected, html, `${browser} newtab injection failed`);
  await writeFile(htmlPath, injected, "utf8");
}

function spawnBrowser(binary, args, logName) {
  const child = spawn(binary, args, {
    cwd: root,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const chunks = [];
  const collect = (chunk) => {
    if (chunks.reduce((sum, value) => sum + value.length, 0) < 2 * 1024 * 1024) chunks.push(Buffer.from(chunk));
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  child.once("exit", (code, signal) => {
    writeFile(path.join(resultDir, logName), Buffer.concat(chunks), { mode: 0o600 }).catch(() => {});
    if (report.status === "running") events.push({ name: "browser-exit", details: { logName, code, signal } });
  });
  children.push(child);
  return child;
}

async function packageFirefoxExtension(extensionDir, outputFile) {
  await new Promise((resolve, reject) => {
    const zip = spawn("/usr/bin/zip", ["-X", "-r", "-q", outputFile, "."], {
      cwd: extensionDir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const errors = [];
    zip.stderr.on("data", (chunk) => errors.push(Buffer.from(chunk)));
    zip.once("error", reject);
    zip.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Firefox XPI packaging failed (${code}): ${Buffer.concat(errors).toString("utf8")}`));
    });
  });
  await chmod(outputFile, 0o600);
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  child.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), 3000)),
  ]);
  if (!exited && child.exitCode === null) child.kill("SIGKILL");
}

async function initializeFirefoxProfile(binary, profile) {
  const child = spawn(binary, ["--headless", "--no-remote", "--new-instance", "--profile", profile, "about:blank"], {
    cwd: root,
    env: { ...process.env },
    stdio: "ignore",
  });
  await Promise.race([
    new Promise((resolve, reject) => {
      child.once("error", reject);
      setTimeout(resolve, 3000);
    }),
    new Promise((resolve) => child.once("exit", resolve)),
  ]);
  await stopChild(child);
}

async function waitForBrowserResults(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const role of ["A", "B"]) {
      const failure = coordinator.events.get(`failure:${role}`);
      if (failure) throw new Error(`${role} browser failure: ${failure.message || JSON.stringify(failure)}`);
    }
    const finalA = coordinator.events.get("final:A");
    const finalB = coordinator.events.get("final:B");
    if (finalA && finalB) return { A: finalA, B: finalB };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("browser E2E final event timeout");
}

async function restoreCloud() {
  if (!cloudBackup || !cloudMutated) return null;
  const latest = await httpPullState(syncConfig);
  assert.equal(latest.ok, true, `restore pull failed: ${latest.reason}`);
  const restored = await httpPushState(syncConfig, structuredClone(cloudBackup.doc), {
    ifMatch: latest.etag,
    idempotencyKey: `browser-e2e-restore:${runId}`,
  });
  assert.equal(restored.ok, true, `restore push failed: ${restored.reason}`);
  const verified = await httpPullState(syncConfig);
  assert.equal(verified.ok, true, `restore verification pull failed: ${verified.reason}`);
  const backupHash = normalizedHash(cloudBackup.doc);
  const restoredHash = normalizedHash(verified.doc);
  assert.equal(restoredHash, backupHash, "restored cloud hash differs from backup");
  cloudMutated = false;
  return { revision: verified.revision, backupHash, restoredHash, equal: true };
}

async function main() {
  assert(token, "HOMEPAGE_E2E_TOKEN or TOKEN is required");
  await mkdir(resultDir, { recursive: true, mode: 0o700 });
  await chmod(resultDir, 0o700);

  cloudBackup = await httpPullState(syncConfig);
  assert.equal(cloudBackup.ok, true, `cloud backup pull failed: ${cloudBackup.reason}`);
  await writeFile(backupPath, JSON.stringify(cloudBackup, null, 2), { mode: 0o600 });
  report.cloudBackup = { revision: cloudBackup.revision, hash: normalizedHash(cloudBackup.doc), path: backupPath };

  coordinator = await startCoordinator({
    nonce,
    onEvent(event) {
      events.push({ ...event, at: new Date().toISOString() });
      process.stdout.write(`E2E ${event.name}:${event.role} ${JSON.stringify(event.details)}\n`);
    },
  });

  tempRoot = await mkdtemp(path.join(os.tmpdir(), "homepage-browser-sync-e2e."));
  await chmod(tempRoot, 0o700);
  const chromeExtension = path.join(tempRoot, "extension-chrome");
  const firefoxExtension = path.join(tempRoot, "extension-firefox");
  const chromeProfile = path.join(tempRoot, "profile-chrome");
  const firefoxProfile = path.join(tempRoot, "profile-firefox");
  await cp(path.join(root, "dist", "chrome"), chromeExtension, { recursive: true });
  await cp(path.join(root, "dist", "firefox"), firefoxExtension, { recursive: true });
  await mkdir(chromeProfile, { recursive: true, mode: 0o700 });
  await mkdir(path.join(firefoxProfile, "extensions"), { recursive: true, mode: 0o700 });
  await patchExtension(chromeExtension, "A", "chrome", coordinator.url);
  await patchExtension(firefoxExtension, "B", "firefox", coordinator.url);

  const firefoxSource = await findActiveFirefoxHomepageStorage();
  const firefoxUuid = firefoxSource.uuid;
  const firefoxPrefs = [
    'user_pref("browser.shell.checkDefaultBrowser", false);',
    'user_pref("browser.aboutwelcome.enabled", false);',
    'user_pref("browser.startup.homepage_override.mstone", "ignore");',
    'user_pref("termsofuse.bypassNotification", true);',
    'user_pref("extensions.autoDisableScopes", 0);',
    'user_pref("extensions.enabledScopes", 15);',
    'user_pref("xpinstall.signatures.required", false);',
    `user_pref("extensions.webextensions.uuids", ${JSON.stringify(JSON.stringify({ "homepage@pixian5.github.io": firefoxUuid }))});`,
    "",
  ].join("\n");
  await writeFile(path.join(firefoxProfile, "user.js"), firefoxPrefs, { mode: 0o600 });

  const chromeBinary = await firstExecutable([
    process.env.CHROME_E2E_BINARY,
    path.join(
      os.homedir(),
      "Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    ),
  ]);
  const firefoxBinary = await firstExecutable([
    process.env.FIREFOX_E2E_BINARY,
    "/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox",
  ]);
  await packageFirefoxExtension(
    firefoxExtension,
    path.join(firefoxProfile, "extensions", "homepage@pixian5.github.io.xpi"),
  );
  // 先让 Firefox 注册 XPI，再复制用户扩展的 SQLite 一致性快照；避免首次导航
  // 在扩展尚未注册时落到空白 moz-extension URL。
  await initializeFirefoxProfile(firefoxBinary, firefoxProfile);
  await copyFirefoxHomepageStorage(firefoxSource, firefoxProfile);
  await copyFirefoxSyncStorage(firefoxSource, firefoxProfile);

  spawnBrowser(
    chromeBinary,
    [
      `--user-data-dir=${chromeProfile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--window-size=1280,800",
      "--window-position=-4000,200",
      `--load-extension=${chromeExtension}`,
      `--disable-extensions-except=${chromeExtension}`,
      "chrome://newtab",
    ],
    "chrome.log",
  );
  spawnBrowser(
    firefoxBinary,
    ["--no-remote", "--new-instance", "--profile", firefoxProfile, `moz-extension://${firefoxUuid}/newtab.html`],
    "firefox.log",
  );

  // Firefox B 提供真实扩展数据的内存副本；由总控写入临时云文档后，
  // Chrome A 与 Firefox B 从同一真实用户状态开始并发冲突测试。
  const sourceEvent = await coordinator.waitFor("source-data:B", 90_000);
  assert(sourceEvent?.homepageData, "Firefox source data was not received");
  const seeded = await httpPushState(
    syncConfig,
    toSyncDocument(sourceEvent.homepageData, { deviceId: "firefox_source", docId, revision: 1, writtenAt: Date.now() }),
    { ifMatch: cloudBackup.etag, idempotencyKey: `browser-e2e-seed:${runId}` },
  );
  assert.equal(seeded.ok, true, `baseline seed failed: ${seeded.reason}`);
  cloudMutated = true;
  report.seedRevision = seeded.revision;
  coordinator.publish("baseline-ready", { revision: seeded.revision });

  const finals = await waitForBrowserResults();
  for (const [role, result] of Object.entries(finals)) {
    for (const key of ["unionOk", "fieldOk", "noOpOk", "futureOk", "tombstoneOk", "localRestoreOk"]) {
      assert.equal(result[key], true, `${role} final assertion failed: ${key}`);
    }
    assert.equal(result.originalHash, result.restoredHash, `${role} local restore hash mismatch`);
  }
  report.browserResults = finals;
  report.status = "passed";
}

let exitCode = 0;
try {
  await main();
} catch (error) {
  exitCode = 1;
  report.status = "failed";
  report.error = error?.stack || error?.message || String(error);
} finally {
  for (const child of children) await stopChild(child);
  if (coordinator) await coordinator.close().catch(() => {});
  try {
    report.cloudRestore = await restoreCloud();
  } catch (error) {
    exitCode = 1;
    report.status = "failed";
    report.restoreError = error?.stack || error?.message || String(error);
  }
  report.finishedAt = new Date().toISOString();
  const keepTemp = process.env.HOMEPAGE_E2E_KEEP_TEMP === "1" && report.status === "failed";
  if (keepTemp) report.debugTempRoot = tempRoot;
  await mkdir(resultDir, { recursive: true, mode: 0o700 });
  await writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
  if (tempRoot && !keepTemp) await rm(tempRoot, { recursive: true, force: true });
}

if (exitCode) {
  console.error(`Browser sync E2E failed. Report: ${reportPath}`);
  process.exit(exitCode);
}
console.log(`Browser sync E2E passed. Report: ${reportPath}`);
