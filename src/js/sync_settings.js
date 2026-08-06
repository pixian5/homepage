import { SYNC_SETTINGS_WHITELIST } from "./sync_policy.js";

const SYNC_SETTING_KEYS = new Set(SYNC_SETTINGS_WHITELIST);

function asNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function asStr(value) {
  return String(value ?? "");
}

function stableValue(value) {
  return JSON.stringify(value ?? null);
}

function validClock(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const updatedAt = asNum(entry.updatedAt);
  if (!updatedAt) return null;
  return {
    updatedAt,
    updatedBy: asStr(entry.updatedBy),
  };
}

function compareClock(left, right) {
  const l = validClock(left);
  const r = validClock(right);
  if (l && !r) return 1;
  if (!l && r) return -1;
  if (!l && !r) return 0;
  if (l.updatedAt !== r.updatedAt) return l.updatedAt > r.updatedAt ? 1 : -1;
  if (l.updatedBy !== r.updatedBy) return l.updatedBy > r.updatedBy ? 1 : -1;
  return 0;
}

/**
 * @param {unknown} value
 * @returns {Record<string, { updatedAt: number, updatedBy: string }>}
 */
export function normalizeSettingsClock(value) {
  const out = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [key, entry] of Object.entries(value)) {
    if (!SYNC_SETTING_KEYS.has(key)) continue;
    const clock = validClock(entry);
    if (clock) out[key] = clock;
  }
  return out;
}

/**
 * 给本机真实变更过的同步设置项打 per-key clock。
 * @param {object} data
 * @param {object} previousSettings
 * @param {{ deviceId: string, now?: number }} ctx
 * @returns {string[]} changed keys
 */
export function stampChangedSyncSettings(data, previousSettings = {}, ctx = {}) {
  if (!data || typeof data !== "object") return [];
  const settings = data.settings && typeof data.settings === "object" ? data.settings : {};
  const prev = previousSettings && typeof previousSettings === "object" ? previousSettings : {};
  const changed = [];
  for (const key of SYNC_SETTINGS_WHITELIST) {
    if (!Object.getOwnPropertyDescriptor(settings, key)) continue;
    if (stableValue(settings[key]) !== stableValue(prev[key])) changed.push(key);
  }
  if (!changed.length) return changed;

  const now = asNum(ctx.now, Date.now());
  const deviceId = asStr(ctx.deviceId || "dev_unknown");
  if (!data._syncMeta || typeof data._syncMeta !== "object" || Array.isArray(data._syncMeta)) data._syncMeta = {};
  const clock = normalizeSettingsClock(data._syncMeta.settingsClock);
  for (const key of changed) {
    clock[key] = { updatedAt: now, updatedBy: deviceId };
  }
  data._syncMeta.settingsClock = clock;
  return changed;
}

/**
 * @param {object} data
 * @param {object} projectedSettings
 * @returns {Record<string, { updatedAt: number, updatedBy: string }>}
 */
export function projectSettingsClock(data, projectedSettings = {}) {
  const clock = normalizeSettingsClock(data?._syncMeta?.settingsClock);
  const projected = {};
  for (const key of Object.keys(projectedSettings || {})) {
    if (clock[key]) projected[key] = clock[key];
  }
  return projected;
}

/**
 * settings 合并：升级后用 per-key clock；旧远端缺 clock 时只补本地缺失字段。
 * @param {object} localSettings
 * @param {object} remoteSettings
 * @param {object} localClock
 * @param {object} remoteClock
 * @returns {{ settings: object, settingsClock: Record<string, { updatedAt: number, updatedBy: string }> }}
 */
export function mergeSettingsByClock(localSettings = {}, remoteSettings = {}, localClock = {}, remoteClock = {}) {
  const local = localSettings && typeof localSettings === "object" ? localSettings : {};
  const remote = remoteSettings && typeof remoteSettings === "object" ? remoteSettings : {};
  const lClock = normalizeSettingsClock(localClock);
  const rClock = normalizeSettingsClock(remoteClock);
  const settings = { ...local };
  const settingsClock = { ...lClock };

  for (const [key, remoteValue] of Object.entries(remote)) {
    if (!SYNC_SETTING_KEYS.has(key)) continue;
    const remoteHasClock = !!rClock[key];
    const localHasClock = !!lClock[key];
    const localHasValue = Object.getOwnPropertyDescriptor(local, key) && local[key] !== undefined;

    if (!remoteHasClock) {
      if (!localHasValue) settings[key] = remoteValue;
      continue;
    }

    if (!localHasClock || compareClock(rClock[key], lClock[key]) >= 0) {
      settings[key] = remoteValue;
      settingsClock[key] = rClock[key];
    }
  }

  return { settings, settingsClock };
}
