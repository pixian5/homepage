import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import * as bookmarkHtml from "../src/js/bookmark-html.js";
import * as dataUtils from "../src/js/data-utils.js";
import { createImportExport } from "../src/js/import-export.js";
import { normalizeUrl, normalizeUrlWithScheme } from "../src/js/shared-utils.js";
import { createBackupSnapshot, defaultData, defaultSettings } from "../src/js/storage.js";
import { exportSyncBundle, importSyncBundle } from "../src/js/sync_bundle.js";
import { mergeHomepage } from "../src/js/sync_merge.js";
import { toSyncDocument } from "../src/js/sync_projection.js";
import { html, rawHtml, runWithButtonState } from "../src/js/ui-utils.js";

const realDocument = globalThis.document;
const realClipboardDesc = Object.getOwnPropertyDescriptor(globalThis.navigator, "clipboard");

function makeDomHarness() {
  const fields = new Map();
  const makeEl = (id = "") => {
    const listeners = new Map();
    const el = {
      id,
      value: "",
      textContent: "",
      dataset: {},
      disabled: false,
      isConnected: true,
      addEventListener: (type, fn) => {
        listeners.set(type, fn);
      },
      removeEventListener: () => {},
      click: async () => {
        const fn = listeners.get("click");
        return fn ? await fn({ target: el }) : undefined;
      },
      closest: () => el,
      setAttribute() {},
      removeAttribute() {},
      remove() {},
    };
    return el;
  };
  const $ = (id) => {
    if (!fields.has(id)) fields.set(id, makeEl(id));
    return fields.get(id);
  };
  const qsa = (selector) => {
    if (selector === ".backup-restore") return [$("__backupRestoreBtn")];
    if (selector === ".backup-delete") return [];
    return [];
  };
  return { $, qsa, fields };
}

function setupImportExport({ data, syncDocId = "doc_active_sync", platform = "firefox", writeTextImpl } = {}) {
  let stateData = data;
  let lastModalHtml = "";
  const toasts = [];
  const { $, qsa } = makeDomHarness();

  globalThis.document = {
    body: {
      appendChild() {},
    },
    createElement: () => ({
      href: "",
      download: "",
      rel: "",
      click() {},
      remove() {},
    }),
  };
  Object.defineProperty(globalThis.navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: writeTextImpl || (async () => {}),
      readText: async () => "",
    },
  });

  const ie = createImportExport(
    {
      getData: () => stateData,
      setData: (next) => {
        stateData = next;
      },
      getActiveGroupId: () => "grp_all",
      syncBackupBaseline() {},
      ui: {
        $,
        qsa,
        html,
        rawHtml,
        t: (key) => key,
        toast: (msg, type = "success") => toasts.push({ msg, type }),
        elements: { modal: {}, modalOverlay: { addEventListener() {}, removeEventListener() {} } },
        openModal(rendered) {
          lastModalHtml = rendered?.__html ?? String(rendered || "");
        },
        closeModal() {},
        runWithButtonState,
        render() {},
        persistData: async () => ({ ok: true }),
        pushBackup() {
          const snap = createBackupSnapshot(stateData);
          stateData.backups.unshift(snap);
        },
        processPendingIconFetches() {},
      },
      deps: {
        normalizeUrl,
        normalizeUrlWithScheme,
        detectExtensionPlatform: () => platform,
        createDocId: () => "doc_random_fallback",
        getOrCreateDeviceId: async () => "dev_local",
        getSyncStatus: () => ({ docId: syncDocId }),
        exportSyncBundle,
        importSyncBundle,
        exportNetscapeBookmarksHtml: bookmarkHtml.exportNetscapeBookmarksHtml,
        parseNetscapeBookmarksHtml: bookmarkHtml.parseNetscapeBookmarksHtml,
        bookmarksToHomepageData: bookmarkHtml.bookmarksToHomepageData,
        leaveSettingsForSubpanel: async () => {},
        defaultSettings,
        cloneDataSnapshot: dataUtils.cloneDataSnapshot,
        repairHomepageData: dataUtils.repairHomepageData,
        markNodeDeleted: dataUtils.markNodeDeleted,
        mergeRootBookmarkData: dataUtils.mergeRootBookmarkData,
        mergeHomepage,
        toSyncDocument,
        createItemNode: dataUtils.createItemNode,
        stampNodeFieldChanges: dataUtils.stampNodeFieldChanges,
        resetSettingsClockBaseline() {},
        resetPlacementClockBaseline() {},
        getRootGroup: () => stateData.groups[0],
        getRootContainers: () => stateData.groups,
        getRootContainerById: (id) => stateData.groups.find((g) => g.id === id),
        getPlacementList: (c) => c.nodes || [],
        setPlacementList: (c, l) => {
          c.nodes = l;
        },
        touchPlacementContainer() {},
        removeNodeFromLocation() {},
        findDuplicateBookmarkGroups: () => ({ groups: [], totalDuplicateCount: 0 }),
        mergeDuplicateBookmarks: () => ({ mergedGroups: 0, removedCount: 0 }),
        isAllBookmarksGroup: (g) => g?.id === "grp_all",
        RECENT_GROUP_ID: "__recent__",
      },
    },
    () => {},
  );

  return { ie, $, getData: () => stateData, getModalHtml: () => lastModalHtml, toasts };
}

