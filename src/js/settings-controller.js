/**
 * 设置面板控制器（从 app.js 拆出）。
 *
 * 将依赖完全收敛在 createSettingsController 闭包内，消除模块级可变状态与多实例串扰。
 * 用 IIFE 包裹：Firefox 拼接经典脚本时不污染全局作用域。
 */
import { createImportExport } from "./import-export.js";
import { applySettingsFormToData, buildSettingsModalHtml, hydrateSettingsForm } from "./settings-form-renderer.js";
import { createSyncSettingsPanel } from "./sync-settings-panel.js";

var HomepageSettingsController = (() => {
  function createSettingsController(ctx = {}) {
    const _ctx = ctx || {};
    const all = { ...(_ctx.ui || {}), ...(_ctx.deps || {}) };
    const { getData, setData, setActiveGroupId, state } = _ctx;
    const {
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
      onSyncEnabledChanged,
      refreshSyncInterval,
      cancelScheduledPush,
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
      SETTINGS_SAVE_DELAY_MS,
    } = all;

    const syncPanelCtl = createSyncSettingsPanel(_ctx);
    const ieCtl = createImportExport(_ctx, syncPanelCtl.refreshSyncStatusLine);

    function openSettingsModal() {
      state.settingsOpen = true;
      const modalHtml = buildSettingsModalHtml({
        html,
        rawHtml,
        escapeHtml,
        t,
        buildLanguageOptions,
        language: getData().settings.language,
        syncIntervalOptions: SYNC_INTERVAL_OPTIONS,
      });
      openModal(modalHtml);

      hydrateSettingsForm({
        $,
        qsa,
        elements,
        data: getData(),
        currentLang,
        t,
        normalizeSyncInterval,
        getRootContainers,
        isAllBookmarksGroup,
        defaultToastDurationSeconds: DEFAULT_TOAST_DURATION_SECONDS,
        getAppVersion,
      });

      syncPanelCtl.bindButtons();
      $("settingSidebarCollapsed").addEventListener("change", (e) => {
        getData().settings.sidebarHidden = e.target.checked;
        applySidebarState();
      });

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
            _ctx.deps?.suppressStorage?.();
            await clearData(false);
            if (prevSync) await clearData(true);
            setData(defaultData());
            getData().settings.language = keepLanguage;
            getData().settings.syncEnabled = false;
            setActiveGroupId(getRootGroup().id);
            const res = await persistData();
            if (!res?.ok) throw new Error(res?.err || t("settings.import.writeFailed"));
            closeModal();
            render();
            toast(t("toast.cleared"));
          } catch (error) {
            setData(previous);
            if (prevActiveGroupId !== undefined) setActiveGroupId?.(prevActiveGroupId);
            _ctx.syncBackupBaseline?.(previous);
            _ctx.deps?.resetSettingsClockBaseline?.(previous);
            _ctx.deps?.resetPlacementClockBaseline?.(previous);
            toast(t("settings.clearDataFail", { reason: error?.message || error }), "error");
          } finally {
            _ctx.deps?.suppressStorage?.();
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
            getData().groups = [
              { id: ALL_BOOKMARKS_GROUP_ID, name: "全部", order: -1, nodes: [], systemAllGroup: true },
            ];
            getData().settings = preservedSettings;
            setActiveGroupId(ALL_BOOKMARKS_GROUP_ID);
            const res = await persistData();
            if (!res?.ok) throw new Error(res?.err || t("settings.import.writeFailed"));
            closeModal();
            render();
            toast(t("toast.cardsCleared"));
          } catch (error) {
            setData(previous);
            if (prevActiveGroupId !== undefined) setActiveGroupId?.(prevActiveGroupId);
            _ctx.syncBackupBaseline?.(previous);
            _ctx.deps?.resetSettingsClockBaseline?.(previous);
            _ctx.deps?.resetPlacementClockBaseline?.(previous);
            toast(t("settings.clearCardsFail", { reason: error?.message || error }), "error");
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
          const { intervalChanged, connectionChanged, e2eeChanged } = await applySettingsFormToData({
            $,
            qsa,
            elements,
            data: getData(),
            normalizeUrl,
            normalizeLanguage,
            normalizeSyncInterval,
            detectPreferredLanguage,
            getRootContainerById,
            isAllBookmarksGroup,
            stampNodeFieldChanges,
            defaultToastDurationSeconds: DEFAULT_TOAST_DURATION_SECONDS,
            readFileAsDataUrl,
          });

          applyDensity();
          applyTheme();
          applyStaticI18n();
          await persistData();
          const e2eeSyncTrigger = Boolean(
            getData().settings.syncEnabled &&
              e2eeChanged &&
              (!getData().settings.syncE2eeEnabled || getData().settings.syncE2eePassphrase),
          );
          if (connectionChanged || e2eeSyncTrigger) {
            cancelScheduledPush();
            await onSyncEnabledChanged(getData().settings.syncEnabled);
          } else if (getData().settings.syncEnabled && intervalChanged) {
            refreshSyncInterval();
          }
          if (intervalChanged || connectionChanged || e2eeSyncTrigger) void syncPanelCtl.refreshSyncStatusLine();
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
        }
      };
      state.settingsSaveNow = saveSettings;

      const scheduleSettingsSave = (immediate = false) => {
        if (state.settingsSaveTimer) clearTimeout(state.settingsSaveTimer);
        if (immediate) {
          saveSettings({ close: false, toastOnSave: false });
          return;
        }
        state.settingsSaveTimer = setTimeout(() => {
          state.settingsSaveTimer = null;
          saveSettings({ close: false, toastOnSave: false });
        }, SETTINGS_SAVE_DELAY_MS);
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
    }

    return {
      openSettingsModal,
      refreshSyncStatusLine: syncPanelCtl.refreshSyncStatusLine,
      applySyncSettingsFromForm: syncPanelCtl.applySyncSettingsFromForm,
      openSyncConflictModal: syncPanelCtl.openSyncConflictModal,
      exportJsonToClipboard: ieCtl.exportJsonToClipboard,
      openImportModal: ieCtl.openImportModal,
      openImportUrlModal: ieCtl.openImportUrlModal,
      openBackupModal: ieCtl.openBackupModal,
      downloadJsonFile: ieCtl.downloadJsonFile,
      get saveNow() {
        return state?.settingsSaveNow || null;
      },
    };
  }

  function configureSettingsController(ctx) {
    return createSettingsController(ctx);
  }

  return { createSettingsController, configureSettingsController };
})();

export const createSettingsController = HomepageSettingsController.createSettingsController;
export const configureSettingsController = HomepageSettingsController.configureSettingsController;
