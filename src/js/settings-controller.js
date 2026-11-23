/**
 * 设置面板控制器（从 app.js 拆出）。
 *
 * 用 IIFE 包裹：Firefox 版把所有模块拼成一个经典脚本，
 * 顶层 const/let 会和其它模块重名（例如 html / t / render）。IIFE 保证只暴露一个全局名。
 */
import { createImportExport } from "./import-export.js";

var HomepageSettingsController = (() => {
  let _ctx = {};
  // 导入导出控制器：在 configure 时创建，事件处理器通过它委托
  let ieCtl = null;

  let getData,
    setData,
    setActiveGroupId,
    state,
    $,
    qsa,
    html,
    rawHtml,
    escapeHtml,
    t,
    currentLang,
    toast,
    elements,
    openModal,
    closeModal,
    runWithButtonState,
    render,
    persistData,
    pushBackup,
    processPendingIconFetches,
    loadBackground,
    applyDensity,
    applyTheme,
    applyStaticI18n,
    applySidebarState,
    normalizeUrl,
    normalizeLanguage,
    normalizeSyncInterval,
    detectPreferredLanguage,
    getAppVersion,
    syncBytesBudgetLevel,
    estimateSyncProjectionBytes,
    getOrCreateDeviceId,
    getSyncStatus,
    getPendingConflict,
    reloadSyncState,
    resolveDocConflict,
    pullNow,
    pushNow,
    onSyncEnabledChanged,
    refreshSyncInterval,
    cancelScheduledPush,
    httpHealth,
    httpPullState,
    httpGetDevices,
    httpRetireDevice,
    ensureDevicePairing,
    readFileAsDataUrl,
    buildLanguageOptions,
    clearData,
    defaultData,
    deepClone,
    markNodeDeleted,
    stampNodeFieldChanges,
    getRootGroup,
    getRootContainers,
    getRootContainerById,
    isAllBookmarksGroup,
    refreshAllIcons,
    ALL_BOOKMARKS_GROUP_ID,
    SYNC_INTERVAL_OPTIONS,
    DEFAULT_TOAST_DURATION_SECONDS,
    SETTINGS_SAVE_DELAY_MS;

  function openSyncConflictModal() {
    const pending = getPendingConflict();
    if (!pending) {
      toast(t("settings.sync.state.idle"));
      return;
    }
    const modalHtml = html`
      <h2>${t("settings.sync.conflict.title")}</h2>
      <div class="section">
        <p>${t("settings.sync.conflict.desc")}</p>
        <p class="settings-sync-hint">local: ${pending.localDocId || "-"}<br/>remote: ${pending.remoteDocId || "-"}</p>
      </div>
      <div class="actions">
        <button type="button" id="btnConflictMerge" class="icon-btn">${t("settings.sync.conflict.merge")}</button>
        <button type="button" id="btnConflictLocal" class="icon-btn">${t("settings.sync.conflict.local")}</button>
        <button type="button" id="btnConflictRemote" class="icon-btn">${t("settings.sync.conflict.remote")}</button>
        <button type="button" id="btnConflictCancel" class="icon-btn">${t("common.cancel")}</button>
      </div>
    `;
    openModal(modalHtml);
    const run = async (choice) => {
      const btnIds = ["btnConflictMerge", "btnConflictLocal", "btnConflictRemote", "btnConflictCancel"];
      for (const id of btnIds) {
        const b = $(id);
        if (b) b.disabled = true;
      }
      try {
        const res = await resolveDocConflict(choice);
        if (!res?.ok) {
          toast(t("settings.sync.importFail", { reason: res?.reason || "conflict" }), "error");
          return;
        }
        closeModal();
        toast(t("settings.sync.conflict.done"));
        render();
        processPendingIconFetches();
        // 若设置仍打开则刷新状态（关闭后由下次打开刷新）
      } catch (e) {
        toast(t("settings.sync.importFail", { reason: e?.message || "conflict" }), "error");
      }
    };
    $("btnConflictMerge")?.addEventListener("click", () => void run("merge"));
    $("btnConflictLocal")?.addEventListener("click", () => void run("local"));
    $("btnConflictRemote")?.addEventListener("click", () => void run("remote"));
    $("btnConflictCancel")?.addEventListener("click", () => closeModal());
  }

  /** 从设置表单即时读入同步相关字段（不依赖 debounce 保存） */
  function applySyncSettingsFromForm() {
    if (!getData().settings) getData().settings = {};
    const syncEl = $("settingSync");
    const intervalEl = $("settingSyncInterval");
    const urlEl = $("settingSyncServerUrl");
    const tokenEl = $("settingSyncServerToken");
    if (syncEl) getData().settings.syncEnabled = !!syncEl.checked;
    getData().settings.syncTransport = "http";
    if (intervalEl) getData().settings.syncInterval = normalizeSyncInterval(intervalEl.value);
    if (urlEl) getData().settings.syncServerUrl = (urlEl.value || "").trim();
    if (tokenEl) getData().settings.syncServerToken = (tokenEl.value || "").trim();
    return {
      enabled: !!getData().settings.syncEnabled,
      transport: "http",
      interval: getData().settings.syncInterval || "5m",
      url: getData().settings.syncServerUrl || "",
      token: getData().settings.syncServerToken || "",
    };
  }

  /**
   * 同步时间显示：当天只给时分，跨天补月日。
   * 面板信息已经很长，不再加年份。
   * @param {number} ms 毫秒时间戳
   * @returns {string}
   */
  function formatSyncTime(ms) {
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return "-";
    const pad = (n) => String(n).padStart(2, "0");
    const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const now = new Date();
    const sameDay =
      d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    return sameDay ? hm : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`;
  }

  async function refreshSyncStatusLine() {
    const el = $("syncStatusLine");
    if (!el) return;
    try {
      // 状态可能由 background 或别的标签页写入；先同步一次存储再渲染，
      // 避免打开设置时把 need_setup 显示成 idle（进而隐藏「解决冲突」）。
      const st = await reloadSyncState();
      const deviceId = await getOrCreateDeviceId();
      const bytes =
        st.bytesEstimate || estimateSyncProjectionBytes(getData(), { deviceId, docId: st.docId || "doc_ui" });
      const level = st.budgetLevel || syncBytesBudgetLevel(bytes);
      const kb = bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
      const budgetKey =
        level === "red"
          ? "settings.sync.budget.red"
          : level === "yellow"
            ? "settings.sync.budget.yellow"
            : "settings.sync.budget.green";
      const statusKey =
        st.status === "syncing"
          ? "settings.sync.state.syncing"
          : st.status === "quota"
            ? "settings.sync.state.quota"
            : st.status === "device_retired"
              ? "settings.sync.state.deviceRetired"
              : st.status === "error"
                ? "settings.sync.state.error"
                : st.status === "need_setup"
                  ? "settings.sync.state.conflict"
                  : getData().settings.syncEnabled
                    ? "settings.sync.state.idle"
                    : "settings.sync.state.off";
      const err = st.lastError ? ` · ${st.lastError}` : "";
      const via = t("settings.sync.transport.http");
      const intervalKey = normalizeSyncInterval(getData().settings?.syncInterval);
      const intervalLabel = getData().settings?.syncEnabled
        ? ` · ${t("settings.sync.interval")}: ${t(`settings.sync.interval.${intervalKey}`)}`
        : "";
      // 没有这一项时，用户点完「立即同步」只能靠猜——面板必须给出最近一次成功同步的时间。
      const lastAt = Math.max(Number(st.lastPullAt) || 0, Number(st.lastPushAt) || 0);
      const lastLabel = ` · ${
        lastAt > 0 ? t("settings.sync.lastSync", { time: formatSyncTime(lastAt) }) : t("settings.sync.lastSync.none")
      }`;
      el.textContent = `${t(statusKey)} · ${via}${intervalLabel}${lastLabel} · ${t("settings.sync.size", { size: kb })} · ${t(budgetKey)}${err}`;
      el.dataset.level =
        st.status === "error" || st.status === "quota" || st.status === "need_setup" || st.status === "device_retired"
          ? "red"
          : level;
      const resolveBtn = $("btnSyncResolveConflict");
      if (resolveBtn) {
        resolveBtn.classList.toggle("hidden", !(st.hasConflict || st.status === "need_setup"));
      }
    } catch (e) {
      console.warn("refreshSyncStatusLine failed", e);
      el.textContent = "";
    }
  }

  /** 设备 ID 缩写：dev_1a2b3c… 只显示前 10 位，便于肉眼比对 */
  function shortDeviceId(id) {
    const s = String(id || "");
    return s.length <= 10 ? s : `${s.slice(0, 10)}…`;
  }

  /**
   * 渲染协同设备清单（纯 DOM 构建，设备名等来自服务端，不走 innerHTML）。
   * @param {HTMLElement} listEl 容器
   * @param {Array<{deviceId:string,deviceName?:string,lastSeenAt?:number,retiredAt?:number}>} devices
   * @param {string} localDeviceId 本机 deviceId
   */
  function renderSyncDevicesList(listEl, devices, localDeviceId) {
    listEl.replaceChildren();
    if (!devices.length) {
      const empty = document.createElement("p");
      empty.className = "settings-sync-hint";
      empty.textContent = t("settings.sync.devices.empty");
      listEl.appendChild(empty);
      return;
    }
    for (const device of devices) {
      const retired = Number(device.retiredAt) > 0;
      const row = document.createElement("div");
      row.className = "row-inline settings-sync-device-row";
      row.dataset.deviceId = String(device.deviceId || "");
      // 状态指示灯：绿 = 正常，灰 = 已退役
      const dot = document.createElement("span");
      dot.className = `settings-sync-dot ${retired ? "is-retired" : "is-active"}`;
      dot.title = retired ? t("settings.sync.devices.retired") : t("settings.sync.devices.active");
      const name = document.createElement("span");
      name.className = "settings-sync-device-name";
      name.textContent = device.deviceName || t("settings.sync.devices.unknownName");
      const idShort = document.createElement("span");
      idShort.className = "settings-sync-device-id";
      idShort.textContent = shortDeviceId(device.deviceId);
      const seen = document.createElement("span");
      seen.className = "settings-sync-device-seen";
      seen.textContent = t("settings.sync.devices.lastSeen", {
        time: formatSyncTime(Number(device.lastSeenAt) || 0),
      });
      row.append(dot, name, idShort, seen);
      if (device.deviceId === localDeviceId) {
        const mine = document.createElement("span");
        mine.className = "settings-sync-device-mine";
        mine.textContent = t("settings.sync.devices.thisDevice");
        row.appendChild(mine);
      }
      if (retired) {
        const tag = document.createElement("span");
        tag.className = "settings-sync-device-retired";
        tag.textContent = t("settings.sync.devices.retired");
        row.appendChild(tag);
      }
      if (device.deviceId !== localDeviceId) {
        // 退役设备提供「恢复激活」，正常设备提供「注销」；本机自身不提供这两个入口
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "icon-btn settings-sync-device-retire-btn";
        btn.textContent = retired ? t("settings.sync.devices.reactivate") : t("settings.sync.devices.retire");
        btn.addEventListener("click", () => void setSyncDeviceRetired(device, btn, !retired));
        row.appendChild(btn);
      }
      listEl.appendChild(row);
    }
  }

  /** 注销 / 恢复一台协同设备：确认后调用管理接口，成功后刷新清单 */
  async function setSyncDeviceRetired(device, btn, retired) {
    const name = device.deviceName || t("settings.sync.devices.unknownName");
    const confirmKey = retired ? "settings.sync.devices.retireConfirm" : "settings.sync.devices.reactivateConfirm";
    if (!confirm(t(confirmKey, { name }))) return;
    const busyKey = retired ? "settings.sync.devices.retiring" : "settings.sync.devices.reactivating";
    await runWithButtonState(btn, t(busyKey), async () => {
      try {
        const cfg = applySyncSettingsFromForm();
        const res = await httpRetireDevice(cfg, { deviceId: device.deviceId, retired });
        if (!res.ok) {
          toast(
            t("settings.sync.devices.retireFail", {
              reason:
                res.reason === "unauthorized" ? t("settings.sync.unauthorized") : res.reason || res.error || "error",
            }),
            "error",
          );
          return;
        }
        toast(t(retired ? "settings.sync.devices.retireOk" : "settings.sync.devices.reactivateOk"));
        await refreshSyncDevices();
      } catch (e) {
        toast(t("settings.sync.devices.retireFail", { reason: e?.message || "error" }), "error");
      }
    }).catch((e) => {
      console.warn("setSyncDeviceRetired failed", e);
      toast(t("settings.sync.devices.retireFail", { reason: e?.message || "error" }), "error");
    });
  }

  /**
   * 拉取并渲染协同设备与健康度仪表盘。
   * 设备清单来自 /v1/sync/devices，墓碑计数来自 /health，两者并行请求。
   */
  async function refreshSyncDevices() {
    const listEl = $("syncDevicesList");
    const healthEl = $("syncDevicesHealth");
    if (!listEl || !healthEl) return;
    const cfg = applySyncSettingsFromForm();
    if (!cfg.url) {
      healthEl.textContent = "";
      listEl.replaceChildren();
      listEl.dataset.state = "empty";
      return;
    }
    const localDeviceId = await getOrCreateDeviceId().catch(() => "");
    listEl.dataset.state = "loading";
    healthEl.textContent = t("settings.sync.devices.loading");
    const [devicesRes, healthRes] = await Promise.all([httpGetDevices(cfg), httpHealth(cfg).catch(() => null)]);
    if (!devicesRes.ok) {
      listEl.dataset.state = "error";
      healthEl.textContent =
        devicesRes.reason === "unauthorized"
          ? t("settings.sync.unauthorized")
          : t("settings.sync.devices.loadFail", {
              reason: devicesRes.error || devicesRes.reason || `HTTP ${devicesRes.status ?? ""}`,
            });
      listEl.replaceChildren();
      return;
    }
    listEl.dataset.state = "ready";
    const devices = devicesRes.devices || [];
    const activeCount = devices.filter((d) => !(Number(d.retiredAt) > 0)).length;
    const tombstoneCount = Number(healthRes?.body?.tombstoneCount);
    healthEl.textContent = t("settings.sync.devices.health", {
      revision: devicesRes.revision,
      epoch: devicesRes.epoch,
      active: activeCount,
      total: devices.length,
      tombs: Number.isFinite(tombstoneCount) ? tombstoneCount : "-",
      reclaim: devicesRes.reclaimCandidates?.length ?? "-",
    });
    renderSyncDevicesList(listEl, devices, localDeviceId);
  }

  function openSettingsModal() {
    state.settingsOpen = true;
    const modalHtml = html`
      <div class="section settings-actions">
        <button id="btnExport" class="icon-btn">${t("settings.action.export")}</button>
        <button id="btnImport" class="icon-btn">${t("settings.action.import")}</button>
        <button id="btnImportUrl" class="icon-btn">${t("settings.action.importUrl")}</button>
        <button id="btnBackupManage" class="icon-btn">${t("settings.action.backup")}</button>
        <button id="btnExportBookmarksHtml" class="icon-btn">${t("settings.bookmarks.exportHtml")}</button>
        <button id="btnImportBookmarksHtml" class="icon-btn">${t("settings.bookmarks.importHtml")}</button>
        <button id="btnClearData" class="icon-btn danger strong-label">${t("settings.action.clearData")}</button>
        <button id="btnClearCards" class="icon-btn danger">${t("settings.action.clearCards")}</button>
        <button id="btnRefreshIcons" class="icon-btn">${t("settings.action.refreshIcons")}</button>
      </div>
      <div class="section settings-language-row">
        <div class="row-inline settings-language-wrap">
          <span class="settings-language-hint">中/臺/EN/JP/KR/DE/FR/ES</span>
          <select id="settingLanguage" class="inline-select settings-language-select">${rawHtml(buildLanguageOptions(getData().settings.language))}</select>
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
              SYNC_INTERVAL_OPTIONS.map(
                (o) =>
                  `<option value="${escapeHtml(o.value)}">${escapeHtml(t(`settings.sync.interval.${o.value}`))}</option>`,
              ).join(""),
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
      </div>

    `;
    openModal(modalHtml);

    $("settingShowSearch").checked = getData().settings.showSearch;
    $("settingSearchEngine").value = getData().settings.searchEngineUrl;
    const presets = {
      "https://www.google.com/search?q=": "https://www.google.com/search?q=",
      "https://www.baidu.com/s?wd=": "https://www.baidu.com/s?wd=",
      "https://www.bing.com/search?q=": "https://www.bing.com/search?q=",
      "https://www.so.com/s?q=": "https://www.so.com/s?q=",
      "https://www.yandex.com/search/?text=": "https://www.yandex.com/search/?text=",
    };
    const presetValue = presets[getData().settings.searchEngineUrl] || "custom";
    $("settingSearchEnginePreset").value = presetValue;
    $("settingSearchEngine").disabled = presetValue !== "custom";
    $("settingFixedLayout").checked = getData().settings.fixedLayout;
    $("settingCols").value = getData().settings.fixedCols;
    const densityRadios = qsa("input[name='density']", elements.modal);
    densityRadios.forEach((radio) => {
      radio.checked = radio.value === getData().settings.gridDensity;
    });
    $("settingBgType").value = getData().settings.backgroundType;
    $("settingBgColor").value = getData().settings.backgroundColor;
    $("settingBgGradient").value = getData().settings.backgroundGradient;
    // 形如 "linear-gradient(120deg, #aaa, #bbb)"，跳过角度，直接取两个颜色
    const match = /linear-gradient\([^,]+,\s*([^,]+),\s*([^)]+)\)/.exec(getData().settings.backgroundGradient || "");
    const gA = getData().settings.backgroundGradientA || match?.[1]?.trim() || "#1d2a3b";
    const gB = getData().settings.backgroundGradientB || match?.[2]?.trim() || "#0b0f14";
    $("settingBgGradientA").value = gA;
    $("settingBgGradientB").value = gB;
    $("settingBgOverlay").value = Number(getData().settings.backgroundOverlayStrength ?? 0.08);
    $("settingBgOverlayValue").textContent = `${Math.round(Number($("settingBgOverlay").value) * 100)}%`;
    $("settingTooltip").checked = getData().settings.tooltipEnabled;
    $("settingKeyboard").checked = getData().settings.keyboardNav;
    $("settingTheme").value = getData().settings.theme || "system";
    $("settingFontSize").value = getData().settings.fontSize || 13;
    $("settingToastDuration").value = Math.min(
      60,
      Math.max(1, Number(getData().settings.toastDuration) || DEFAULT_TOAST_DURATION_SECONDS),
    );
    $("settingLanguage").value = currentLang();
    $("settingSync").checked = getData().settings.syncEnabled;
    getData().settings.syncTransport = "http";
    const intervalSel = $("settingSyncInterval");
    if (intervalSel) intervalSel.value = normalizeSyncInterval(getData().settings.syncInterval);
    const urlInput = $("settingSyncServerUrl");
    if (urlInput) urlInput.value = getData().settings.syncServerUrl || "";
    const tokenInput = $("settingSyncServerToken");
    if (tokenInput) tokenInput.value = getData().settings.syncServerToken || "";
    $("btnSyncTestServer")?.addEventListener("click", async () => {
      const btn = $("btnSyncTestServer");
      await runWithButtonState(btn, t("settings.sync.testing"), async () => {
        const cfg = applySyncSettingsFromForm();
        const baseUrl = cfg.url;
        const token = cfg.token;
        if (!baseUrl) {
          toast(t("settings.sync.testFail", { reason: "no_url" }), "error");
          return;
        }
        // 先 health（可达性 + 是否需要鉴权），再 pull state（404 表示空库也算鉴权通过）
        const health = await httpHealth({ baseUrl, token });
        if (!health.ok && health.reason === "network_error") {
          toast(
            t("settings.sync.testFail", {
              reason: `network_error · ${health.error || "服务未启动？"}`,
            }),
            "error",
          );
          return;
        }
        const pull = await httpPullState({ baseUrl, token });
        if (pull.reason === "unauthorized") {
          const need = health?.body?.authRequired === true;
          toast(
            need || !token
              ? t("settings.sync.unauthorized")
              : t("settings.sync.testFail", { reason: "unauthorized · Token 不正确" }),
            "error",
          );
          return;
        }
        if (pull.ok || pull.reason === "no_remote") {
          toast(t("settings.sync.testOk"));
          // 鉴权通过即尝试自动配对设备独立凭据（已配对/开放模式为空操作），
          // 随后刷新协同设备仪表盘——新配对的设备会立刻出现在列表里
          if (ensureDevicePairing) await ensureDevicePairing();
          void refreshSyncDevices();
          return;
        }
        const detail = [pull.reason, pull.error, pull.status != null ? `HTTP ${pull.status}` : ""]
          .filter(Boolean)
          .join(" · ");
        toast(t("settings.sync.testFail", { reason: detail || health.reason || "error" }), "error");
      }).catch((e) => {
        console.warn("sync server test failed", e);
        toast(t("settings.sync.testFail", { reason: e?.message || "error" }), "error");
      });
    });
    void refreshSyncStatusLine();
    $("btnSyncRefreshDevices")?.addEventListener("click", () => void refreshSyncDevices());
    $("btnSyncNow")?.addEventListener("click", async () => {
      const btn = $("btnSyncNow");
      const originalLabel = btn?.textContent || t("settings.sync.now");
      if (btn) {
        btn.disabled = true;
        btn.setAttribute("aria-busy", "true");
        btn.textContent = t("settings.sync.state.syncing");
      }
      toast(t("settings.sync.state.syncing"));
      try {
        // 立即同步前先把表单里的同步配置写入 getData()（避免只改了 UI 未保存）
        const prevEnabled = !!getData().settings.syncEnabled;
        const prevUrl = getData().settings.syncServerUrl || "";
        const prevToken = getData().settings.syncServerToken || "";
        const cfg = applySyncSettingsFromForm();
        if (!cfg.enabled) {
          toast(t("settings.sync.state.off"), "warning");
          void refreshSyncStatusLine();
          return;
        }
        if (!cfg.url) {
          toast(t("settings.sync.testFail", { reason: "no_url" }), "error");
          void refreshSyncStatusLine();
          return;
        }
        // 落盘配置（仅 local），再触发同步
        await persistData();
        // persistData 的变更防抖与下面的手动 pull + push 是同一次操作，只保留后者。
        cancelScheduledPush();
        // 间隔可能刚在表单里改过
        refreshSyncInterval();
        const serverChanged = prevUrl !== cfg.url || prevToken !== cfg.token || prevEnabled !== cfg.enabled;
        if (serverChanged) {
          await onSyncEnabledChanged(true);
          const st = getSyncStatus();
          if (String(st.lastError || "").includes("unauthorized")) toast(t("settings.sync.unauthorized"), "error");
          else if (st.status === "error" && st.lastError)
            toast(t("settings.sync.testFail", { reason: st.lastError }), "error");
          else if (st.status === "quota") toast(t("settings.sync.state.quota"), "warning");
          else toast(t("settings.sync.nowOk"));
        } else {
          const pull = await pullNow("manual");
          if (pull?.reason === "doc_conflict") {
            openSyncConflictModal();
            void refreshSyncStatusLine();
            return;
          }
          if (pull?.reason === "unauthorized") {
            toast(t("settings.sync.unauthorized"), "error");
            void refreshSyncStatusLine();
            return;
          }
          if (pull?.reason === "network_error" || pull?.reason === "no_url") {
            toast(
              t("settings.sync.testFail", {
                reason: (pull.reason || "") + (pull.error ? ` · ${pull.error}` : ""),
              }),
              "error",
            );
            void refreshSyncStatusLine();
            return;
          }
          const res = await pushNow("manual");
          if (res?.reason === "doc_conflict") {
            openSyncConflictModal();
          } else if (res?.reason === "sync_quota_total") toast(t("settings.sync.state.quota"), "warning");
          else if (res?.reason === "unauthorized") {
            toast(t("settings.sync.unauthorized"), "error");
          } else if (res?.reason === "network_error" || res?.reason === "no_url") {
            const r = res?.reason || "error";
            const err = res?.error || "";
            toast(t("settings.sync.testFail", { reason: err ? `${r} · ${err}` : r }), "error");
          } else if (res && res.ok === false) {
            toast(t("settings.sync.importFail", { reason: res.reason || "push" }), "error");
          } else toast(t("settings.sync.nowOk"));
        }
        void refreshSyncStatusLine();
        render();
        // 同步成功后刷新协同设备清单（lastSeenAt / 确认进度会有变化）
        void refreshSyncDevices();
      } catch (e) {
        toast(t("settings.sync.importFail", { reason: e?.message || "sync" }), "error");
      } finally {
        const live = $("btnSyncNow");
        if (live) {
          live.disabled = false;
          live.removeAttribute("aria-busy");
          live.textContent = originalLabel;
        }
      }
    });
    $("btnSyncResolveConflict")?.addEventListener("click", () => openSyncConflictModal());
    $("settingOpenMode").value = getData().settings.openMode || "current";
    $("settingBackup").value = getData().settings.maxBackups;
    const retryHour = getData().settings.iconRetryHour ?? (getData().settings.iconRetryAtSix ? 18 : "");
    $("settingIconRetryHour").value = retryHour === "" ? "" : String(retryHour);
    $("settingSidebarCollapsed").checked = getData().settings.sidebarHidden;
    $("settingSidebarCollapsed").addEventListener("change", (e) => {
      getData().settings.sidebarHidden = e.target.checked;
      applySidebarState();
    });

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
    const useFixed = getData().settings.defaultGroupMode === "fixed" && getData().settings.defaultGroupId;
    defaultGroupId.value = useFixed ? getData().settings.defaultGroupId : "";

    $("settingSearchEnginePreset").addEventListener("change", (e) => {
      const val = e.target.value;
      if (val === "custom") {
        $("settingSearchEngine").disabled = false;
        $("settingSearchEngine").focus();
      } else {
        $("settingSearchEngine").value = val;
        $("settingSearchEngine").disabled = true;
      }
    });
    $("settingLanguage").addEventListener("change", async () => {
      getData().settings.language = normalizeLanguage($("settingLanguage").value) || detectPreferredLanguage();
      applyStaticI18n();
      render();
      await persistData();
      if (state.settingsOpen) openSettingsModal();
    });

    ieCtl.bindButtons();

    $("btnClearData").addEventListener("click", async () => {
      if (!confirm(t("confirm.clearData"))) return;
      await runWithButtonState($("btnClearData"), t("settings.action.clearing"), async () => {
        const previous = getData();
        const prevActiveGroupId = _ctx.getActiveGroupId?.();
        const keepLanguage = currentLang();
        // 必须在重置前记下是否开过同步，否则 defaultData 会把 syncEnabled 置 false，云端清不掉
        const prevSync = !!getData()?.settings?.syncEnabled;
        try {
          await clearData(false);
          if (prevSync) await clearData(true);
          setData(defaultData());
          getData().settings.language = keepLanguage;
          getData().settings.syncEnabled = false;
          setActiveGroupId(getRootGroup().id);
          const res = await persistData();
          if (!res?.ok) throw new Error(res?.err || "写入失败");
          closeModal();
          render();
          toast(t("toast.cleared"));
        } catch (error) {
          setData(previous);
          if (prevActiveGroupId !== undefined) setActiveGroupId?.(prevActiveGroupId);
          _ctx.syncBackupBaseline?.(previous);
          _ctx.deps?.resetSettingsClockBaseline?.(previous);
          _ctx.deps?.resetPlacementClockBaseline?.(previous);
          toast(`清空数据失败：${error?.message || error}`, "error");
        }
      });
    });
    $("btnClearCards").addEventListener("click", async () => {
      if (!confirm(t("confirm.clearCards"))) return;
      await runWithButtonState($("btnClearCards"), t("settings.action.clearing"), async () => {
        const previous = getData();
        const prevActiveGroupId = _ctx.getActiveGroupId?.();
        const cloneFn = _ctx.deps?.cloneDataSnapshot || deepClone;
        try {
          setData(cloneFn(previous));
          pushBackup();
          const preservedSettings = deepClone(getData().settings || {});
          for (const id of Object.keys(getData().nodes || {})) markNodeDeleted(getData(), id);
          getData().nodes = {};
          getData().groups = [{ id: ALL_BOOKMARKS_GROUP_ID, name: "全部", order: -1, nodes: [], systemAllGroup: true }];
          getData().settings = preservedSettings;
          setActiveGroupId(ALL_BOOKMARKS_GROUP_ID);
          const res = await persistData();
          if (!res?.ok) throw new Error(res?.err || "写入失败");
          closeModal();
          render();
          toast(t("toast.cardsCleared"));
        } catch (error) {
          setData(previous);
          if (prevActiveGroupId !== undefined) setActiveGroupId?.(prevActiveGroupId);
          _ctx.syncBackupBaseline?.(previous);
          _ctx.deps?.resetSettingsClockBaseline?.(previous);
          _ctx.deps?.resetPlacementClockBaseline?.(previous);
          toast(`清空卡片失败：${error?.message || error}`, "error");
        }
      });
    });
    $("btnRefreshIcons").addEventListener("click", async () => {
      const btn = $("btnRefreshIcons");
      if (!btn || btn.disabled) return;
      const originalLabel = t("settings.action.refreshIcons");
      btn.disabled = true;
      btn.setAttribute("aria-busy", "true");
      btn.textContent = t("settings.action.refreshingIcons");
      try {
        await refreshAllIcons(Object.values(getData().nodes || {}));
        render();
        toast(t("toast.iconsRefreshed"));
      } catch (e) {
        console.warn("refreshAllIcons failed", e);
        toast(t("toast.iconsRefreshed"), "warning");
      } finally {
        // 设置面板可能仍开着；若按钮还在 DOM 上则恢复文案
        const live = $("btnRefreshIcons");
        if (live) {
          live.disabled = false;
          live.removeAttribute("aria-busy");
          live.textContent = originalLabel;
        }
      }
    });

    const saveSettings = async ({ close = false, toastOnSave = false } = {}) => {
      if (state.settingsSaving) {
        state.settingsSaveQueued = true;
        return;
      }
      // 设置表单不在 DOM（已进入导入/导出等子面板）时不要读 null
      if (!$("settingShowSearch")) {
        return;
      }
      state.settingsSaving = true;
      try {
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

        getData().settings.showSearch = $("settingShowSearch").checked;
        getData().settings.enableSearchEngine = true;
        {
          const engineInput = $("settingSearchEngine").value.trim();
          if (engineInput) {
            const normalizedEngine = normalizeUrl(engineInput);
            getData().settings.searchEngineUrl = normalizedEngine || getData().settings.searchEngineUrl;
          }
        }
        getData().settings.fixedLayout = $("settingFixedLayout").checked;
        getData().settings.fixedCols = Number($("settingCols").value) || 8;
        const selectedDensity = qsa("input[name='density']", elements.modal).find((r) => r.checked);
        getData().settings.gridDensity = selectedDensity ? selectedDensity.value : getData().settings.gridDensity;
        getData().settings.backgroundType = $("settingBgType").value;
        getData().settings.backgroundColor = $("settingBgColor").value;
        const gA = $("settingBgGradientA").value || "#1d2a3b";
        const gB = $("settingBgGradientB").value || "#0b0f14";
        getData().settings.backgroundGradientA = gA;
        getData().settings.backgroundGradientB = gB;
        getData().settings.backgroundGradient = `linear-gradient(120deg, ${gA}, ${gB})`;
        getData().settings.backgroundOverlayStrength = Number($("settingBgOverlay").value);
        getData().settings.tooltipEnabled = $("settingTooltip").checked;
        getData().settings.keyboardNav = $("settingKeyboard").checked;
        getData().settings.fontSize = Number($("settingFontSize").value) || getData().settings.fontSize;
        getData().settings.toastDuration = Math.min(
          60,
          Math.max(1, Math.round(Number($("settingToastDuration").value) || DEFAULT_TOAST_DURATION_SECONDS)),
        );
        getData().settings.theme = $("settingTheme").value;
        getData().settings.language = normalizeLanguage($("settingLanguage").value) || detectPreferredLanguage();
        const selectedDefaultGroupId = $("settingDefaultGroupId").value;
        getData().settings.defaultGroupMode = selectedDefaultGroupId ? "fixed" : "last";
        getData().settings.defaultGroupId = selectedDefaultGroupId;
        getData().settings.sidebarHidden = $("settingSidebarCollapsed").checked;
        const prevSyncEnabled = !!getData().settings.syncEnabled;
        const prevUrl = getData().settings.syncServerUrl || "";
        const prevToken = getData().settings.syncServerToken || "";
        const prevInterval = normalizeSyncInterval(getData().settings.syncInterval);
        getData().settings.syncEnabled = $("settingSync").checked;
        getData().settings.syncTransport = "http";
        getData().settings.syncInterval = normalizeSyncInterval($("settingSyncInterval")?.value);
        getData().settings.syncServerUrl = ($("settingSyncServerUrl")?.value || "").trim();
        getData().settings.syncServerToken = ($("settingSyncServerToken")?.value || "").trim();
        const serverChanged =
          prevUrl !== getData().settings.syncServerUrl || prevToken !== getData().settings.syncServerToken;
        const intervalChanged = prevInterval !== getData().settings.syncInterval;
        const connectionChanged =
          prevSyncEnabled !== getData().settings.syncEnabled || (getData().settings.syncEnabled && serverChanged);
        getData().settings.openMode = $("settingOpenMode").value || "current";
        const nextMaxBackups = Number($("settingBackup").value) || 0;
        if (nextMaxBackups > 0 && getData().backups.length > nextMaxBackups) {
          getData().backups = getData().backups.slice(0, nextMaxBackups);
        }
        getData().settings.maxBackups = nextMaxBackups;
        const retryVal = $("settingIconRetryHour").value;
        if (retryVal === "") {
          getData().settings.iconRetryHour = "";
          getData().settings.iconRetryAtSix = false;
        } else {
          getData().settings.iconRetryHour = Number(retryVal);
          getData().settings.iconRetryAtSix = Number(retryVal) === 18;
        }

        const bgFile = $("settingBgFile").files?.[0];
        if (bgFile) {
          getData().settings.backgroundCustom = await readFileAsDataUrl(bgFile);
        }

        applyDensity();
        applyTheme();
        applyStaticI18n();
        await persistData();
        if (connectionChanged) {
          // persistData 会为本地写入安排防抖 push；首次同步已自行 pull + push，避免重复写远端。
          cancelScheduledPush();
          await onSyncEnabledChanged(getData().settings.syncEnabled);
        } else if (getData().settings.syncEnabled && intervalChanged) {
          refreshSyncInterval();
        }
        if (intervalChanged || connectionChanged) void refreshSyncStatusLine();
        render();
        loadBackground();
        if (toastOnSave) toast(t("settings.saved"));
        if (close) closeModal();
      } finally {
        state.settingsSaving = false;
      }
      if (state.settingsSaveQueued) {
        state.settingsSaveQueued = false;
        void saveSettings({ close: false, toastOnSave: false });
        return;
      }
    };
    state.settingsSaveNow = saveSettings;

    const scheduleSettingsSave = (immediate = false) => {
      if (state.settingsSaveTimer) clearTimeout(state.settingsSaveTimer);
      if (immediate) {
        saveSettings({ close: false, toastOnSave: false });
        return;
      }
      const delay = immediate ? 0 : SETTINGS_SAVE_DELAY_MS;
      state.settingsSaveTimer = setTimeout(() => {
        state.settingsSaveTimer = null;
        saveSettings({ close: false, toastOnSave: false });
      }, delay);
    };

    const updateBgControls = (triggerSave = true) => {
      const type = $("settingBgType").value;
      $("bgColorWrap").classList.toggle("hidden", type !== "color");
      $("bgGradientWrap").classList.toggle("hidden", type !== "gradient");
      const bgFile = $("settingBgFile");
      bgFile.classList.toggle("hidden", type !== "custom");
      bgFile.disabled = type !== "custom";
      if (triggerSave) scheduleSettingsSave(true);
    };
    $("settingBgType").addEventListener("change", () => updateBgControls(true));
    updateBgControls(false);

    qsa("input, select, textarea", elements.modal).forEach((el) => {
      const type = el.getAttribute("type") || "";
      const eventName = type === "checkbox" || el.tagName === "SELECT" ? "change" : "input";
      el.addEventListener(eventName, () => scheduleSettingsSave(false));
    });
    $("settingBgFile").addEventListener("change", () => scheduleSettingsSave(true));
    $("settingBgOverlay").addEventListener("input", () => {
      $("settingBgOverlayValue").textContent = `${Math.round(Number($("settingBgOverlay").value) * 100)}%`;
    });
    const version = getAppVersion();
    $("settingsVersion").textContent = version || "";
  }

  /** 由 app.js 注入依赖；只允许注入一次。 */
  function configureSettingsController(ctx) {
    _ctx = ctx || {};
    const all = { ...(_ctx.ui || {}), ...(_ctx.deps || {}) };
    getData = _ctx.getData;
    setData = _ctx.setData;
    setActiveGroupId = _ctx.setActiveGroupId;
    state = _ctx.state;
    ieCtl = createImportExport(_ctx, refreshSyncStatusLine);
    $ = all.$;
    qsa = all.qsa;
    html = all.html;
    rawHtml = all.rawHtml;
    escapeHtml = all.escapeHtml;
    t = all.t;
    currentLang = all.currentLang;
    toast = all.toast;
    elements = all.elements;
    openModal = all.openModal;
    closeModal = all.closeModal;
    runWithButtonState = all.runWithButtonState;
    render = all.render;
    persistData = all.persistData;
    pushBackup = all.pushBackup;
    processPendingIconFetches = all.processPendingIconFetches;
    loadBackground = all.loadBackground;
    applyDensity = all.applyDensity;
    applyTheme = all.applyTheme;
    applyStaticI18n = all.applyStaticI18n;
    applySidebarState = all.applySidebarState;
    normalizeUrl = all.normalizeUrl;
    normalizeLanguage = all.normalizeLanguage;
    normalizeSyncInterval = all.normalizeSyncInterval;
    detectPreferredLanguage = all.detectPreferredLanguage;
    getAppVersion = all.getAppVersion;
    syncBytesBudgetLevel = all.syncBytesBudgetLevel;
    estimateSyncProjectionBytes = all.estimateSyncProjectionBytes;
    getOrCreateDeviceId = all.getOrCreateDeviceId;
    getSyncStatus = all.getSyncStatus;
    getPendingConflict = all.getPendingConflict;
    reloadSyncState = all.reloadSyncState;
    resolveDocConflict = all.resolveDocConflict;
    pullNow = all.pullNow;
    pushNow = all.pushNow;
    onSyncEnabledChanged = all.onSyncEnabledChanged;
    refreshSyncInterval = all.refreshSyncInterval;
    cancelScheduledPush = all.cancelScheduledPush;
    httpHealth = all.httpHealth;
    httpPullState = all.httpPullState;
    httpGetDevices = all.httpGetDevices;
    httpRetireDevice = all.httpRetireDevice;
    ensureDevicePairing = all.ensureDevicePairing;
    readFileAsDataUrl = all.readFileAsDataUrl;
    buildLanguageOptions = all.buildLanguageOptions;
    clearData = all.clearData;
    defaultData = all.defaultData;
    deepClone = all.deepClone;
    markNodeDeleted = all.markNodeDeleted;
    stampNodeFieldChanges = all.stampNodeFieldChanges;
    getRootGroup = all.getRootGroup;
    getRootContainers = all.getRootContainers;
    getRootContainerById = all.getRootContainerById;
    isAllBookmarksGroup = all.isAllBookmarksGroup;
    refreshAllIcons = all.refreshAllIcons;
    ALL_BOOKMARKS_GROUP_ID = all.ALL_BOOKMARKS_GROUP_ID;
    SYNC_INTERVAL_OPTIONS = all.SYNC_INTERVAL_OPTIONS;
    DEFAULT_TOAST_DURATION_SECONDS = all.DEFAULT_TOAST_DURATION_SECONDS;
    SETTINGS_SAVE_DELAY_MS = all.SETTINGS_SAVE_DELAY_MS;
  }

  /**
   * 供 app.js 在启动时创建控制器。返回值里只暴露需要从外部调用的入口，
   * 避免外部直接操作模块内部函数。
   */
  function createSettingsController(ctx) {
    configureSettingsController(ctx);
    return {
      openSettingsModal,
      refreshSyncStatusLine,
      applySyncSettingsFromForm,
      openSyncConflictModal,
      // 导入导出代理（实际逻辑在 import-export.js）
      exportJsonToClipboard: ieCtl.exportJsonToClipboard,
      openImportModal: ieCtl.openImportModal,
      openImportUrlModal: ieCtl.openImportUrlModal,
      openBackupModal: ieCtl.openBackupModal,
      downloadJsonFile: ieCtl.downloadJsonFile,
      // 弹窗关闭 / 离开设置子面板时需要把 debounce 中的设置立即落盘
      get saveNow() {
        return state?.settingsSaveNow || null;
      },
    };
  }

  return { createSettingsController, configureSettingsController };
})();

// ESM 构建（Chrome/Safari）从这里取；Firefox 拼接时会剥掉 export，改用上面的全局变量。
export const createSettingsController = HomepageSettingsController.createSettingsController;
export const configureSettingsController = HomepageSettingsController.configureSettingsController;
