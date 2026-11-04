import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { pruneUnusedCachesQuietly } from "../src/js/cache-cleaner.js";

describe("cache-cleaner", () => {
  test("pruneUnusedCachesQuietly collects bookmark URLs and invokes prune handler", async () => {
    let capturedOptions = null;
    const infos = [];
    const mockData = {
      settings: { backgroundType: "bing" },
      nodes: {
        b1: { id: "b1", type: "item", url: "https://example.com/1" },
        b2: { id: "b2", type: "item", url: "https://example.com/2" },
        f1: { id: "f1", type: "folder", title: "文件夹" },
        b_invalid: { id: "b_invalid", type: "item", url: "" },
      },
    };

    const res = await pruneUnusedCachesQuietly({
      getData: () => mockData,
      pruneCaches: async (opts) => {
        capturedOptions = opts;
        return { iconRemoved: 5, bgCleared: true };
      },
      logger: {
        info: (msg) => infos.push(msg),
        warn: () => {},
      },
    });

    assert.equal(res.ok, true);
    assert.equal(res.iconRemoved, 5);
    assert.equal(res.bgCleared, true);
    assert.deepEqual(capturedOptions.bookmarkUrls, ["https://example.com/1", "https://example.com/2"]);
    assert.equal(capturedOptions.backgroundType, "bing");
    assert.equal(infos.length, 1);
  });

  test("pruneUnusedCachesQuietly handles null data safely", async () => {
    let capturedUrls = null;
    const res = await pruneUnusedCachesQuietly({
      getData: () => null,
      pruneCaches: async (opts) => {
        capturedUrls = opts.bookmarkUrls;
        return { iconRemoved: 0, bgCleared: false };
      },
    });

    assert.equal(res.ok, true);
    assert.deepEqual(capturedUrls, []);
  });

  test("pruneUnusedCachesQuietly catches prune errors without throwing", async () => {
    const warnings = [];
    const res = await pruneUnusedCachesQuietly({
      getData: () => ({ nodes: {} }),
      pruneCaches: async () => {
        throw new Error("Storage lock failed");
      },
      logger: {
        warn: (msg, err) => warnings.push({ msg, err }),
        info: () => {},
      },
    });

    assert.equal(res.ok, false);
    assert.equal(res.error?.message, "Storage lock failed");
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].msg, "pruneCachesQuietly failed");
  });
});
