import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createSyncDeviceAuth, friendlyDeviceName } from "../src/js/sync_device_auth.js";

function setupAuth({
  syncEnabled = true,
  syncServerUrl = "http://127.0.0.1:8787",
  syncServerToken = "master-token",
  syncDeviceSecret = "",
  syncDeviceSecretUrl = "",
  saveErr = null,
  pairResponse = { ok: true, deviceSecret: "sec_123" },
} = {}) {
  const data = {
    settings: {
      syncEnabled,
      syncServerUrl,
      syncServerToken,
      syncDeviceSecret,
      syncDeviceSecretUrl,
    },
  };
  let pairCalls = 0;
  let saveCalls = 0;
  let retiredCalls = 0;
  const auth = createSyncDeviceAuth({
    getData: () => data,
    saveLocal: async () => {
      saveCalls += 1;
      return saveErr;
    },
    getOrCreateDeviceId: async () => "dev_alpha",
    httpPairDevice: async () => {
      pairCalls += 1;
      return pairResponse;
    },
    onDeviceRetired: async () => {
      retiredCalls += 1;
    },
  });
  return {
    auth,
    data,
    counts: () => ({ pairCalls, saveCalls, retiredCalls }),
  };
}

describe("sync_device_auth", () => {
  it("prefers device secret only when server url matches, otherwise falls back to bearer token", async () => {
    const matched = setupAuth({
      syncDeviceSecret: "sec_ok",
      syncDeviceSecretUrl: "http://127.0.0.1:8787",
    });
    assert.deepEqual(await matched.auth.getTransportAuth(), {
      mode: "http",
      baseUrl: "http://127.0.0.1:8787",
      token: "master-token",
      deviceSecret: "sec_ok",
      deviceSecretUrl: "http://127.0.0.1:8787",
      deviceId: "dev_alpha",
    });

    const switched = setupAuth({
      syncServerUrl: "http://127.0.0.1:9999",
      syncDeviceSecret: "sec_old",
      syncDeviceSecretUrl: "http://127.0.0.1:8787",
    });
    assert.deepEqual(await switched.auth.getTransportAuth(), {
      baseUrl: "http://127.0.0.1:9999",
      token: "master-token",
    });
  });

  it("deduplicates concurrent pairing calls and skips open mode without token", async () => {
    const openMode = setupAuth({ syncServerToken: "" });
    assert.equal(await openMode.auth.ensureDevicePairing(), false);
    assert.equal(openMode.counts().pairCalls, 0);

    const { auth, data, counts } = setupAuth();
    const [r1, r2] = await Promise.all([auth.ensureDevicePairing(), auth.ensureDevicePairing()]);
    assert.equal(r1, true);
    assert.equal(r2, true);
    assert.equal(counts().pairCalls, 1, "并发配对只发一次 HTTP 请求");
    assert.equal(data.settings.syncDeviceSecret, "sec_123");
    assert.equal(data.settings.syncDeviceSecretUrl, "http://127.0.0.1:8787");
  });

  it("rolls back memory credentials when saveLocal fails during pairing", async () => {
    const { auth, data } = setupAuth({ saveErr: "quota" });
    assert.equal(await auth.ensureDevicePairing(), false);
    assert.equal(data.settings.syncDeviceSecret, undefined);
    assert.equal(data.settings.syncDeviceSecretUrl, undefined);
  });

  it("clears stale credentials on 401 and invokes onDeviceRetired callback on 403", async () => {
    const { auth, data, counts } = setupAuth({
      syncDeviceSecret: "sec_bad",
      syncDeviceSecretUrl: "http://127.0.0.1:8787",
    });
    await auth.dropStaleDeviceCredentials();
    assert.equal(data.settings.syncDeviceSecret, undefined);
    assert.equal(counts().saveCalls, 1);

    await auth.markDeviceRetired();
    assert.equal(counts().retiredCalls, 1);
    assert.equal(typeof friendlyDeviceName(), "string");
  });
});
