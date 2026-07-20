/**
 * 多设备同步策略常量（与《多设备同步开发方案》对齐）
 * 供 projection / pack / outbox / UI 共用，避免 magic number 散落。
 */

/** storage.sync 单片目标上限（Chrome 单 key ~8KB，留余量） */
export const SYNC_SHARD_MAX_BYTES = 7000;

/** 投影总体积软/硬预算 */
export const SYNC_TOTAL_SOFT_BYTES = 60_000;
export const SYNC_TOTAL_HARD_BYTES = 90_000;

/** 墓碑保留时间 */
export const SYNC_TOMBSTONE_TTL_MS = 60 * 24 * 60 * 60 * 1000;

/** Outbox 退避（对齐 Pass 思路） */
export const SYNC_OUTBOX_MAX_ATTEMPTS = 12;
export const SYNC_OUTBOX_BASE_DELAY_MS = 5_000;
export const SYNC_OUTBOX_MAX_DELAY_MS = 60 * 60 * 1000;

export const SYNC_PUSH_DEBOUNCE_MS = 1000;
export const SYNC_PULL_DEBOUNCE_MS = 400;
export const SYNC_REVISION_RETRY = 3;
export const SYNC_SAFETY_MAX = 5;

/** 标题进同步投影时截断，控体积 */
export const SYNC_TITLE_MAX_CHARS = 200;

/** remote iconData（URL）最大长度 */
export const SYNC_ICON_DATA_MAX_CHARS = 2048;

export const SYNC_DOC_SCHEMA = "homepage.sync.doc.v1";
export const SYNC_META_SCHEMA = "homepage.sync.meta.v1";
export const SYNC_BUNDLE_SCHEMA = "homepage.sync.bundle.v1";

export const SYNC_META_KEY = "homepage_sync_meta";
export const SYNC_SHARD_KEY_PREFIX = "homepage_sync_s";
export const SYNC_OUTBOX_KEY = "homepage_sync_outbox";
export const SYNC_STATE_KEY = "homepage_sync_state";
export const DEVICE_ID_KEY = "homepage_device_id";

/** 可进入同步投影的 settings 白名单 */
export const SYNC_SETTINGS_WHITELIST = [
  "language",
  "openMode",
  "showSearch",
  "searchEngineUrl",
  "enableSearchEngine",
  "gridDensity",
  "fixedLayout",
  "fixedCols",
  "fontSize",
  "theme",
  "tooltipEnabled",
  "keyboardNav",
  "defaultGroupMode",
  "defaultGroupId",
  "sidebarCollapsed",
  "sidebarHidden",
  "iconFetch",
  "iconRetryAtSix",
  "iconRetryHour",
  "backgroundType",
  "backgroundColor",
  "backgroundGradient",
  "backgroundGradientA",
  "backgroundGradientB",
  "backgroundOverlayStrength",
  "backgroundFade",
  "maxBackups",
  "emptyHintDisabled",
  "syncEnabled",
];

/**
 * @param {number} attempts
 * @returns {number}
 */
export function syncOutboxRetryDelayMs(attempts) {
  const exponent = Math.max(0, Math.min(Number(attempts || 1) - 1, 8));
  return Math.min(SYNC_OUTBOX_MAX_DELAY_MS, SYNC_OUTBOX_BASE_DELAY_MS * 2 ** exponent);
}

/**
 * @param {number} bytes
 * @returns {"green"|"yellow"|"red"}
 */
export function syncBytesBudgetLevel(bytes) {
  const n = Number(bytes) || 0;
  if (n >= SYNC_TOTAL_HARD_BYTES) return "red";
  if (n >= SYNC_TOTAL_SOFT_BYTES) return "yellow";
  return "green";
}
