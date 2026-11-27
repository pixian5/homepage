/**
 * @fileoverview 项目核心数据结构的 JSDoc 类型定义。
 * 此文件仅包含类型标注，不生成运行时代码，供各模块通过 JSDoc 引用。
 */

/**
 * 扩展设置对象（与 storage.js DEFAULT_SETTINGS 保持严格一致）
 * @typedef {Object} Settings
 * @property {string} [language]
 * @property {boolean} [showSearch]
 * @property {boolean} [enableSearchEngine]
 * @property {string} [searchEngineUrl]
 * @property {'current'|'new'|'background'} [openMode]
 * @property {boolean} [fixedLayout]
 * @property {number} [fixedCols]
 * @property {'compact'|'standard'|'spacious'} [gridDensity]
 * @property {number} [fontSize]
 * @property {number} [toastDuration]
 * @property {boolean} [tooltipEnabled]
 * @property {boolean} [emptyHintDisabled]
 * @property {'bing'|'color'|'gradient'|'custom'} [backgroundType]
 * @property {string} [backgroundColor]
 * @property {string} [backgroundGradient]
 * @property {string} [backgroundGradientA]
 * @property {string} [backgroundGradientB]
 * @property {string} [backgroundCustom]
 * @property {boolean} [backgroundFade]
 * @property {number} [backgroundOverlayStrength]
 * @property {boolean} [iconFetch]
 * @property {boolean} [iconThirdPartyFallback]
 * @property {boolean} [iconRetryAtSix]
 * @property {number|string} [iconRetryHour]
 * @property {boolean} [syncEnabled]
 * @property {'http'} [syncTransport]
 * @property {string} [syncServerUrl]
 * @property {string} [syncServerToken]
 * @property {string} [syncInterval]
 * @property {boolean} [syncE2eeEnabled]
 * @property {string} [syncE2eePassphrase]
 * @property {string} [syncDeviceId]
 * @property {string} [syncDeviceSecret]
 * @property {string} [syncDeviceServerUrl]
 * @property {number} [maxBackups]
 * @property {boolean} [keyboardNav]
 * @property {string} [lastActiveGroupId]
 * @property {'last'|'fixed'} [defaultGroupMode]
 * @property {string} [defaultGroupId]
 * @property {'system'|'light'|'dark'} [theme]
 * @property {string} [lastSaveUrl]
 * @property {number} [lastSaveTs]
 * @property {boolean} [sidebarCollapsed]
 * @property {boolean} [sidebarHidden]
 * @property {number} [lastTileSize]
 */

/**
 * 唯一根目录对象。运行时 groups 只保留 ID 为 grp_all 的这一项。
 * @typedef {Object} Group
 * @property {string} id
 * @property {string} [name]
 * @property {string} [title]
 * @property {number} order
 * @property {string[]} nodes
 * @property {boolean} [systemAllGroup]
 * @property {number} [updatedAt]
 * @property {string} [updatedBy]
 * @property {number} [deletedAt]
 * @property {number} [purgedAt]
 */

/**
 * 普通卡片节点
 * @typedef {Object} ItemNode
 * @property {string} id
 * @property {'item'} type
 * @property {string} title
 * @property {string} url
 * @property {'auto'|'upload'|'color'|'remote'|'letter'} iconType
 * @property {string} [iconData]
 * @property {string} [color]
 * @property {boolean} [titlePending]
 * @property {boolean} [iconPending]
 * @property {number} [createdAt]
 * @property {number} updatedAt
 * @property {string} [updatedBy]
 * @property {number} [titleUpdatedAt]
 * @property {number} [urlUpdatedAt]
 * @property {number} [deletedAt]
 * @property {number} [purgedAt]
 */

/**
 * 文件夹节点
 * @typedef {Object} FolderNode
 * @property {string} id
 * @property {'folder'} type
 * @property {string} title
 * @property {string[]} children
 * @property {number} [createdAt]
 * @property {number} updatedAt
 * @property {string} [updatedBy]
 * @property {number} [titleUpdatedAt]
 * @property {number} [deletedAt]
 * @property {number} [purgedAt]
 */

/**
 * @typedef {ItemNode | FolderNode} Node
 */

/**
 * 备份快照条目（data 字段保存当时的完整 HomepageData 副本）
 * @typedef {Object} BackupSnapshot
 * @property {string} id
 * @property {number} ts
 * @property {HomepageData} data
 */

/**
 * 节点位置的独立同步时钟。父容器发生无关变化时不得更新此记录。
 * @typedef {Object} PlacementClock
 * @property {'group'|'folder'} parentKind
 * @property {string} parentId
 * @property {number} index
 * @property {number} updatedAt
 * @property {string} updatedBy
 */

/**
 * 首页完整数据对象
 * @typedef {Object} HomepageData
 * @property {number} schemaVersion
 * @property {Settings} settings
 * @property {Group[]} groups
 * @property {Record<string, Node>} nodes
 * @property {BackupSnapshot[]} backups
 * @property {number} lastUpdated
 * @property {{
 *   rootModelVersion?: number,
 *   docId?: string,
 *   revision?: number,
 *   contentHash?: string,
 *   settingsClock?: Record<string, { updatedAt: number, updatedBy: string }>,
 *   placementClock?: Record<string, PlacementClock>,
 *   nodeTombstones?: Record<string, number>,
 * }} [_syncMeta]
 */

/**
 * 图标缓存条目
 * @typedef {Object} IconCacheEntry
 * @property {string} [dataUrl]
 * @property {string} [url]
 * @property {number} ts
 * @property {number} [hits]
 * @property {boolean} [failed]
 * @property {number} [attempts]
 */

/**
 * Bing 壁纸缓存条目
 * @typedef {Object} WallpaperCacheEntry
 * @property {string} url
 * @property {string} [copyright]
 * @property {number} ts
 * @property {string} [lang]
 */

/**
 * 运行时同步状态对象
 * @typedef {Object} SyncStatus
 * @property {boolean} enabled
 * @property {string|null} docId
 * @property {'off'|'idle'|'syncing'|'error'|'need_setup'|'quota'|'device_retired'} status
 * @property {number} lastPullAt
 * @property {number} lastPushAt
 * @property {string} lastError
 * @property {number} lastRemoteRevision
 * @property {string} lastRemoteEtag
 * @property {number} lastRemoteEpoch
 * @property {number} bytesEstimate
 * @property {'http'} transport
 */
