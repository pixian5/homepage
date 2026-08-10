import { markNodeDeleted, stampNodeFieldChanges } from "./data-utils.js";
import { httpPullState, httpPushState } from "./sync_http_transport.js";
import { mergeHomepage } from "./sync_merge.js";
import { unpackSyncDocument } from "./sync_pack.js";
import { hashSyncDocument, syncDocumentToHomepageShape, toSyncDocument } from "./sync_projection.js";

(() => {
  const config = globalThis.HOMEPAGE_E2E_CONFIG;
  const { role, coordinator, nonce, syncConfig, docId, deviceId } = config || {};
  const clone = (value) => structuredClone(value);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let storageBackup = null;

  function assert(condition, message) {
    if (!condition) throw new Error(message);
  }

  function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stable(value[key])]),
    );
  }

  async function digest(value) {
    const bytes = new TextEncoder().encode(JSON.stringify(stable(value)));
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  async function coordinatorFetch(path, init = {}) {
    return fetch(`${coordinator}${path}`, {
      ...init,
      headers: { ...(init.headers || {}), "X-E2E-Session": nonce },
    });
  }

  async function event(name, details = {}) {
    const response = await coordinatorFetch("/event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role, name, details }),
    });
    if (!response.ok) throw new Error(`event failed: ${name}`);
  }

  async function waitFor(name) {
    for (let attempt = 0; attempt < 1200; attempt += 1) {
      const response = await coordinatorFetch(`/event?name=${encodeURIComponent(name)}`);
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`event poll failed: ${name} status=${response.status} ${detail}`);
      }
      const body = await response.json();
      if (body.ready) return body.value;
      await sleep(50);
    }
    throw new Error(`wait timeout: ${name}`);
  }

  function project(state, revision, writtenAt = Date.now()) {
    return toSyncDocument(state, { deviceId, docId, revision, writtenAt });
  }

  function merge(state, remote) {
    const result = mergeHomepage(state, remote, { deviceId, now: Date.now() });
    if (!result.ok) throw new Error(`merge failed: ${result.reason}`);
    return result;
  }

  function addSyntheticNode(state, id) {
    const now = Date.now();
    state.nodes[id] = {
      id,
      type: "item",
      title: `Added ${role}`,
      url: `https://${id}.invalid/`,
      iconType: "auto",
      iconData: "",
      color: "",
      createdAt: now,
      updatedAt: now,
      titleUpdatedAt: now,
      urlUpdatedAt: now,
      updatedBy: deviceId,
    };
    state.groups[0].nodes.push(id);
    state.groups[0].updatedAt = now;
    state.groups[0].updatedBy = deviceId;
    state._syncMeta.placementClock[id] = {
      parentKind: "group",
      parentId: "grp_all",
      index: state.groups[0].nodes.length - 1,
      updatedAt: now,
      updatedBy: deviceId,
    };
    state.lastUpdated = now;
  }

  async function restoreLocal() {
    if (!storageBackup) return null;
    await chrome.storage.local.clear();
    await chrome.storage.sync.clear();
    if (Object.keys(storageBackup.local).length) await chrome.storage.local.set(storageBackup.local);
    if (Object.keys(storageBackup.sync).length) await chrome.storage.sync.set(storageBackup.sync);
    return { local: await chrome.storage.local.get(null), sync: await chrome.storage.sync.get(null) };
  }

  async function readStorageSnapshot() {
    return { local: await chrome.storage.local.get(null), sync: await chrome.storage.sync.get(null) };
  }

  function dataFromSnapshot(snapshot) {
    const localData = snapshot.local.homepage_data;
    if (localData) return localData;
    const synced = unpackSyncDocument(snapshot.sync.homepage_sync_meta, snapshot.sync);
    return synced.ok ? syncDocumentToHomepageShape(synced.doc) : null;
  }

  async function waitForFirefoxSourceData() {
    for (let attempt = 0; attempt < 600; attempt += 1) {
      const snapshot = await readStorageSnapshot();
      const data = dataFromSnapshot(snapshot);
      if (data) return { snapshot, data };
      await sleep(50);
    }
    throw new Error("real Firefox homepage data is missing");
  }

  async function run() {
    assert(config && role && coordinator && nonce && syncConfig?.token, "invalid E2E configuration");
    await sleep(1200);
    let originalStorage = await readStorageSnapshot();
    let sourceData = null;
    if (role === "B") {
      const source = await waitForFirefoxSourceData();
      originalStorage = source.snapshot;
      sourceData = source.data;
    } else {
      sourceData = (await waitFor("source-data:B"))?.homepageData;
    }
    storageBackup = originalStorage;
    const originalHash = await digest(originalStorage);
    if (role === "B") {
      // 仅携带真实数据中会参与同步的投影，排除本机壁纸、上传图标、备份和同步令牌。
      sourceData = syncDocumentToHomepageShape(
        toSyncDocument(sourceData, { deviceId: "firefox_source", docId, revision: 1, writtenAt: Date.now() }),
      );
    }
    assert(
      sourceData && typeof sourceData === "object" && sourceData.nodes && Object.keys(sourceData.nodes).length,
      "real Firefox homepage data is missing",
    );
    let state = clone(sourceData);
    state.settings = { ...(state.settings || {}), syncEnabled: false, syncServerUrl: "", syncServerToken: "" };
    if (role === "B") await event("source-data", { homepageData: state });
    const targetNodeId = Object.keys(state.nodes)[0];
    await chrome.storage.local.clear();
    await chrome.storage.local.set({ homepage_data: state });
    await event("ready", {
      originalHash,
      storageKeys: Object.keys(originalStorage.local).length + Object.keys(originalStorage.sync).length,
    });
    await waitFor("ready:A");
    await waitFor("ready:B");
    await waitFor("baseline-ready");

    const baseline = await httpPullState(syncConfig);
    assert(baseline.ok, `baseline pull failed: ${baseline.reason}`);
    state = merge(state, baseline.doc).state;
    addSyntheticNode(state, `browser_add_${role.toLowerCase()}`);
    await chrome.storage.local.set({ homepage_data: state });
    await event("add-ready", { revision: baseline.revision });
    await waitFor("add-ready:A");
    await waitFor("add-ready:B");

    if (role === "A") {
      const pushed = await httpPushState(syncConfig, project(state, baseline.revision + 1), { ifMatch: baseline.etag });
      assert(pushed.ok, `A add push failed: ${pushed.reason}`);
      await event("add-a-pushed", { revision: pushed.revision });
      await waitFor("add-b-resolved");
      const latest = await httpPullState(syncConfig);
      assert(latest.ok, `A add pull failed: ${latest.reason}`);
      state = merge(state, latest.doc).state;
    } else {
      await waitFor("add-a-pushed");
      const stale = await httpPushState(syncConfig, project(state, baseline.revision + 1), { ifMatch: baseline.etag });
      assert(stale.reason === "precondition_failed", `expected add 412, got ${stale.reason}`);
      state = merge(state, stale.remote.doc).state;
      const retried = await httpPushState(syncConfig, project(state, stale.revision + 1), { ifMatch: stale.etag });
      assert(retried.ok, `B add retry failed: ${retried.reason}`);
      await event("add-b-resolved", { staleStatus: stale.status, revision: retried.revision });
    }

    const unionOk = !!state.nodes.browser_add_a && !!state.nodes.browser_add_b;
    assert(unionOk, "concurrent add union missing a node");
    await chrome.storage.local.set({ homepage_data: state });
    await event("union-verified", { unionOk, nodeCount: Object.keys(state.nodes).length });
    await waitFor("union-verified:A");
    await waitFor("union-verified:B");

    const editBase = await httpPullState(syncConfig);
    assert(editBase.ok, `edit baseline pull failed: ${editBase.reason}`);
    state = merge(state, editBase.doc).state;
    if (role === "A") {
      stampNodeFieldChanges(state.nodes[targetNodeId], { titleChanged: true });
      state.nodes[targetNodeId].title = "Title from Chrome A";
    } else {
      stampNodeFieldChanges(state.nodes[targetNodeId], { urlChanged: true });
      state.nodes[targetNodeId].url = "https://firefox-b.invalid/";
    }
    state.lastUpdated = Date.now();
    await chrome.storage.local.set({ homepage_data: state });
    await event("edit-ready", { revision: editBase.revision });
    await waitFor("edit-ready:A");
    await waitFor("edit-ready:B");

    if (role === "A") {
      const pushed = await httpPushState(syncConfig, project(state, editBase.revision + 1), { ifMatch: editBase.etag });
      assert(pushed.ok, `A edit push failed: ${pushed.reason}`);
      await event("edit-a-pushed", { revision: pushed.revision });
      await waitFor("edit-b-resolved");
      const latest = await httpPullState(syncConfig);
      assert(latest.ok, `A edit pull failed: ${latest.reason}`);
      state = merge(state, latest.doc).state;
    } else {
      await waitFor("edit-a-pushed");
      const stale = await httpPushState(syncConfig, project(state, editBase.revision + 1), { ifMatch: editBase.etag });
      assert(stale.reason === "precondition_failed", `expected edit 412, got ${stale.reason}`);
      state = merge(state, stale.remote.doc).state;
      const retried = await httpPushState(syncConfig, project(state, stale.revision + 1), { ifMatch: stale.etag });
      assert(retried.ok, `B edit retry failed: ${retried.reason}`);
      await event("edit-b-resolved", { staleStatus: stale.status, revision: retried.revision });
    }

    const fieldOk =
      state.nodes[targetNodeId].title === "Title from Chrome A" &&
      state.nodes[targetNodeId].url === "https://firefox-b.invalid/";
    assert(fieldOk, "independent title/url edits did not converge");
    const latest = await httpPullState(syncConfig);
    assert(latest.ok, `repeat pull failed: ${latest.reason}`);
    const firstRepeat = merge(state, latest.doc);
    const secondRepeat = merge(firstRepeat.state, latest.doc);
    const noOpOk = secondRepeat.stats.applied === false;
    assert(noOpOk, "repeated merge was not a no-op");

    const future = clone(latest.doc);
    const futureNode = future.nodes.find((node) => node.id === targetNodeId);
    const futureClock = 4_102_444_800_000;
    futureNode.title = "Future title";
    futureNode.titleUpdatedAt = futureClock;
    futureNode.updatedAt = futureClock;
    futureNode.updatedBy = "future_device";
    future.writtenAt = futureClock;
    future.contentHash = hashSyncDocument(future);
    const receivedFuture = merge(state, future).state;
    stampNodeFieldChanges(receivedFuture.nodes[targetNodeId], { titleChanged: true });
    receivedFuture.nodes[targetNodeId].title = `Recovered ${role}`;
    const futureResult = merge(receivedFuture, future).state;
    const futureOk = futureResult.nodes[targetNodeId].title === `Recovered ${role}`;
    assert(futureOk, "local edit did not advance past future clock");

    const deleted = clone(state);
    markNodeDeleted(deleted, "browser_add_a", 10_000);
    deleted.groups[0].nodes = deleted.groups[0].nodes.filter((id) => id !== "browser_add_a");
    const expiredProjection = project(deleted, 99, 10_000 + 61 * 24 * 60 * 60 * 1000);
    const oldOffline = clone(state);
    oldOffline.nodes.browser_add_a.updatedAt = 9_000;
    const deletedResult = merge(oldOffline, expiredProjection).state;
    const tombstoneOk =
      expiredProjection.nodes.some((node) => node.id === "browser_add_a" && node.deletedAt === 10_000) &&
      !!deletedResult.nodes.browser_add_a.deletedAt;
    assert(tombstoneOk, "expired tombstone allowed node revival");

    const restoredStorage = await restoreLocal();
    const restoredHash = await digest(restoredStorage);
    const localRestoreOk = restoredHash === originalHash;
    assert(localRestoreOk, "local storage restore hash mismatch");
    await event("final", {
      unionOk,
      fieldOk,
      noOpOk,
      futureOk,
      tombstoneOk,
      localRestoreOk,
      originalHash,
      restoredHash,
    });
  }

  run().catch(async (error) => {
    try {
      await restoreLocal();
    } catch (_ignored) {
      // The parent process uses disposable profiles and still restores cloud state.
    }
    try {
      await event("failure", { message: error?.message || String(error) });
    } catch (_ignored) {
      // Coordinator may already be unavailable.
    }
  });
})();
