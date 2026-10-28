import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function readCi() {
  return readFile(path.join(root, ".github/workflows/ci.yml"), "utf8");
}

describe("CI 浏览器冒烟配置", () => {
  it("runs both Chrome and Firefox smoke tests", async () => {
    const ci = await readCi();
    assert.match(ci, /test:browser-smoke -- chrome/, "必须保留 Chrome 冒烟");
    assert.match(ci, /test:browser-smoke -- firefox/, "必须包含 Firefox 冒烟，否则 Firefox 专属回归只能手工发现");
  });

  it("uses a Firefox build that can load unsigned temporary extensions", async () => {
    const ci = await readCi();
    // 冒烟脚本通过 xpinstall.signatures.required=false + profile 内未签名 XPI 加载扩展；
    // release 版会忽略该偏好，扩展装不上，冒烟必然失败。必须是 devedition / nightly / beta。
    const match = ci.match(/firefox-version:\s*(\S+)/);
    assert.ok(match, "必须显式指定 firefox-version，不能依赖默认 release 通道");
    const version = match[1];
    assert.match(
      version,
      /devedition|nightly|beta/,
      `firefox-version=${version} 无法加载未签名扩展，请改用 latest-devedition 等版本`,
    );
  });

  it("passes the resolved Firefox binary to the smoke script", async () => {
    const ci = await readCi();
    assert.match(ci, /FIREFOX_E2E_BINARY/, "必须通过 FIREFOX_E2E_BINARY 传入浏览器路径");
  });

  it("ensures zip exists before packing the unsigned xpi", async () => {
    const ci = await readCi();
    // 冒烟脚本用 zip 把扩展打成 XPI；runner 上缺 zip 会让 Firefox 用例直接失败
    assert.match(ci, /command -v zip/, "应在运行 Firefox 冒烟前确认 zip 可用");
  });
});
