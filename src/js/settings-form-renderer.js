/**
 * 设置面板 HTML 模板渲染、表单回填与数据写回（从 settings-controller.js 拆出）。
 *
 * 用 IIFE 包裹，保证 Firefox 拼接经典脚本时不与其它模块重名。
 */

var HomepageSettingsFormRenderer = (() => {
  const SEARCH_ENGINE_PRESETS = {
    "https://www.google.com/search?q=": "https://www.google.com/search?q=",
    "https://www.baidu.com/s?wd=": "https://www.baidu.com/s?wd=",
    "https://www.bing.com/search?q=": "https://www.bing.com/search?q=",
    "https://www.so.com/s?q=": "https://www.so.com/s?q=",
    "https://www.yandex.com/search/?text=": "https://www.yandex.com/search/?text=",
  };

  function buildSettingsModalHtml({
    html,
    rawHtml,
    escapeHtml,
    t,
    buildLanguageOptions,
    language,
    syncIntervalOptions,
  }) {
    return html`
      <div class="section settings-actions">
        <button id="btnExport" class="icon-btn">${t("settings.action.export")}</button>
        <button id="btnImport" class="icon-btn">${t("settings.action.import")}</button>
        <button id="btnImportUrl" class="icon-btn">${t("settings.action.importUrl")}</button>
        <button id="btnBackupManage" class="icon-btn">${t("settings.action.backup")}</button>
        <button id="btnExportBookmarksHtml" class="icon-btn">${t("settings.bookmarks.exportHtml")}</button>
        <button id="btnImportBookmarksHtml" class="icon-btn">${t("settings.bookmarks.importHtml")}</button>
        <button id="btnClearData" class="icon-btn danger strong-label">${t("settings.action.clearData")}</button>
        <button id="btnClearCards" class="icon-btn danger">${t("settings.action.clearCards")}</button>
        <button id="btnDedupeBookmarks" class="icon-btn">${t("settings.action.dedupeBookmarks")}</button>
        <button id="btnRefreshIcons" class="icon-btn">${t("settings.action.refreshIcons")}</button>
      </div>
      <div class="section settings-language-row">
        <div class="row-inline settings-language-wrap">
          <span class="settings-language-hint">中/臺/EN/JP/KR/DE/FR/ES</span>
          <select id="settingLanguage" class="inline-select settings-language-select">${rawHtml(buildLanguageOptions(language))}</select>
        </div>
        <span id="settingsVersion" class="build-version"></span>
      </div>

      <div class="section">
        <label><input id="settingShowSearch" type="checkbox"> ${t("settings.showSearch")}</label>
        <div class="row-inline">
          <span class="inline-label">${t("settings.searchEngine")}</span>
          <select id="settingSearchEnginePreset" class="inline-select">
            <option value="https://www.google.com/search?q=">Google</option>
            <option value="https://www.baidu.com/s?wd=">百度</option>
            <option value="https://www.bing.com/search?q=">Bing</option>
            <option value="https://www.so.com/s?q=">360</option>
            <option value="https://www.yandex.com/search/?text=">Yandex</option>
            <option value="custom">${t("settings.searchEngine.custom")}</option>
          </select>
        </div>
        <input id="settingSearchEngine" type="text" placeholder="https://www.bing.com/search?q=" class="inline-text" />
      </div>

      <div class="section">
        <div class="row-inline">
          <label><input id="settingFixedLayout" type="checkbox"> ${t("settings.fixedLayout")}</label>
          <div class="inline-field">
            <input id="settingCols" type="number" min="1" />
          </div>
        </div>
        <div class="row-inline density-row">
          <span class="inline-label">${t("settings.tileGap")}</span>
          <label><input type="radio" name="density" value="compact" /> ${t("settings.density.compact")}</label>
          <label><input type="radio" name="density" value="standard" /> ${t("settings.density.standard")}</label>
          <label><input type="radio" name="density" value="spacious" /> ${t("settings.density.spacious")}</label>
        </div>
      </div>

      <div class="section">
        <div class="row-inline">
          <span class="inline-label">${t("settings.background")}</span>
          <select id="settingBgType" class="inline-select">
            <option value="bing">${t("settings.background.bing")}</option>
            <option value="color">${t("settings.background.color")}</option>
            <option value="gradient">${t("settings.background.gradient")}</option>
            <option value="custom">${t("settings.background.custom")}</option>
          </select>
        </div>
        <div id="bgColorWrap">
          <input id="settingBgColor" type="color" />
        </div>
        <div id="bgGradientWrap">
          <label>${t("settings.gradientColor")}</label>
          <div class="row">
            <input id="settingBgGradientA" type="color" />
            <input id="settingBgGradientB" type="color" />
          </div>
        </div>
        <input id="settingBgGradient" type="hidden" />
        <input id="settingBgFile" type="file" accept="image/*" />
      </div>

      <div class="section">
        <div class="row-inline">
          <span class="inline-label">${t("settings.bgOverlay")}</span>
          <input id="settingBgOverlay" type="range" min="0" max="0.6" step="0.01" class="inline-range" />
          <span id="settingBgOverlayValue" class="inline-value"></span>
        </div>
      </div>

      <div class="section">
        <label><input id="settingTooltip" type="checkbox"> ${t("settings.tooltip")}</label>
        <label><input id="settingKeyboard" type="checkbox"> ${t("settings.keyboard")}</label>
      </div>

      <div class="section">
        <div class="row-inline">
          <span class="inline-label">${t("settings.theme")}</span>
          <select id="settingTheme" class="inline-select">
            <option value="system">${t("settings.theme.system")}</option>
            <option value="light">${t("settings.theme.light")}</option>
            <option value="dark">${t("settings.theme.dark")}</option>
          </select>
        </div>
      </div>

      <div class="section">
        <div class="row-inline">
          <span class="inline-label">${t("settings.fontSize")}</span>
          <input id="settingFontSize" type="number" min="10" max="24" class="inline-number" />
        </div>
        <div class="row-inline">
          <span class="inline-label">${t("settings.toastDuration")}</span>
          <input id="settingToastDuration" type="number" min="1" max="60" step="1" class="inline-number" />
        </div>
      </div>

      <div class="section">
        <div class="row-inline">
          <span class="inline-label">${t("settings.defaultGroup")}</span>
        </div>
        <div class="row-inline">
          <select id="settingDefaultGroupId" class="inline-select"></select>
        </div>
      </div>

      <div class="section">
        <label><input id="settingSidebarCollapsed" type="checkbox"> ${t("settings.hideSidebar")}</label>
      </div>

      <div class="section">
        <label><input id="settingSync" type="checkbox"> ${t("settings.sync")}</label>
        <div class="row-inline">
          <span class="inline-label">${t("settings.sync.interval")}</span>
          <select id="settingSyncInterval" class="inline-select">
            ${rawHtml(
              syncIntervalOptions
                .map(
                  (o) =>
                    `<option value="${escapeHtml(o.value)}">${escapeHtml(t(`settings.sync.interval.${o.value}`))}</option>`,
                )
                .join(""),
            )}
          </select>
        </div>
        <div id="syncHttpFields" class="settings-sync-http">
          <div class="row-inline">
            <span class="inline-label">${t("settings.sync.serverUrl")}</span>
            <input id="settingSyncServerUrl" type="url" class="inline-text" placeholder="${t("settings.sync.serverUrlPh")}" />
          </div>
          <div class="row-inline">
            <span class="inline-label">${t("settings.sync.serverToken")}</span>
            <input id="settingSyncServerToken" type="password" class="inline-text" autocomplete="off" />
          </div>
          <label><input id="settingSyncE2eeEnabled" type="checkbox"> ${t("settings.sync.e2ee.enable")}</label>
          <div class="row-inline">
            <span class="inline-label">${t("settings.sync.e2ee.passphrase")}</span>
            <input id="settingSyncE2eePassphrase" type="password" class="inline-text" autocomplete="new-password" placeholder="${t("settings.sync.e2ee.passphrasePh")}" />
          </div>
          <p class="settings-sync-hint">${t("settings.sync.e2ee.hint")}</p>
          <div class="row-inline settings-sync-actions">
            <button type="button" id="btnSyncTestServer" class="icon-btn">${t("settings.sync.testServer")}</button>
            <button type="button" id="btnSyncNow" class="icon-btn">${t("settings.sync.now")}</button>
          </div>
          <div id="syncDevicesPanel" class="settings-sync-devices">
            <div class="row-inline settings-sync-devices-head">
              <span class="inline-label">${t("settings.sync.devices.title")}</span>
              <button type="button" id="btnSyncRefreshDevices" class="icon-btn">${t("settings.sync.devices.refresh")}</button>
            </div>
            <div id="syncDevicesHealth" class="settings-sync-health"></div>
            <div id="syncDevicesList" class="settings-sync-device-list"></div>
            <p class="settings-sync-hint">${t("settings.sync.devices.hint")}</p>
          </div>
        </div>
        <div id="syncStatusLine" class="settings-sync-status"></div>
        <div class="row-inline settings-sync-actions">
          <button type="button" id="btnSyncResolveConflict" class="icon-btn hidden">${t("settings.sync.state.conflict")}</button>
          <button type="button" id="btnSyncExportBundle" class="icon-btn">${t("settings.sync.exportBundle")}</button>
          <button type="button" id="btnSyncImportBundle" class="icon-btn">${t("settings.sync.importBundle")}</button>
          <button type="button" id="btnSyncExportFile" class="icon-btn">${t("settings.sync.exportFile")}</button>
          <button type="button" id="btnSyncImportFile" class="icon-btn">${t("settings.sync.importFile")}</button>
        </div>
        <input id="syncImportFileInput" type="file" accept="application/json,.json" class="hidden" />
        <input id="importBookmarksHtmlInput" type="file" accept=".html,text/html" class="hidden" />
        <p class="settings-sync-hint">${t("settings.sync.hint")}</p>
        <div class="row-inline">
          <span class="inline-label">${t("settings.openMode")}</span>
          <select id="settingOpenMode" class="inline-select">
            <option value="current">${t("openMode.current")}</option>
            <option value="new">${t("openMode.new")}</option>
            <option value="background">${t("openMode.background")}</option>
          </select>
        </div>
        <div class="row-inline">
          <span class="inline-label">${t("settings.maxBackups")}</span>
          <input id="settingBackup" type="number" min="0" class="inline-number" />
        </div>
        <div class="row-inline">
          <span class="inline-label">${t("settings.iconRetry")}</span>
          <select id="settingIconRetryHour" class="inline-select">
            <option value="">${t("settings.retryDisabled")}</option>
            <option value="0">00:00</option>
            <option value="1">01:00</option>
            <option value="2">02:00</option>
            <option value="3">03:00</option>
            <option value="4">04:00</option>
            <option value="5">05:00</option>
            <option value="6">06:00</option>
            <option value="7">07:00</option>
            <option value="8">08:00</option>
            <option value="9">09:00</option>
            <option value="10">10:00</option>
            <option value="11">11:00</option>
            <option value="12">12:00</option>
            <option value="13">13:00</option>
            <option value="14">14:00</option>
            <option value="15">15:00</option>
            <option value="16">16:00</option>
            <option value="17">17:00</option>
            <option value="18">18:00</option>
            <option value="19">19:00</option>
            <option value="20">20:00</option>
            <option value="21">21:00</option>
            <option value="22">22:00</option>
            <option value="23">23:00</option>
          </select>
        </div>
        <label><input id="settingIconThirdPartyFallback" type="checkbox"> ${t("settings.iconThirdPartyFallback")}</label>
      </div>
    `;
  }

  function hydrateSettingsForm({
    $,
    qsa,
    elements,
    data,
    currentLang,
    t,
    normalizeSyncInterval,
    getRootContainers,
    isAllBookmarksGroup,
    defaultToastDurationSeconds,
    getAppVersion,
  }) {
    const s = data.settings;
    $("settingShowSearch").checked = s.showSearch;
    $("settingSearchEngine").value = s.searchEngineUrl;
    const presetValue = SEARCH_ENGINE_PRESETS[s.searchEngineUrl] || "custom";
    $("settingSearchEnginePreset").value = presetValue;
    $("settingSearchEngine").disabled = presetValue !== "custom";
    $("settingFixedLayout").checked = s.fixedLayout;
    $("settingCols").value = s.fixedCols;
    qsa("input[name='density']", elements.modal).forEach((radio) => {
      radio.checked = radio.value === s.gridDensity;
    });
    $("settingBgType").value = s.backgroundType;
    $("settingBgColor").value = s.backgroundColor;
    $("settingBgGradient").value = s.backgroundGradient;
    const match = /linear-gradient\([^,]+,\s*([^,]+),\s*([^)]+)\)/.exec(s.backgroundGradient || "");
    const gA = s.backgroundGradientA || match?.[1]?.trim() || "#1d2a3b";
    const gB = s.backgroundGradientB || match?.[2]?.trim() || "#0b0f14";
    $("settingBgGradientA").value = gA;
    $("settingBgGradientB").value = gB;
    $("settingBgOverlay").value = Number(s.backgroundOverlayStrength ?? 0.08);
    $("settingBgOverlayValue").textContent = `${Math.round(Number($("settingBgOverlay").value) * 100)}%`;
    $("settingTooltip").checked = s.tooltipEnabled;
    $("settingKeyboard").checked = s.keyboardNav;
    $("settingTheme").value = s.theme || "system";
    $("settingFontSize").value = s.fontSize || 13;
    $("settingToastDuration").value = Math.min(60, Math.max(1, Number(s.toastDuration) || defaultToastDurationSeconds));
    $("settingLanguage").value = currentLang();
    $("settingSync").checked = s.syncEnabled;
    s.syncTransport = "http";
    const intervalSel = $("settingSyncInterval");
    if (intervalSel) intervalSel.value = normalizeSyncInterval(s.syncInterval);
    const urlInput = $("settingSyncServerUrl");
    if (urlInput) urlInput.value = s.syncServerUrl || "";
    const tokenInput = $("settingSyncServerToken");
    if (tokenInput) tokenInput.value = s.syncServerToken || "";
    const e2eeEnabledInput = $("settingSyncE2eeEnabled");
    if (e2eeEnabledInput) e2eeEnabledInput.checked = !!s.syncE2eeEnabled;
    const e2eePassEl = $("settingSyncE2eePassphrase");
    if (e2eePassEl) e2eePassEl.value = s.syncE2eePassphrase || "";
    $("settingOpenMode").value = s.openMode || "current";
    $("settingBackup").value = s.maxBackups;
    const retryHour = s.iconRetryHour ?? (s.iconRetryAtSix ? 18 : "");
    $("settingIconRetryHour").value = retryHour === "" ? "" : String(retryHour);
    $("settingIconThirdPartyFallback").checked = s.iconThirdPartyFallback !== false;
    $("settingSidebarCollapsed").checked = s.sidebarHidden;

    const defaultGroupId = $("settingDefaultGroupId");
    defaultGroupId.replaceChildren();
    const lastOpt = document.createElement("option");
    lastOpt.value = "";
    lastOpt.textContent = t("settings.lastAddedGroup");
    defaultGroupId.appendChild(lastOpt);
    getRootContainers().forEach((g) => {
      const opt = document.createElement("option");
      opt.value = g.id;
      opt.textContent = isAllBookmarksGroup(g) ? g.name : g.title;
      defaultGroupId.appendChild(opt);
    });
    const useFixed = s.defaultGroupMode === "fixed" && s.defaultGroupId;
    defaultGroupId.value = useFixed ? s.defaultGroupId : "";

    const versionEl = $("settingsVersion");
    if (versionEl) versionEl.textContent = getAppVersion() || "";
  }

  async function applySettingsFormToData({
    $,
    qsa,
    elements,
    data,
    normalizeUrl,
    normalizeLanguage,
    normalizeSyncInterval,
    detectPreferredLanguage,
    getRootContainerById,
    isAllBookmarksGroup,
    stampNodeFieldChanges,
    defaultToastDurationSeconds,
    readFileAsDataUrl,
  }) {
    const s = data.settings;
    qsa(".group-name", elements.modal).forEach((input) => {
      const row = input.closest("[data-group]");
      const id = row.dataset.group;
      const group = getRootContainerById(id);
      if (group && !isAllBookmarksGroup(group)) {
        const nextTitle = input.value.trim() || group.title;
        if (nextTitle !== group.title) {
          stampNodeFieldChanges(group, { titleChanged: true });
          group.title = nextTitle;
        }
      }
    });

    s.showSearch = $("settingShowSearch").checked;
    s.enableSearchEngine = true;
    const engineInput = $("settingSearchEngine").value.trim();
    if (engineInput) {
      const normalizedEngine = normalizeUrl(engineInput);
      s.searchEngineUrl = normalizedEngine || s.searchEngineUrl;
    }
    s.fixedLayout = $("settingFixedLayout").checked;
    s.fixedCols = Number($("settingCols").value) || 8;
    const selectedDensity = qsa("input[name='density']", elements.modal).find((r) => r.checked);
    s.gridDensity = selectedDensity ? selectedDensity.value : s.gridDensity;
    s.backgroundType = $("settingBgType").value;
    s.backgroundColor = $("settingBgColor").value;
    const gA = $("settingBgGradientA").value || "#1d2a3b";
    const gB = $("settingBgGradientB").value || "#0b0f14";
    s.backgroundGradientA = gA;
    s.backgroundGradientB = gB;
    s.backgroundGradient = `linear-gradient(120deg, ${gA}, ${gB})`;
    s.backgroundOverlayStrength = Number($("settingBgOverlay").value);
    s.tooltipEnabled = $("settingTooltip").checked;
    s.keyboardNav = $("settingKeyboard").checked;
    s.fontSize = Number($("settingFontSize").value) || s.fontSize;
    s.toastDuration = Math.min(
      60,
      Math.max(1, Math.round(Number($("settingToastDuration").value) || defaultToastDurationSeconds)),
    );
    s.theme = $("settingTheme").value;
    s.language = normalizeLanguage($("settingLanguage").value) || detectPreferredLanguage();
    const selectedDefaultGroupId = $("settingDefaultGroupId").value;
    s.defaultGroupMode = selectedDefaultGroupId ? "fixed" : "last";
    s.defaultGroupId = selectedDefaultGroupId;
    s.sidebarHidden = $("settingSidebarCollapsed").checked;

    const prevSyncEnabled = !!s.syncEnabled;
    const prevUrl = s.syncServerUrl || "";
    const prevToken = s.syncServerToken || "";
    const prevInterval = normalizeSyncInterval(s.syncInterval);
    const prevE2eeEnabled = !!s.syncE2eeEnabled;
    const prevE2eePassphrase = String(s.syncE2eePassphrase || "");
    s.syncEnabled = $("settingSync").checked;
    s.syncTransport = "http";
    s.syncInterval = normalizeSyncInterval($("settingSyncInterval")?.value);
    s.syncServerUrl = ($("settingSyncServerUrl")?.value || "").trim();
    s.syncServerToken = ($("settingSyncServerToken")?.value || "").trim();
    s.syncE2eeEnabled = !!$("settingSyncE2eeEnabled")?.checked;
    s.syncE2eePassphrase = String($("settingSyncE2eePassphrase")?.value || "");
    const serverChanged = prevUrl !== s.syncServerUrl || prevToken !== s.syncServerToken;
    const intervalChanged = prevInterval !== s.syncInterval;
    const connectionChanged = prevSyncEnabled !== s.syncEnabled || (s.syncEnabled && serverChanged);
    const e2eeChanged = prevE2eeEnabled !== s.syncE2eeEnabled || prevE2eePassphrase !== s.syncE2eePassphrase;

    s.openMode = $("settingOpenMode").value || "current";
    const nextMaxBackups = Number($("settingBackup").value) || 0;
    if (nextMaxBackups > 0 && data.backups.length > nextMaxBackups) {
      data.backups = data.backups.slice(0, nextMaxBackups);
    }
    s.maxBackups = nextMaxBackups;
    const retryVal = $("settingIconRetryHour").value;
    if (retryVal === "") {
      s.iconRetryHour = "";
      s.iconRetryAtSix = false;
    } else {
      s.iconRetryHour = Number(retryVal);
      s.iconRetryAtSix = Number(retryVal) === 18;
    }
    s.iconThirdPartyFallback = $("settingIconThirdPartyFallback").checked;

    const bgFile = $("settingBgFile").files?.[0];
    if (bgFile) {
      s.backgroundCustom = await readFileAsDataUrl(bgFile);
    }

    return { serverChanged, intervalChanged, connectionChanged, e2eeChanged };
  }

  return {
    SEARCH_ENGINE_PRESETS,
    buildSettingsModalHtml,
    hydrateSettingsForm,
    applySettingsFormToData,
  };
})();

export const SEARCH_ENGINE_PRESETS = HomepageSettingsFormRenderer.SEARCH_ENGINE_PRESETS;
export const buildSettingsModalHtml = HomepageSettingsFormRenderer.buildSettingsModalHtml;
export const hydrateSettingsForm = HomepageSettingsFormRenderer.hydrateSettingsForm;
export const applySettingsFormToData = HomepageSettingsFormRenderer.applySettingsFormToData;
