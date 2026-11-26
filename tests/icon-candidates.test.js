import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  getFaviconCandidates,
  getSiteKey,
  isThirdPartyFaviconUrl,
  normalizeCandidateUrl,
  shouldBypassIconFailureCache,
} from "../src/js/icon-candidates.js";

function setNavigator(value) {
  Object.defineProperty(globalThis, "navigator", {
    value,
    writable: true,
    configurable: true,
  });
}

beforeEach(() => {
  global.window = { location: { protocol: "chrome-extension:" } };
  setNavigator({ userAgent: "Chrome/120" });
});

describe("icon-candidates", () => {
  it("normalizes candidate URLs to https and rejects non-http protocols", () => {
    assert.equal(normalizeCandidateUrl("http://example.com/favicon.ico"), "https://example.com/favicon.ico");
    assert.equal(normalizeCandidateUrl("https://example.com/a.svg"), "https://example.com/a.svg");
    assert.equal(normalizeCandidateUrl("javascript:alert(1)"), "");
    assert.equal(normalizeCandidateUrl("not-a-url"), "");
  });

  it("identifies third-party favicon proxy URLs and filters them when disabled", () => {
    assert.equal(isThirdPartyFaviconUrl("https://www.google.com/s2/favicons?domain=a.com"), true);
    assert.equal(isThirdPartyFaviconUrl("https://t2.gstatic.com/faviconV2?url=https://a.com"), true);
    assert.equal(isThirdPartyFaviconUrl("https://icons.duckduckgo.com/ip3/a.com.ico"), true);
    assert.equal(isThirdPartyFaviconUrl("https://example.com/favicon.ico"), false);

    const privateCandidates = getFaviconCandidates("https://example.com/app", { allowThirdPartyFallback: false });
    assert.ok(privateCandidates.includes("https://example.com/favicon.ico"));
    assert.equal(privateCandidates.some(isThirdPartyFaviconUrl), false);
  });

  it("builds subpath candidates and flags deep paths to bypass stale root failure cache", () => {
    assert.equal(shouldBypassIconFailureCache("https://example.com/"), false);
    assert.equal(shouldBypassIconFailureCache("https://example.com/list/home"), true);
    const candidates = getFaviconCandidates("https://example.com/list/home", { allowThirdPartyFallback: false });
    assert.ok(candidates.includes("https://example.com/list/logo.svg"));
    assert.ok(candidates.includes("https://example.com/list/favicon.ico"));
    assert.equal(getSiteKey("https://example.com/list/home"), "site:example.com");
  });
});
