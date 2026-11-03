/**
 * 数据持久化与时钟协调器（从 app.js 拆出，解耦第十一阶段）。
 *
 * 职责：串行化保存链（去重/墓碑清理/时钟打标/落盘/验证/基线同步）、
 * 自动备份（指纹对比 + 基线快照）、手动备份、外部存储抑制时间窗、
 * 设置时钟与放置时钟的基线管理。persistInFlight / suppressStorageUntil
 * 等状态全部内聚，宿主经访问器读取。
 *
 * 用 IIFE 包裹：Firefox 版把所有模块拼成一个经典脚本，
 * 顶层 const/let 会和其它模块重名。IIFE 保证只暴露一个全局名。
 */

import {
  buildBackupFingerprint,
  cloneDataSnapshot,
  dedupeData,
  ensureAllBookmarksGroup,
  pruneSyncTombstones,
} from "./data-utils.js";
import { createBackupSnapshot, deepClone } from "./storage.js";
import { collectPlacementSnapshot, stampChangedPlacementClock } from "./sync_projection.js";
import { stampChangedSyncSettings } from "./sync_settings.js";

var HomepagePersistenceCoordinator = (() => {
  /**
   * @param {{
   *   getData: () => object,
   *   getDeviceId?: () => Promise<string>,
   *   saveData: (data: object, useSync: boolean) => Promise<string|null>,
   *   loadDataFromArea?: (useSync: boolean) => Promise<any>,
   *   schedulePush: () => void,
   *   debugLog?: (event: string, payload?: object) => void,
   *   shouldDebugPersist?: () => boolean,
   *   storageSuppressMs?: number,
   *   backupIgnoredSettingsKeys?: Iterable<string>,
   * }} options
   */
  function createPersistenceCoordinator(options) {
    const getData = options.getData;
    const getDeviceId = options.getDeviceId || (async () => "");
    const saveData = options.saveData;
    const loadDataFromArea = options.loadDataFromArea || (async () => null);
    const schedulePush = options.schedulePush || (() => {});
    const debugLog = options.debugLog || (() => {});
    const shouldDebugPersist = options.shouldDebugPersist || (() => false);
    /** 抑制窗：persist 写盘后的短时间内忽略 storage.onChanged 的自身回声 */
    const storageSuppressMs = Number(options.storageSuppressMs) > 0 ? Number(options.storageSuppressMs) : 350;
    /** buildBackupFingerprint 要求 Set 形态的忽略键集合 */
    const backupIgnoredKeys =
      options.backupIgnoredSettingsKeys instanceof Set
        ? options.backupIgnoredSettingsKeys
        : new Set(options.backupIgnoredSettingsKeys || []);

    // ---- 内聚状态 ----
    let suppressStorageUntil = 0;
    let persistInFlight = 0;
    let backupFingerprint = "";
    /** @type {object|null} 自动备份的基线快照（备份保存的是「变更前」的内容） */
    let backupBaselineSnapshot = null;
    /** 手动 pushBackup 后跳过下一次自动备份（内容未变，避免重复快照） */
    let skipAutoBackupOnce = false;
    /** 串行化 persist，避免多路 fire-and-forget 互相覆盖 */
    let persistChain = Promise.resolve();
    /** @type {object|null} 设置时钟基线（与上次落盘比对，推进差异字段） */
    let settingsClockBaseline = null;
    /** @type {object|null} 放置时钟基线 */
    let placementClockBaseline = null;

    // ---- 状态访问器 ----
    const getSuppressStorageUntil = () => suppressStorageUntil;
    /** 调试用：直接设定抑制窗截止时刻（毫秒时间戳） */
    const setSuppressStorageUntil = (ts) => {
      suppressStorageUntil = Math.max(suppressStorageUntil, Number(ts) || 0);
    };
    const isStorageSuppressed = () => Date.now() < suppressStorageUntil;
    const getPersistInFlight = () => persistInFlight;
    const isPersistInFlight = () => persistInFlight > 0;

    // ---- 备份 ----
    /** 手动压入当前数据快照，截断到 settings.maxBackups，并跳过下一次自动备份 */
    function pushBackup() {
      const data = getData();
      if (!data?.settings?.maxBackups) return false;
      const snapshot = createBackupSnapshot(data);
      data.backups.unshift(snapshot);
      if (data.settings.maxBackups > 0 && data.backups.length > data.settings.maxBackups) {
        data.backups = data.backups.slice(0, data.settings.maxBackups);
      }
      skipAutoBackupOnce = true;
      return true;
    }

    /** 更新备份指纹与基线快照（保存成功 / 外部重载后调用） */
    function syncBackupBaseline(source = getData()) {
      backupFingerprint = buildBackupFingerprint(source, backupIgnoredKeys);
      backupBaselineSnapshot = cloneDataSnapshot(source);
    }

    /**
     * 保存前指纹比对：发生有效变更时把「旧基线」压入 backups（保留变更前内容），
     * 并更新基线。无变更 / 无配额 / 手动备份跳过标记时仅刷新指纹。
     * @returns {boolean} 是否自动生成了备份
     */
    function ensureAutoBackupBeforePersist() {
      const data = getData();
      const currentFingerprint = buildBackupFingerprint(data, backupIgnoredKeys);
      if (!backupFingerprint) {
        backupFingerprint = currentFingerprint;
        backupBaselineSnapshot = cloneDataSnapshot(data);
        skipAutoBackupOnce = false;
        return false;
      }
      if (!data?.settings?.maxBackups) {
        backupFingerprint = currentFingerprint;
        skipAutoBackupOnce = false;
        return false;
      }
      if (skipAutoBackupOnce) {
        skipAutoBackupOnce = false;
        backupFingerprint = currentFingerprint;
        return false;
      }
      if (currentFingerprint === backupFingerprint) return false;
      if (backupBaselineSnapshot) {
        const snapshot = createBackupSnapshot(backupBaselineSnapshot);
        data.backups.unshift(snapshot);
        if (data.settings.maxBackups > 0 && data.backups.length > data.settings.maxBackups) {
          data.backups = data.backups.slice(0, data.settings.maxBackups);
        }
      } else {
        pushBackup();
        skipAutoBackupOnce = false;
      }
      backupFingerprint = currentFingerprint;
      return true;
    }

    // ---- 时钟基线 ----
    function resetSettingsClockBaseline(source = getData()) {
      settingsClockBaseline = deepClone(source?.settings || {});
    }

    function resetPlacementClockBaseline(source = getData()) {
      placementClockBaseline = collectPlacementSnapshot(source);
    }

    /** 与基线比对推进 settings 的字段时钟（失败不阻塞保存） */
    async function stampSettingsClockBeforePersist() {
      try {
        const data = getData();
        if (!data?.settings) return [];
        if (!settingsClockBaseline) {
          resetSettingsClockBaseline(data);
          return [];
        }
        const deviceId = await getDeviceId();
        const changed = stampChangedSyncSettings(data, settingsClockBaseline, { deviceId });
        if (changed.length) {
          debugLog("settings_clock", { changed });
          resetSettingsClockBaseline(data);
        }
        return changed;
      } catch (e) {
        // 设置时钟只服务于跨设备合并，不能阻塞本地保存或新标签页启动。
        console.warn("settings clock skipped", e);
        return [];
      }
    }

    /** 与基线比对推进放置时钟（每次保存后基线整体重建） */
    async function stampPlacementClockBeforePersist() {
      try {
        if (!placementClockBaseline) {
          resetPlacementClockBaseline(getData());
          return [];
        }
        const deviceId = await getDeviceId();
        const changed = stampChangedPlacementClock(getData(), placementClockBaseline, { deviceId });
        resetPlacementClockBaseline(getData());
        return changed;
      } catch (e) {
        console.warn("placement clock skipped", e);
        return [];
      }
    }

    // ---- 保存链 ----
    /**
     * 串行化执行链：自动备份判定 → 抑制窗 → 结构修复/去重/墓碑清理 →
     * 时钟打标 → 落盘 → （按需）同步推送与验证 → 基线同步。
     * @returns {Promise<{ok: boolean, warning: string|null, err: string|null}>}
     */
    async function persistData() {
      const run = async () => {
        const data = getData();
        persistInFlight += 1;
        const autoBackedUp = ensureAutoBackupBeforePersist();
        suppressStorageUntil = Math.max(suppressStorageUntil, Date.now() + storageSuppressMs * 4);
        try {
          debugLog("persist_start", {
            useSync: data.settings.syncEnabled,
            groups: data.groups?.length || 0,
            nodes: Object.keys(data.nodes || {}).length,
            lastUpdated: data.lastUpdated || 0,
            autoBackedUp,
          });
          // 本地权威：始终先写 local；同步改走投影分片 engine
          const allGroupRepaired = ensureAllBookmarksGroup(data);
          const changed = dedupeData(data) || allGroupRepaired;
          const tombstonesPruned = pruneSyncTombstones(data);
          const settingsClockChanged = await stampSettingsClockBeforePersist();
          const placementClockChanged = await stampPlacementClockBeforePersist();
          let warning = null;
          let err = null;
          const err1 = await saveData(data, false);
          if (err1) {
            if (typeof err1 === "string" && err1.startsWith("local_trimmed_")) {
              warning = err1;
            } else {
              err = err1;
            }
          }
          if (!err && data.settings.syncEnabled) {
            schedulePush();
          }
          if (changed) {
            debugLog("persist_dedupe", { changed });
          }
          if (tombstonesPruned) {
            debugLog("persist_tombstones_pruned", { tombstonesPruned });
          }
          if (settingsClockChanged.length) {
            debugLog("persist_settings_clock", { settingsClockChanged });
          }
          if (placementClockChanged.length) {
            debugLog("persist_placement_clock", { placementClockChanged });
          }
          if (shouldDebugPersist()) {
            const verify = await loadDataFromArea(false);
            debugLog("persist_verify", {
              groups: verify?.groups?.length || 0,
              nodes: Object.keys(verify?.nodes || {}).length,
              lastUpdated: verify?.lastUpdated || 0,
            });
          }
          if (!err) {
            syncBackupBaseline(data);
          }
          debugLog("persist_done", { err1, changed, warning, err, autoBackedUp });
          return { ok: !err, warning, err };
        } finally {
          persistInFlight = Math.max(0, persistInFlight - 1);
        }
      };
      const next = persistChain.then(run, run);
      // 不让单次失败打断队列
      persistChain = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    }

    /**
     * 不需要等待结果的保存入口：吞掉异常，避免 unhandledrejection 触发全页红条。
     * 需要根据 ok/warning 提示用户时仍应 await persistData()。
     */
    function queuePersist() {
      return persistData().catch((e) => {
        console.warn("queuePersist failed", e);
        return { ok: false, warning: null, err: e?.message || String(e) };
      });
    }

    return {
      persistData,
      queuePersist,
      pushBackup,
      syncBackupBaseline,
      ensureAutoBackupBeforePersist,
      resetSettingsClockBaseline,
      resetPlacementClockBaseline,
      stampSettingsClockBeforePersist,
      stampPlacementClockBeforePersist,
      getSuppressStorageUntil,
      setSuppressStorageUntil,
      isStorageSuppressed,
      getPersistInFlight,
      isPersistInFlight,
    };
  }

  return { createPersistenceCoordinator };
})();

// ESM 构建（Chrome/Safari）从这里取；Firefox 拼接时会剥掉 export，改用上面的全局变量。
export const createPersistenceCoordinator = HomepagePersistenceCoordinator.createPersistenceCoordinator;
