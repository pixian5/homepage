import assert from "node:assert";
import { beforeEach, describe, it } from "node:test";
import { repairHomepageData } from "../src/js/data-utils.js";
import { defaultData, loadData, migrateData, saveData } from "../src/js/storage.js";
import { mergeHomepage } from "../src/js/sync_merge.js";
import { HOMEPAGE_SCHEMA_VERSION } from "../src/js/sync_policy.js";
import { syncDocumentToHomepageShape, toSyncDocument } from "../src/js/sync_projection.js";
import { createThemeManager } from "../src/js/theme-manager.js";

let stored = {};

global.chrome = {
  storage: {
    local: {
      get: (key, cb) => {
        if (typeof key === "string") {
          cb({ [key]: stored[key] });
        } else if (Array.isArray(key)) {
          const res = {};
          for (const k of key) res[k] = stored[k];
          cb(res);
        } else if (key && typeof key === "object") {
          const res = { ...key };
          for (const k of Object.keys(key)) {
            if (stored[k] !== undefined) res[k] = stored[k];
          }
          cb(res);
        } else {
          cb({ ...stored });
        }
        return Promise.resolve();
      },
      set: (obj, cb) => {
        Object.assign(stored, obj);
        cb?.();
        return Promise.resolve();
      },
      remove: (key, cb) => {
        if (typeof key === "string") delete stored[key];
        else if (Array.isArray(key)) for (const k of key) delete stored[k];
        cb?.();
        return Promise.resolve();
      },
    },
  },
  runtime: { lastError: null },
};

beforeEach(() => {
  stored = {};
});

describe("background persistence and schema stability", () => {
  it("repairHomepageData defaults missing schemaVersion to CURRENT_SCHEMA_VERSION (2)", () => {
    const repaired = repairHomepageData({}, { backgroundType: "bing" });
    assert.strictEqual(repaired.schemaVersion, HOMEPAGE_SCHEMA_VERSION);
    assert.strictEqual(repaired.schemaVersion, 2);
  });

  it("syncDocumentToHomepageShape returns data with HOMEPAGE_SCHEMA_VERSION (2)", () => {
    const doc = {
      docId: "doc_test",
      revision: 1,
      settings: { backgroundType: "bing" },
      groups: [],
      nodes: [],
      placements: [],
    };
    const shape = syncDocumentToHomepageShape(doc);
    assert.strictEqual(shape.schemaVersion, HOMEPAGE_SCHEMA_VERSION);
    assert.strictEqual(shape.schemaVersion, 2);
    assert.strictEqual(shape.settings.backgroundType, "bing");
  });

  it("mergeHomepage preserves schemaVersion: 2 and does not downgrade schema", async () => {
    const local = defaultData();
    local.settings.backgroundType = "bing";
    local.schemaVersion = 2;

    const remoteDoc = toSyncDocument(local, {
      deviceId: "dev_remote",
      docId: "doc_test",
      revision: 2,
      writtenAt: Date.now() + 1000,
    });

    const merged = mergeHomepage(local, remoteDoc, { deviceId: "dev_local", now: Date.now() });
    assert.strictEqual(merged.ok, true);
    assert.strictEqual(merged.state.schemaVersion, 2);
    assert.strictEqual(merged.state.settings.backgroundType, "bing");

    // 再次调用 migrateData，确保不会触发 v1 -> v2 覆盖为纯色
    const postMigration = migrateData(merged.state);
    assert.strictEqual(postMigration.schemaVersion, 2);
    assert.strictEqual(postMigration.settings.backgroundType, "bing");

    // 保存后重新 loadData，验证落盘与重载全生命周期中 backgroundType 保持 bing
    await saveData(merged.state, false);
    const reloaded = await loadData();
    assert.strictEqual(reloaded.schemaVersion, 2);
    assert.strictEqual(reloaded.settings.backgroundType, "bing");
  });

  it("custom image background is preserved locally across sync document projection and fallback merge", () => {
    const local = defaultData();
    local.settings.backgroundType = "custom";
    local.settings.backgroundCustom = "data:image/png;base64,ORIGINAL_CUSTOM_BG";

    // 投影到云端时，为了节省网络带宽，自定义图片会被剔除为 ""
    const projectedDoc = toSyncDocument(local, {
      deviceId: "dev_test",
      docId: "doc_custom",
      revision: 1,
      writtenAt: Date.now(),
    });
    assert.strictEqual(projectedDoc.settings.backgroundCustom, "");

    // 投影还原
    const shape = syncDocumentToHomepageShape(projectedDoc);
    assert.strictEqual(shape.schemaVersion, 2);

    // 合并时，由于 backgroundCustom 不在云端同步白名单内，本地大图必须被原样保全
    const merged = mergeHomepage(local, projectedDoc, { deviceId: "dev_test", now: Date.now() });
    assert.strictEqual(merged.ok, true);
    assert.strictEqual(merged.state.settings.backgroundCustom, "data:image/png;base64,ORIGINAL_CUSTOM_BG");
  });

  it("theme-manager ensures cover and center styling on background element", () => {
    const el = {
      style: {},
      classList: {
        add: () => {},
        remove: () => {},
      },
    };

    const manager = createThemeManager({
      getData: () => ({
        settings: {
          backgroundType: "custom",
          backgroundColor: "#112233",
          backgroundCustom: "data:image/png;base64,TEST",
        },
      }),
      getBackgroundEl: () => el,
      getDocEl: () => ({ style: { setProperty: () => {} } }),
      isSafeCssColor: () => true,
      t: (k) => k,
      toast: () => {},
      getBingWallpaper: async () => ({ dataUrl: "" }),
    });

    manager.setSolidBackgroundColor("#112233");
    assert.strictEqual(el.style.backgroundColor, "#112233");
    assert.strictEqual(el.style.backgroundImage, "none");

    manager.setBackground("data:image/png;base64,TEST");
    assert.strictEqual(el.style.backgroundSize, "cover");
    assert.strictEqual(el.style.backgroundPosition, "center");
    assert.strictEqual(el.style.backgroundRepeat, "no-repeat");
    assert.strictEqual(el.style.backgroundImage, 'url("data:image/png;base64,TEST")');
  });
});
