import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { SYNC_OUTBOX_KEY, SYNC_OUTBOX_TARGET } from "../src/js/sync_outbox.js";
import { SYNC_STATE_KEY } from "../src/js/sync_policy.js";
import {
  clearOutboxRecord,
  enqueueOutboxRecord,
  readOutboxSummary,
  readSyncStateAndCleanOutbox,
  syncStorageGetKeys,
  syncStorageSetObj,
  writeSyncStateRecord,
} from "../src/js/sync_state_store.js";

const realChrome = globalThis.chrome;

afterEach(() => {
  globalThis.chrome = realChrome;
});

describe("sync_state_store", () => {
  it("supports callback runtime.lastError and Promise-only storage areas via callExtensionApi", async () => {
    const callbackApi = {
      runtime: { lastError: { message: "quota_exceeded" } },
    };
    globalThis.chrome = callbackApi;

    const failArea = {
      get(_keys, cb) {
        cb({});
      },
      set(_obj, cb) {
        cb();
      },
    };
    const gotFail = await syncStorageGetKeys(failArea, ["a"]);
    assert.equal(gotFail.ok, false);
    assert.equal(gotFail.error, "quota_exceeded");
    const setErr = await syncStorageSetObj(failArea, { a: 1 });
    assert.equal(setErr, "quota_exceeded");

    globalThis.chrome = { runtime: { lastError: null } };
    const store = {};
    const promiseOnlyArea = {
      get(keys, ...extra) {
        if (extra.length > 0) throw new Error("unexpected callback");
        const out = {};
        for (const k of Array.isArray(keys) ? keys : [keys]) {
          if (Object.hasOwn(store, k)) out[k] = store[k];
        }
        return Promise.resolve(out);
      },
      set(obj, ...extra) {
        if (extra.length > 0) throw new Error("unexpected callback");
        Object.assign(store, obj);
        return Promise.resolve();
      },
    };

    assert.equal(await syncStorageSetObj(promiseOnlyArea, { hello: "world" }), null);
    const gotOk = await syncStorageGetKeys(promiseOnlyArea, ["hello"]);
    assert.equal(gotOk.ok, true);
    assert.equal(gotOk.value.hello, "world");
  });

  it("cleans obsolete transport outbox items and manages state + current outbox lifecycle", async () => {
    const store = {
      [SYNC_STATE_KEY]: { docId: "doc_1", status: "idle" },
      [SYNC_OUTBOX_KEY]: [
        { targetKey: "storage.sync|homepage", payload: { docId: "legacy" }, attempts: 12, lastError: "legacy" },
        { targetKey: SYNC_OUTBOX_TARGET, payload: { docId: "doc_1" }, attempts: 1, lastError: "net", nextRetryAtMs: 0 },
      ],
    };
    globalThis.chrome = {
      runtime: { lastError: null },
      storage: {
        local: {
          get(keys, cb) {
            const out = {};
            for (const k of keys) {
              if (Object.hasOwn(store, k)) out[k] = structuredClone(store[k]);
            }
            cb(out);
          },
          set(obj, cb) {
            Object.assign(store, structuredClone(obj));
            cb();
          },
        },
      },
    };

    const st = await readSyncStateAndCleanOutbox();
    assert.equal(st.docId, "doc_1");
    assert.equal(store[SYNC_OUTBOX_KEY].length, 1);
    assert.equal(store[SYNC_OUTBOX_KEY][0].targetKey, SYNC_OUTBOX_TARGET);

    await writeSyncStateRecord({ docId: "doc_2", status: "syncing" });
    assert.equal(store[SYNC_STATE_KEY].docId, "doc_2");

    await clearOutboxRecord();
    assert.equal(store[SYNC_OUTBOX_KEY].length, 0);

    // 队列本就为空时，clearOutboxRecord 不得继续写盘触发存储事件
    let setCallsAfterClear = 0;
    const origSet = globalThis.chrome.storage.local.set;
    globalThis.chrome.storage.local.set = (obj, cb) => {
      setCallsAfterClear += 1;
      return origSet(obj, cb);
    };
    await clearOutboxRecord();
    assert.equal(setCallsAfterClear, 0);
    globalThis.chrome.storage.local.set = origSet;

    await enqueueOutboxRecord({ docId: "doc_2", revision: 3 }, "timeout");
    const summary = await readOutboxSummary();
    assert.equal(summary.length, 1);
    assert.equal(summary[0].lastError, "timeout");
  });
});
