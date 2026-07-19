import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

let stored = {};

global.chrome = {
  storage: {
    local: {
      get: (key, cb) => {
        cb({ [key]: stored[key] });
        return Promise.resolve();
      },
      set: (obj, cb) => {
        Object.assign(stored, obj);
        cb?.();
        return Promise.resolve();
      },
    },
  },
  runtime: { lastError: null },
};

// 模拟 canvas toDataURL
global.document = {
  createElement: (tag) => {
    if (tag === "canvas") {
      return {
        width: 0,
        height: 0,
        getContext: () => ({
          fillStyle: "",
          fillRect: () => {},
          font: "",
          textAlign: "",
          textBaseline: "",
          fillText: () => {},
        }),
        toDataURL: () => "data:image/png;base64,test",
      };
    }
    return {};
  },
};

function setNavigator(value) {
  Object.defineProperty(globalThis, "navigator", {
    value,
    writable: true,
    configurable: true,
  });
}

beforeEach(() => {
  stored = {};
  global.window = { location: { protocol: "chrome-extension:" } };
  setNavigator({ userAgent: "Chrome/120" });
});

describe("icons", async () => {
  const { getSiteKey, getFaviconCandidates, resolveIcon, clearIconCacheForUrl } = await import("../src/js/icons.js");

  it("getSiteKey returns empty for non-http urls", () => {
    assert.equal(getSiteKey("file:///tmp"), "");
    assert.equal(getSiteKey(""), "");
    assert.equal(getSiteKey("not-a-url"), "");
  });

  it("getSiteKey returns site key for valid urls", () => {
    assert.equal(getSiteKey("https://example.com/path"), "site:example.com");
    assert.equal(getSiteKey("https://www.example.com/"), "site:www.example.com");
  });

  it("getSiteKey ignores localhost", () => {
    assert.equal(getSiteKey("http://localhost:8080"), "");
    assert.equal(getSiteKey("http://app.local/"), "");
  });

  it("getFaviconCandidates returns candidates for known site", () => {
    const candidates = getFaviconCandidates("https://example.com");
    assert.ok(candidates.length > 0);
    assert.ok(candidates.some((c) => c.includes("favicon.ico")));
  });

  it("getFaviconCandidates returns empty for invalid url", () => {
    assert.deepEqual(getFaviconCandidates("not-a-url"), []);
  });

  it("getFaviconCandidates prefers own favicon for Safari/Firefox extension", () => {
    setNavigator({ userAgent: "Firefox/120" });
    global.window = { location: { protocol: "moz-extension:" } };
    const candidates = getFaviconCandidates("https://example.com");
    assert.equal(candidates[0], "https://example.com/favicon.ico");
  });

  it("resolveIcon returns avatar for non-http node", async () => {
    const icon = await resolveIcon({ id: "1", title: "Test", url: "javascript:alert(1)" });
    assert.ok(icon.startsWith("data:image/png"));
  });

  it("resolveIcon returns color icon for color type", async () => {
    const icon = await resolveIcon({
      id: "1",
      title: "Test",
      url: "https://example.com",
      iconType: "color",
      color: "#ff0000",
    });
    assert.ok(icon.startsWith("data:image/png"));
  });

  it("resolveIcon returns uploaded data", async () => {
    const dataUrl = "data:image/png;base64,uploaded";
    const icon = await resolveIcon({
      id: "1",
      title: "Test",
      url: "https://example.com",
      iconType: "upload",
      iconData: dataUrl,
    });
    assert.equal(icon, dataUrl);
  });

  it("clearIconCacheForUrl removes url and site key entries", async () => {
    stored.homepage_icon_cache = {
      "https://example.com": { dataUrl: "x" },
      "site:example.com": { dataUrl: "y" },
    };
    await clearIconCacheForUrl("https://example.com", "https://new.com");
    assert.equal(stored.homepage_icon_cache["https://example.com"], undefined);
    assert.equal(stored.homepage_icon_cache["site:example.com"], undefined);
  });

  it("getFaviconCandidates includes subpath logo/favicon for SPA hosts", () => {
    const list = getFaviconCandidates("https://new.sharedchat.cc/list/#/vibe-code/dashboard");
    assert.ok(list.some((u) => u.includes("/list/logo.svg")));
    assert.ok(list.some((u) => u.includes("/list/favicon.ico")));
  });
});
