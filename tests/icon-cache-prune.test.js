import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { pruneIconCacheOrphans } from "../src/js/storage.js";

/** 与 icons.js 的 getSiteKey 规则一致（测试内联，避免依赖 DOM 环境） */
function siteKeyOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    const host = u.hostname.toLowerCase();
    if (!host.includes(".")) return "";
    if (host === "localhost" || host.endsWith(".local")) return "";
    return `site:${host}`;
  } catch {
    return "";
  }
}

describe("pruneIconCacheOrphans", () => {
  it("removes entries whose bookmarks were deleted", () => {
    const cache = {
      "https://keep.test/": { icon: "a", ts: 1 },
      "https://gone.test/": { icon: "b", ts: 2 },
      "site:keep.test": { icon: "a", ts: 1 },
      "site:gone.test": { icon: "b", ts: 2 },
    };
    const { kept, removed } = pruneIconCacheOrphans(cache, ["https://keep.test/"], siteKeyOf);
    assert.equal(removed, 2);
    assert.deepEqual(Object.keys(kept).sort(), ["https://keep.test/", "site:keep.test"]);
  });

  it("keeps a site entry when any bookmark shares that host", () => {
    const cache = { "site:example.com": { icon: "x", ts: 1 } };
    const { kept, removed } = pruneIconCacheOrphans(cache, ["https://example.com/other-page"], siteKeyOf);
    assert.equal(removed, 0, "同站点的其它页面仍可能复用该图标");
    assert.ok(kept["site:example.com"]);
  });

  it("does not keep a site entry for a different host", () => {
    const cache = { "site:example.com": { icon: "x", ts: 1 } };
    const { removed } = pruneIconCacheOrphans(cache, ["https://another.test/"], siteKeyOf);
    assert.equal(removed, 1);
  });

  it("removes everything when there are no bookmarks", () => {
    const cache = {
      "https://a.test/": { icon: "a", ts: 1 },
      "site:a.test": { icon: "a", ts: 1 },
    };
    const { kept, removed } = pruneIconCacheOrphans(cache, [], siteKeyOf);
    assert.equal(removed, 2);
    assert.deepEqual(kept, {});
  });

  it("leaves an already-clean cache untouched", () => {
    const cache = { "https://a.test/": { icon: "a", ts: 1 } };
    const { kept, removed } = pruneIconCacheOrphans(cache, ["https://a.test/"], siteKeyOf);
    assert.equal(removed, 0);
    assert.deepEqual(kept, cache);
  });

  it("tolerates malformed cache/urls without throwing", () => {
    assert.doesNotThrow(() => pruneIconCacheOrphans(null, null, siteKeyOf));
    const { removed } = pruneIconCacheOrphans({ "not-a-url": { ts: 1 } }, ["bogus"], siteKeyOf);
    assert.equal(removed, 1, "无法解析为 URL 的书签不应保留任何缓存");
  });
});

describe("evictIconCacheLRU 单条体积限制", () => {
  it("drops entries whose dataUrl exceeds the per-entry cap", async () => {
    const { evictIconCacheLRU } = await import("../src/js/storage.js");
    const huge = `data:image/png;base64,${"A".repeat(40 * 1024)}`;
    const small = "data:image/png;base64,AAAA";
    const kept = evictIconCacheLRU({
      "https://huge.test/": { dataUrl: huge, ts: 2 },
      "https://small.test/": { dataUrl: small, ts: 1 },
    });
    assert.deepEqual(Object.keys(kept), ["https://small.test/"], "超大图标应被丢弃，回退字母头像");
  });

  it("still enforces the entry count limit", async () => {
    const { evictIconCacheLRU } = await import("../src/js/storage.js");
    const cache = {};
    // ts 从 1 开始：0 会被视为「未知时间」用 now 兜底，不适合作为排序用例
    for (let i = 1; i <= 10; i++) {
      cache[`https://s${i}.test/`] = { dataUrl: "data:image/png;base64,AA", ts: i };
    }
    const kept = evictIconCacheLRU(cache, 3);
    assert.equal(Object.keys(kept).length, 3);
    // 保留 ts 最新的三个
    assert.deepEqual(Object.keys(kept).sort(), ["https://s10.test/", "https://s8.test/", "https://s9.test/"]);
  });
});
