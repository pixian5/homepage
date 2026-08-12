import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clearSafariStableHomepage,
  isSafariWebExtension,
  readSafariStableHomepage,
  shouldRestoreSafariStableHomepage,
  writeSafariStableHomepage,
} from "../src/js/safari_native_storage.js";

function safariApi(response) {
  return {
    runtime: {
      getURL: () => "safari-web-extension://test/",
      sendNativeMessage: (_app, _message, callback) => callback(response),
      lastError: null,
    },
  };
}

describe("Safari stable native storage", () => {
  it("only enables the bridge for Safari WebExtension origins", () => {
    assert.equal(isSafariWebExtension(safariApi(null)), true);
    assert.equal(isSafariWebExtension({ runtime: { getURL: () => "chrome-extension://test/" } }), false);
  });

  it("reads and writes through the native app bridge", async () => {
    const data = { nodes: { a: {} } };
    assert.deepEqual(await readSafariStableHomepage(safariApi({ ok: true, data })), data);
    assert.equal(await writeSafariStableHomepage(data, safariApi({ ok: true })), true);
    assert.equal(await clearSafariStableHomepage(safariApi({ ok: true })), true);
  });

  it("restores only when local storage is missing or unexpectedly empty", () => {
    const fallback = {
      nodes: {},
      backups: [],
      groups: [{ id: "grp_all", nodes: [], systemAllGroup: true }],
      settings: { theme: "system" },
    };
    const stable = { ...fallback, nodes: { a: {} } };
    assert.equal(shouldRestoreSafariStableHomepage(null, stable, fallback), true);
    assert.equal(shouldRestoreSafariStableHomepage(fallback, stable, fallback), true);
    assert.equal(shouldRestoreSafariStableHomepage({ ...fallback, nodes: { b: {} } }, stable, fallback), false);
    assert.equal(shouldRestoreSafariStableHomepage(fallback, fallback, fallback), false);
  });

  it("restores settings and backups even when both stores have zero nodes", () => {
    const fallback = {
      nodes: {},
      backups: [],
      groups: [{ id: "grp_all", nodes: [], systemAllGroup: true }],
      settings: { theme: "system" },
    };
    assert.equal(
      shouldRestoreSafariStableHomepage(fallback, { ...fallback, settings: { theme: "dark" } }, fallback),
      true,
    );
    assert.equal(
      shouldRestoreSafariStableHomepage(fallback, { ...fallback, backups: [{ id: "backup" }] }, fallback),
      true,
    );
  });
});
