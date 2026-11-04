/**
 * 设置状态与保存协调器（settings-state-coordinator）。
 * 内聚设置面板打开状态、防抖保存定时器、保存互斥锁与子面板跳转/弹窗关闭时的冲刷（flush）逻辑。
 */

/**
 * 创建设置状态与保存协调器实例。
 *
 * @returns {Object} 状态管理与冲刷接口
 */
export function createSettingsStateCoordinator() {
  let settingsOpen = false;
  let settingsSaving = false;
  let settingsSaveTimer = null;
  let settingsSaveQueued = false;

  const state = {
    get settingsOpen() {
      return settingsOpen;
    },
    set settingsOpen(val) {
      settingsOpen = !!val;
    },
    get settingsSaving() {
      return settingsSaving;
    },
    set settingsSaving(val) {
      settingsSaving = !!val;
    },
    get settingsSaveTimer() {
      return settingsSaveTimer;
    },
    set settingsSaveTimer(val) {
      settingsSaveTimer = val;
    },
    get settingsSaveQueued() {
      return settingsSaveQueued;
    },
    set settingsSaveQueued(val) {
      settingsSaveQueued = !!val;
    },
    settingsSaveNow: null,
  };

  function clearTimer() {
    if (settingsSaveTimer) {
      clearTimeout(settingsSaveTimer);
      settingsSaveTimer = null;
    }
  }

  /**
   * 离开设置主表单进入子面板前：刷掉 debounce 中的保存，避免改动丢失。
   *
   * @param {function(): { saveNow?: function(): Promise<any> }} getSettingsCtl 获取设置控制器方法
   */
  async function leaveSettingsForSubpanel(getSettingsCtl) {
    clearTimer();
    const ctl = typeof getSettingsCtl === "function" ? getSettingsCtl() : null;
    const pending = ctl?.saveNow;
    if (typeof pending === "function" && !settingsSaving) {
      try {
        await pending();
      } catch (e) {
        console.warn("leaveSettingsForSubpanel flush failed", e);
      }
    }
    settingsOpen = false;
  }

  /**
   * 模态弹窗关闭时的冲刷：清除定时器、执行未结保存、重置状态并唤醒挂起的存储监听重载。
   *
   * @param {Object} options
   * @param {function(): { saveNow?: function(): Promise<any> }} [options.getSettingsCtl]
   * @param {Object} [options.storageListener]
   * @param {Object} [options.appEventsBinder]
   */
  async function flushPendingSettingsSave({ getSettingsCtl, storageListener, appEventsBinder } = {}) {
    clearTimer();
    const ctl = typeof getSettingsCtl === "function" ? getSettingsCtl() : null;
    const pendingSave = ctl?.saveNow;
    if (settingsOpen && typeof pendingSave === "function" && !settingsSaving) {
      try {
        await pendingSave();
      } catch (e) {
        console.warn("flush settings on closeModal failed", e);
      }
    }
    appEventsBinder?.resetModalPointerOrigin?.();
    settingsOpen = false;
    settingsSaving = false;
    settingsSaveQueued = false;
    storageListener?.flushPendingReload?.();
  }

  return {
    state,
    isSettingsOpen: () => settingsOpen,
    setSettingsOpen: (val) => {
      settingsOpen = !!val;
    },
    isSettingsSaving: () => settingsSaving,
    setSettingsSaving: (val) => {
      settingsSaving = !!val;
    },
    getSettingsSaveTimer: () => settingsSaveTimer,
    setSettingsSaveTimer: (val) => {
      settingsSaveTimer = val;
    },
    clearTimer,
    isSettingsSaveQueued: () => settingsSaveQueued,
    setSettingsSaveQueued: (val) => {
      settingsSaveQueued = !!val;
    },
    leaveSettingsForSubpanel,
    flushPendingSettingsSave,
  };
}