afterEach(() => {
  if (realDocument === undefined) delete globalThis.document;
  else globalThis.document = realDocument;
  if (realClipboardDesc) Object.defineProperty(globalThis.navigator, "clipboard", realClipboardDesc);
});

describe("import-export sync secret hygiene & bundle metadata", () => {
  it("redacts syncServerToken and syncE2eePassphrase from JSON exports without mutating live data", async () => {
    const data = defaultData();
    data.settings.syncEnabled = true;
    data.settings.syncServerUrl = "https://sync.example.com";
    data.settings.syncServerToken = "top-secret-token";
    data.settings.syncE2eeEnabled = true;
    data.settings.syncE2eePassphrase = "top-secret-e2ee-passphrase";
    data.backups = [
      {
        id: "bak_legacy",
        ts: 123,
        data: {
          ...defaultData(),
          settings: {
            ...defaultSettings(),
            syncServerToken: "legacy-token-in-backup",
            syncE2eePassphrase: "legacy-pass-in-backup",
          },
        },
      },
    ];

    let copiedText = "";
    const ctx = setupImportExport({
      data,
      writeTextImpl: async (text) => {
        copiedText = text;
      },
    });
    await ctx.ie.exportJsonToClipboard();

    const parsed = JSON.parse(copiedText);
    assert.equal(parsed.settings.syncServerUrl, "https://sync.example.com");
    assert.equal(parsed.settings.syncServerToken, "");
    assert.equal(parsed.settings.syncE2eePassphrase, "");
    assert.equal(parsed.backups[0].data.settings.syncServerToken, "");
    assert.equal(parsed.backups[0].data.settings.syncE2eePassphrase, "");

    // 内存原对象不受影响
    assert.equal(data.settings.syncServerToken, "top-secret-token");
    assert.equal(data.settings.syncE2eePassphrase, "top-secret-e2ee-passphrase");
  });

  it("redacts sync secrets in openManualExportModal fallback when clipboard denies access", async () => {
    const data = defaultData();
    data.settings.syncServerToken = "manual-secret-token";
    data.settings.syncE2eePassphrase = "manual-secret-pass";
    const ctx = setupImportExport({
      data,
      writeTextImpl: async () => {
        throw new Error("clipboard_denied");
      },
    });

    await ctx.ie.exportJsonToClipboard();
    assert.equal(ctx.getModalHtml().includes("manual-secret-token"), false);
    assert.equal(ctx.getModalHtml().includes("manual-secret-pass"), false);
  });

  it("preserves current local sync secrets on replace import of redacted JSON and on backup restore", async () => {
    const data = defaultData();
    data.settings.syncServerUrl = "https://sync.example.com";
    data.settings.syncServerToken = "current-master-token";
    data.settings.syncE2eeEnabled = true;
    data.settings.syncE2eePassphrase = "rotated-passphrase";
    const snap = createBackupSnapshot(data);
    snap.data.settings.fontSize = 19;
    data.backups = [snap];

    const ctx = setupImportExport({ data });
    ctx.ie.openBackupModal();
    ctx.$("__backupRestoreBtn").dataset = { backup: snap.id };
    await ctx.$("__backupRestoreBtn").click();
    assert.equal(ctx.getData().settings.fontSize, 19);
    assert.equal(ctx.getData().settings.syncServerToken, "current-master-token");
    assert.equal(ctx.getData().settings.syncE2eePassphrase, "rotated-passphrase");

    // 替换导入脱敏 JSON 时也保留当前本机凭据
    await ctx.ie.openImportModal();
    const redactedImport = defaultData();
    redactedImport.settings.fontSize = 21;
    redactedImport.settings.syncServerToken = "";
    redactedImport.settings.syncE2eePassphrase = "";
    ctx.$("importText").value = JSON.stringify(redactedImport);
    ctx.$("importMode").value = "replace";
    await ctx.$("btnImportNow").click();

    assert.equal(ctx.getData().settings.fontSize, 21);
    assert.equal(ctx.getData().settings.syncServerToken, "current-master-token");
    assert.equal(ctx.getData().settings.syncE2eePassphrase, "rotated-passphrase");
  });

  it("reuses active syncStatus.docId and detectExtensionPlatform when exporting clipboard sync bundle", async () => {
    let copiedBundle = "";
    const data = defaultData();
    const ctx = setupImportExport({
      data,
      syncDocId: "doc_shared_main",
      platform: "safari",
      writeTextImpl: async (text) => {
        copiedBundle = text;
      },
    });
    ctx.ie.bindButtons();
    await ctx.$("btnSyncExportBundle").click();

    const parsed = JSON.parse(copiedBundle);
    assert.equal(parsed.payload.docId, "doc_shared_main");
    assert.equal(parsed.source.platform, "safari");
  });
});
