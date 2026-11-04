import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { createRuntimeDiagnostics, DEBUG_LOG_KEY, DEBUG_PERSIST_KEY } from "../src/js/runtime-diagnostics.js";

function createMockStorage(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, val) {
      store.set(key, String(val));
    },
    removeItem(key) {
      store.delete(key);
    },
    clear() {
      store.clear();
    },
  };
}

describe("runtime-diagnostics", () => {
  test("debugLog appends logs and truncates to maxEntries", () => {
    const storage = createMockStorage();
    const logs = [];
    const diagnostics = createRuntimeDiagnostics({
      storage,
      maxEntries: 3,
      logger: { log: (msg, entry) => logs.push({ msg, entry }), warn: () => {} },
    });

    diagnostics.debugLog("e1", { id: 1 });
    diagnostics.debugLog("e2", { id: 2 });
    diagnostics.debugLog("e3", { id: 3 });
    diagnostics.debugLog("e4", { id: 4 });

    const stored = JSON.parse(storage.getItem(DEBUG_LOG_KEY));
    assert.equal(stored.length, 3, "超过 maxEntries 应被截断");
    assert.equal(stored[0].event, "e4", "最新项应排在最前");
    assert.equal(stored[2].event, "e2", "最老项应保留截断范围内的最新项");
  });

  test("debugLog logs to console when shouldDebugPersist is enabled", () => {
    const storage = createMockStorage({ [DEBUG_PERSIST_KEY]: "1" });
    const consoleLogs = [];
    const diagnostics = createRuntimeDiagnostics({
      storage,
      logger: { log: (tag, entry) => consoleLogs.push({ tag, entry }), warn: () => {} },
    });

    assert.equal(diagnostics.shouldDebugPersist(), true);
    diagnostics.debugLog("persist_step", { ok: true });

    assert.equal(consoleLogs.length, 1);
    assert.equal(consoleLogs[0].tag, "[debug]");
    assert.equal(consoleLogs[0].entry.event, "persist_step");
  });

  test("debugLog quietly handles storage errors", () => {
    const brokenStorage = {
      getItem() {
        throw new Error("QuotaExceeded");
      },
      setItem() {
        throw new Error("QuotaExceeded");
      },
    };
    const diagnostics = createRuntimeDiagnostics({
      storage: brokenStorage,
    });

    assert.doesNotThrow(() => {
      diagnostics.debugLog("safe_event");
    });
  });

  test("getRuntimeInfo extracts runtime id, href and origin safely", () => {
    const mockApi = {
      runtime: { id: "ext-12345" },
    };
    const mockLocation = {
      href: "chrome-extension://ext-12345/newtab.html",
      origin: "chrome-extension://ext-12345",
    };
    const diagnostics = createRuntimeDiagnostics({
      getApi: () => mockApi,
      location: mockLocation,
    });

    const info = diagnostics.getRuntimeInfo();
    assert.deepEqual(info, {
      runtimeId: "ext-12345",
      href: "chrome-extension://ext-12345/newtab.html",
      origin: "chrome-extension://ext-12345",
    });
  });

  test("getRuntimeInfo falls back gracefully when api and location are empty", () => {
    const diagnostics = createRuntimeDiagnostics({
      getApi: () => null,
      location: null,
    });
    const info = diagnostics.getRuntimeInfo();
    assert.equal(info.runtimeId, "");
  });

  test("getAppVersion reads manifest or falls back safely", () => {
    const mockApiWithManifest = {
      runtime: {
        getManifest() {
          return { version: "28.2.0" };
        },
      },
    };
    const diagnosticsWithManifest = createRuntimeDiagnostics({
      getApi: () => mockApiWithManifest,
    });
    assert.equal(diagnosticsWithManifest.getAppVersion(), "28.2.0");

    const mockApiThrowing = {
      runtime: {
        getManifest() {
          throw new Error("Manifest unavailable");
        },
      },
    };
    const warnings = [];
    const diagnosticsThrowing = createRuntimeDiagnostics({
      getApi: () => mockApiThrowing,
      logger: { warn: (msg) => warnings.push(msg), log: () => {} },
    });
    assert.equal(diagnosticsThrowing.getAppVersion(), "");
    assert.equal(warnings.length, 1);
  });

  test("getDebugLogs and clearDebugLogs manage stored entries", () => {
    const storage = createMockStorage();
    const diagnostics = createRuntimeDiagnostics({ storage });

    diagnostics.debugLog("t1", { a: 1 });
    diagnostics.debugLog("t2", { a: 2 });
    assert.equal(diagnostics.getDebugLogs().length, 2);

    diagnostics.clearDebugLogs();
    assert.equal(diagnostics.getDebugLogs().length, 0);
  });
});
