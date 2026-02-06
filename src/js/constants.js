/**
 * 应用常量定义
 * @module constants
 */

// ==================== 存储相关 ====================
export const DEBUG_LOG_KEY = "homepage_debug_log";
export const RECENT_GROUP_ID = "__recent__";

// ==================== 数量限制 ====================
export const RECENT_LIMIT = 24;
export const MAX_DEBUG_LOG_ENTRIES = 200;

// ==================== 尺寸相关 ====================
export const DEFAULT_TILE_SIZE = 150;
export const DEFAULT_BASE_FONT = 13;
export const MIN_TILE_SIZE = 32;
export const MAX_TILE_SIZE = 220;

// ==================== 时间相关 (毫秒) ====================
export const TOAST_DURATION_MS = 5000;
export const TOOLTIP_DELAY_MS = 200;
export const UNDO_TIMEOUT_MS = 10000;
export const STORAGE_RELOAD_DELAY_MS = 120;
export const STORAGE_SUPPRESS_MS = 350;
export const SETTINGS_SAVE_DELAY_MS = 120;
export const TOAST_CONSUME_TIMEOUT_MS = 15000;
export const TITLE_FETCH_TIMEOUT_MS = 6000;
export const ICON_PROBE_TIMEOUT_MS = 6000;

// ==================== 其他 ====================
export const HISTORY_DAYS = 7;
export const BOX_SELECT_THRESHOLD = 6;

// ==================== 密度配置 ====================
export const densityMap = {
  compact: { gap: 10 },
  standard: { gap: 16 },
  spacious: { gap: 22 },
};

// ==================== 背景遮罩配置 ====================
export const bgOverlayMap = {
  light: "rgba(245, 246, 250, 0.85)",
  dark: "rgba(12, 15, 20, 0.72)",
};
