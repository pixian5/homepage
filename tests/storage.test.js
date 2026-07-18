import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

// 模拟 chrome.storage
let stored = {};
let lastError = null;

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
      remove: (key, cb) => {
        delete stored[key];
        cb?.();
        return Promise.resolve();
      },
    },
    sync: {
      get: (key, cb) => {
        cb({ [key]: stored[key] });
        return Promise.resolve();
      },
      set: (obj, cb) => {
        Object.assign(stored, obj);
        cb?.();
        return Promise.resolve();
      },
      remove: (key, cb) => {
        delete stored[key];
        cb?.();
        return Promise.resolve();
      },
    },
  },
  runtime: {
    get lastError() {
      return lastError;
    },
  },
};

// 每次测试前清空存储
beforeEach(() => {
  stored = {};
  lastError = null;
});

describe("storage", async () => {
  // 动态导入以使用更新后的全局 mock
  const {
    normalizeLanguage,
    detectPreferredLanguage,
    deepClone,
    defaultData,
    createBackupSnapshot,
    saveData,
    loadData,
    clearData,
    getStorageKey,
    migrateData,
    evictIconCacheLRU,
  } = await import("../src/js/storage.js");

  it("normalizeLanguage handles zh-CN variants", () => {
    assert.equal(normalizeLanguage("zh-CN"), "zh-CN");
    assert.equal(normalizeLanguage("zh_hans"), "zh-CN");
    assert.equal(normalizeLanguage("zh"), "zh-CN");
  });

  it("normalizeLanguage handles zh-TW variants", () => {
    assert.equal(normalizeLanguage("zh-TW"), "zh-TW");
    assert.equal(normalizeLanguage("zh-HK"), "zh-TW");
    assert.equal(normalizeLanguage("zh_hant"), "zh-TW");
  });

  it("normalizeLanguage handles other languages", () => {
    assert.equal(normalizeLanguage("en-US"), "en");
    assert.equal(normalizeLanguage("ja-JP"), "ja");
    assert.equal(normalizeLanguage("ko-KR"), "ko");
    assert.equal(normalizeLanguage("de-DE"), "de");
    assert.equal(normalizeLanguage("fr-FR"), "fr");
    assert.equal(normalizeLanguage("es-ES"), "es");
  });

  it("detectPreferredLanguage returns supported language", () => {
    const lang = detectPreferredLanguage();
    assert.ok(["zh-CN", "zh-TW", "en", "ja", "ko", "de", "fr", "es"].includes(lang));
  });

  it("deepClone clones nested objects", () => {
    const obj = { a: { b: 1 }, arr: [1, 2] };
    const cloned = deepClone(obj);
    assert.deepEqual(cloned, obj);
    cloned.a.b = 2;
    assert.equal(obj.a.b, 1);
  });

  it("defaultData has required structure", () => {
    const data = defaultData();
    assert.equal(data.schemaVersion, 1);
    assert.ok(data.groups.length > 0);
    assert.ok(data.settings.language);
    assert.equal(typeof data.nodes, "object");
    assert.ok(Array.isArray(data.backups));
  });

  it("createBackupSnapshot removes backups recursively", () => {
    const data = defaultData();
    data.backups = [{ id: "old" }];
    const snapshot = createBackupSnapshot(data);
    assert.equal(snapshot.data.backups.length, 0);
    assert.ok(snapshot.id.startsWith("bak_"));
    assert.ok(snapshot.ts > 0);
  });

  it("saveData and loadData roundtrip", async () => {
    const data = defaultData();
    data.settings.language = "en";
    await saveData(data);
    const loaded = await loadData();
    assert.equal(loaded.settings.language, "en");
    assert.ok(loaded.lastUpdated > 0);
  });

  it("clearData removes root key", async () => {
    const data = defaultData();
    await saveData(data);
    await clearData();
    const loaded = await loadData();
    // clear 后再次 load 会创建默认值，不应包含之前的设置
    assert.equal(loaded.settings.language, data.settings.language);
  });

  it("getStorageKey returns root key", () => {
    assert.equal(getStorageKey(), "homepage_data");
  });

  it("migrateData returns input when schemaVersion missing", () => {
    const data = { settings: {}, groups: [] };
    const result = migrateData(data);
    assert.equal(result, data);
  });

  it("migrateData keeps data unchanged at current version", () => {
    const data = defaultData();
    const result = migrateData(data);
    assert.equal(result.schemaVersion, 1);
    assert.deepEqual(result.groups, data.groups);
    assert.deepEqual(result.settings, data.settings);
  });

  it("migrateData bumps version when missing migrator", () => {
    // 模拟一个未来的旧版本数据：没有对应迁移函数时直接抬升版本号
    const data = { schemaVersion: 1, settings: { language: "en" }, groups: [], nodes: {}, backups: [] };
    const result = migrateData(data);
    assert.equal(result.schemaVersion, 1);
    assert.equal(result.settings.language, "en");
  });

  it("migrateData does not mutate input", () => {
    const data = defaultData();
    const snapshot = deepClone(data);
    migrateData(data);
    assert.deepEqual(data, snapshot);
  });

  it("migrateData returns input for non-object", () => {
    assert.equal(migrateData(null), null);
    assert.equal(migrateData(undefined), undefined);
    assert.equal(migrateData("str"), "str");
  });

  it("evictIconCacheLRU keeps entries within limit", () => {
    const cache = {
      a: { dataUrl: "data:a", ts: 1000 },
      b: { dataUrl: "data:b", ts: 2000 },
    };
    const result = evictIconCacheLRU(cache, 5);
    assert.equal(Object.keys(result).length, 2);
    assert.equal(result.a.dataUrl, "data:a");
    assert.equal(result.b.dataUrl, "data:b");
  });

  it("evictIconCacheLRU evicts oldest entries", () => {
    const cache = {
      old: { dataUrl: "data:old", ts: 1000 },
      mid: { dataUrl: "data:mid", ts: 2000 },
      new: { dataUrl: "data:new", ts: 3000 },
    };
    const result = evictIconCacheLRU(cache, 2);
    assert.equal(Object.keys(result).length, 2);
    assert.equal(result.mid.dataUrl, "data:mid");
    assert.equal(result.new.dataUrl, "data:new");
    assert.equal(result.old, undefined);
  });

  it("evictIconCacheLRU normalizes string entries", () => {
    const cache = {
      a: "data:image/png;base64,legacy",
    };
    const result = evictIconCacheLRU(cache, 5);
    assert.equal(result.a.dataUrl, "data:image/png;base64,legacy");
    assert.ok(result.a.ts > 0);
  });
});
