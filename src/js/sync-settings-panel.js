/**
 * 设置面板中的同步状态、服务器测试、冲突处理与协同设备仪表盘（从 settings-controller.js 拆出）。
 *
 * 用 IIFE 包裹：Firefox 版把所有模块拼成一个经典脚本，
 * 顶层 const/let 会和其它模块重名。IIFE 保证只暴露一个全局名。
 */
var HomepageSyncSettingsPanel = (() => {
  function createSyncSettingsPanel(ctx) {
    const { getData } = ctx || {};
    const {
      $,
      html,
      t,
      toast,
      openModal,
      closeModal,
      runWithButtonState,
      render,
      persistData,
      processPendingIconFetches,
      normalizeSyncInterval,
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
    } = { ...(ctx?.ui || {}), ...(ctx?.deps || {}) };

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

    function bindButtons() {
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
          await persistData();
          cancelScheduledPush();
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
    }

    return {
      openSyncConflictModal,
      applySyncSettingsFromForm,
      refreshSyncStatusLine,
      refreshSyncDevices,
      bindButtons,
    };
  }

  return { createSyncSettingsPanel };
})();

// ESM 构建（Chrome/Safari）从这里取；Firefox 拼接时会剥掉 export，改用上面的全局变量。
export const createSyncSettingsPanel = HomepageSyncSettingsPanel.createSyncSettingsPanel;
