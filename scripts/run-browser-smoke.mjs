#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { defaultData, getStorageKey } from "../src/js/storage.js";
import { stopBrowser } from "../tests/helpers/browser-process.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const execFileAsync = promisify(execFile);
const requested = process.argv.slice(2);
const browsers = requested.length ? requested : ["chrome", "firefox"];
assert.ok(
  browsers.every((name) => ["chrome", "firefox"].includes(name)),
  "仅支持 chrome / firefox",
);

async function browserBinary(browser) {
  const candidates =
    browser === "firefox"
      ? [
          process.env.FIREFOX_E2E_BINARY,
          "/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox",
          "/usr/bin/firefox",
        ]
      : [process.env.CHROME_E2E_BINARY];
  if (browser === "chrome") {
    const cache = path.join(os.homedir(), "Library/Caches/ms-playwright");
    const versions = await readdir(cache).catch(() => []);
    for (const name of versions
      .filter((name) => /^chromium-\d+$/.test(name))
      .sort()
      .reverse()) {
      candidates.push(
        path.join(
          cache,
          name,
          "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
        ),
      );
    }
    candidates.push(
      "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
    );
  }
  for (const candidate of candidates.filter(Boolean)) {
    if (
      await access(candidate).then(
        () => true,
        () => false,
      )
    )
      return candidate;
  }
  throw new Error(`${browser} 测试浏览器不存在；请指定 ${browser === "chrome" ? "CHROME" : "FIREFOX"}_E2E_BINARY`);
}

async function runBrowser(browser) {
  const binary = await browserBinary(browser);
  const { stdout } = await execFileAsync(binary, ["--version"], { timeout: 5000, maxBuffer: 16384 });
  const version = stdout.trim();
  // 普通 Chrome 已忽略命令行扩展加载参数；提前识别，避免无意义地等待页面回报。
  if (browser === "chrome" && !/^(Google Chrome for Testing|Chromium)\s+\d+\./m.test(version)) {
    throw new Error(
      `扩展冒烟测试需要 Chrome for Testing（测试版浏览器）或 Chromium（开源浏览器）；当前为 ${version}。请用 CHROME_E2E_BINARY 指定测试版可执行文件。`,
    );
  }
  console.log(`[smoke] ${browser}：${version}；可执行文件：${binary}`);
  const temp = await mkdtemp(path.join(os.tmpdir(), `homepage-smoke-${browser}-`));
  const profile = path.join(temp, "profile");
  const extension = path.join(temp, "extension");
  const nonce = randomUUID();
  let child;
  let output = "";
  let settle;
  const report = new Promise((resolve) => {
    settle = resolve;
  });
  const server = createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }
    if (req.method !== "POST" || req.url !== `/${nonce}`) {
      res.writeHead(404).end();
      return;
    }
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 32000) {
        res.writeHead(413).end();
        return;
      }
    }
    try {
      const result = JSON.parse(body);
      assert.equal(result.browser, browser);
      res.end("ok");
      settle(result);
    } catch {
      res.writeHead(400).end();
    }
  });
  let timer;
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    await mkdir(profile, { recursive: true });
    await cp(path.join(root, "dist", browser), extension, { recursive: true });
    const fixture = defaultData();
    Object.assign(fixture.settings, {
      language: "zh-CN",
      backgroundType: "color",
      syncEnabled: false,
      iconRetryHour: -1,
    });
    const config = {
      browser,
      storageKey: getStorageKey(),
      fixture,
      reportUrl: `http://127.0.0.1:${server.address().port}/${nonce}`,
    };
    const runner = await readFile(path.join(root, "tests/browser-smoke/runner.js"), "utf8");
    await writeFile(
      path.join(extension, "js/smoke-runner.js"),
      `globalThis.HOMEPAGE_SMOKE = ${JSON.stringify(config)};\n${runner}`,
    );
    const htmlFile = path.join(extension, "newtab.html");
    const html = await readFile(htmlFile, "utf8");
    const patched = html.replace(
      /<script(?: type="module")? src="js\/app(?:\.ff)?\.js"><\/script>/,
      '<script src="js/smoke-runner.js"></script>',
    );
    assert.notEqual(patched, html, "缺少打包入口脚本");
    await writeFile(htmlFile, patched);
    // 后台脚本在临时配置首次安装扩展后打开测试页，不依赖固定扩展 ID。
    await writeFile(
      path.join(extension, "js/smoke-open.js"),
      '(globalThis.browser || chrome).runtime.onInstalled.addListener(() => (globalThis.browser || chrome).tabs.create({url: "newtab.html"}));\n',
    );
    const manifestFile = path.join(extension, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
    let args;
    if (browser === "chrome") {
      const background = path.join(extension, manifest.background.service_worker);
      await writeFile(
        background,
        `${await readFile(background, "utf8")}\n${await readFile(path.join(extension, "js/smoke-open.js"), "utf8")}`,
      );
      args = [
        "--headless=new",
        "--no-sandbox",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-networking",
        "--disable-features=DisableLoadExtensionCommandLineSwitch",
        `--user-data-dir=${profile}`,
        `--disable-extensions-except=${extension}`,
        `--load-extension=${extension}`,
        "about:blank",
      ];
    } else {
      manifest.background.scripts.push("js/smoke-open.js");
      await writeFile(manifestFile, JSON.stringify(manifest));
      await mkdir(path.join(profile, "extensions"));
      await writeFile(
        path.join(profile, "user.js"),
        [
          'user_pref("xpinstall.signatures.required", false);',
          'user_pref("extensions.autoDisableScopes", 0);',
          'user_pref("extensions.enabledScopes", 15);',
          'user_pref("browser.shell.checkDefaultBrowser", false);',
          'user_pref("app.update.disabledForTesting", true);',
          'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
        ].join("\n"),
      );
      const xpi = path.join(profile, "extensions", `${manifest.browser_specific_settings.gecko.id}.xpi`);
      await new Promise((resolve, reject) => {
        const zip = spawn("zip", ["-X", "-r", "-q", xpi, "."], { cwd: extension, stdio: "ignore" });
        zip.once("error", reject);
        zip.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`扩展压缩失败：${code}`))));
      });
      args = ["--headless", "--no-remote", "--new-instance", "--profile", profile, "about:blank"];
    }
    child = spawn(binary, args, {
      stdio: ["ignore", "pipe", "pipe"],
      // 更新重启可能消费命令行参数；环境变量继续约束为独立、无界面的测试实例。
      env: { ...process.env, ...(browser === "firefox" ? { MOZ_HEADLESS: "1", MOZ_NO_REMOTE: "1" } : {}) },
      detached: process.platform !== "win32",
    });
    const capture = (chunk) => {
      output = (output + chunk).slice(-6000);
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.once("error", (error) => settle({ browser, failure: String(error) }));
    child.once("exit", (code) => settle({ browser, failure: `浏览器提前退出：${code}` }));
    timer = setTimeout(() => settle({ browser, failure: "浏览器冒烟测试超时" }), 45000);
    const result = await report;
    if (result.failure) throw new Error(`${result.failure}\n${output}`);
    console.log(JSON.stringify(result));
    return result;
  } finally {
    clearTimeout(timer);
    await stopBrowser(child);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(temp, { recursive: true, force: true });
  }
}

for (const browser of browsers) await runBrowser(browser);
