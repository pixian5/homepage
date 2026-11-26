import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { isAllBookmarksGroup } from "../src/js/data-utils.js";
import {
  applySettingsFormToData,
  buildSettingsModalHtml,
  hydrateSettingsForm,
} from "../src/js/settings-form-renderer.js";
import { normalizeLanguage } from "../src/js/shared-utils.js";
import { defaultData } from "../src/js/storage.js";
import { normalizeSyncInterval, SYNC_INTERVAL_OPTIONS } from "../src/js/sync_policy.js";
import { html, rawHtml } from "../src/js/ui-utils.js";

const realDocument = globalThis.document;

function makeField(id, tagName = "INPUT") {
  return {
    id,
    tagName,
    value: "",
    checked: false,
    disabled: false,
    textContent: "",
    files: [],
    children: [],
    replaceChildren(...items) {
      this.children = items;
    },
    appendChild(item) {
      this.children.push(item);
      return item;
    },
  };
}

afterEach(() => {
  globalThis.document = realDocument;
});

describe("settings-form-renderer", () => {
  it("builds settings html, hydrates controls, and applies modified values back into data", async () => {
    const data = defaultData();
    const fields = new Map();
    const radios = ["compact", "standard", "spacious"].map((value) => {
      const r = makeField(`density_${value}`);
      r.value = value;
      return r;
    });
    const $ = (id) => {
      if (!fields.has(id)) fields.set(id, makeField(id));
      return fields.get(id);
    };
    const qsa = (selector) => (selector === "input[name='density']" ? radios : []);
    globalThis.document = { createElement: (tag) => makeField(tag, tag.toUpperCase()) };

    const markup = buildSettingsModalHtml({
      html,
      rawHtml,
      escapeHtml: (s) => String(s ?? ""),
      t: (k) => k,
      buildLanguageOptions: () => "<option value='zh-CN'>中文</option>",
      language: "zh-CN",
      syncIntervalOptions: SYNC_INTERVAL_OPTIONS,
    });
    assert.ok(markup.includes("settingSyncE2eePassphrase"));
    assert.ok(markup.includes("settingIconThirdPartyFallback"));

    hydrateSettingsForm({
      $,
      qsa,
      elements: { modal: {} },
      data,
      currentLang: () => "zh-CN",
      t: (k) => k,
      normalizeSyncInterval,
      getRootContainers: () => data.groups,
      isAllBookmarksGroup,
      defaultToastDurationSeconds: 5,
      getAppVersion: () => "27.3.6",
    });

    assert.equal($("settingsVersion").textContent, "27.3.6");
    assert.equal($("settingIconThirdPartyFallback").checked, true);

    $("settingSync").checked = true;
    $("settingSyncServerUrl").value = "https://sync.example.com";
    $("settingSyncE2eeEnabled").checked = true;
    $("settingSyncE2eePassphrase").value = "secret-pass";
    $("settingIconThirdPartyFallback").checked = false;
    $("settingToastDuration").value = "999";

    const flags = await applySettingsFormToData({
      $,
      qsa,
      elements: { modal: {} },
      data,
      normalizeUrl: (u) => u,
      normalizeLanguage,
      normalizeSyncInterval,
      detectPreferredLanguage: () => "zh-CN",
      getRootContainerById: (id) => data.groups.find((g) => g.id === id),
      isAllBookmarksGroup,
      stampNodeFieldChanges: () => {},
      defaultToastDurationSeconds: 5,
      readFileAsDataUrl: async () => "",
    });

    assert.equal(flags.connectionChanged, true);
    assert.equal(flags.e2eeChanged, true);
    assert.equal(data.settings.syncE2eeEnabled, true);
    assert.equal(data.settings.syncE2eePassphrase, "secret-pass");
    assert.equal(data.settings.iconThirdPartyFallback, false);
    assert.equal(data.settings.toastDuration, 60);
  });
});
