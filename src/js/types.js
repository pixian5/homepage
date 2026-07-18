/**
 * @fileoverview 项目核心数据结构的 JSDoc 类型定义。
 * 此文件仅包含类型标注，不生成运行时代码，供各模块通过 JSDoc 引用。
 */

/**
 * 扩展设置对象
 * @typedef {Object} Settings
 * @property {string} [language]
 * @property {string} [theme]
 * @property {number} [fontSize]
 * @property {string} [density]
 * @property {string} [backgroundType]
 * @property {string} [backgroundBing]
 * @property {string} [backgroundCustom]
 * @property {string} [searchEngine]
 * @property {string} [customSearchUrl]
 * @property {boolean} [showSearchBox]
 * @property {boolean} [syncEnabled]
 * @property {number} [maxBackups]
 * @property {string} [defaultGroupMode]
 * @property {string} [defaultGroupId]
 * @property {string} [lastActiveGroupId]
 * @property {string} [lastSaveUrl]
 * @property {number} [lastSaveTs]
 * @property {boolean} [keyboardNav]
 */

/**
 * 分组对象
 * @typedef {Object} Group
 * @property {string} id
 * @property {string} name
 * @property {number} order
 * @property {string[]} nodes
 */

/**
 * 普通卡片节点
 * @typedef {Object} ItemNode
 * @property {string} id
 * @property {'item'} type
 * @property {string} title
 * @property {string} url
 * @property {'auto'|'upload'|'color'|'remote'|'letter'} iconType
 * @property {string} iconData
 * @property {string} color
 * @property {boolean} [titlePending]
 * @property {boolean} [iconPending]
 * @property {number} createdAt
 * @property {number} updatedAt
 */

/**
 * 文件夹节点
 * @typedef {Object} FolderNode
 * @property {string} id
 * @property {'folder'} type
 * @property {string} title
 * @property {string[]} children
 * @property {number} createdAt
 * @property {number} updatedAt
 */

/**
 * @typedef {ItemNode | FolderNode} Node
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
 */

/**
 * 备份快照
 * @typedef {Object} BackupSnapshot
 * @property {string} id
 * @property {number} createdAt
 * @property {number} schemaVersion
 * @property {Settings} settings
 * @property {Group[]} groups
 * @property {Record<string, Node>} nodes
 */

/**
 * 图标缓存条目
 * @typedef {Object} IconCacheEntry
 * @property {string} [dataUrl]
 * @property {string} [url]
 * @property {number} ts
 * @property {number} [hits]
 */

/**
 * Bing 壁纸缓存条目
 * @typedef {Object} WallpaperCacheEntry
 * @property {string} url
 * @property {string} copyright
 * @property {number} fetchedAt
 * @property {string} dateKey
 */

export {}; // 占位导出，使文件成为 ESM 模块
