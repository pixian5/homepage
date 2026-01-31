/**
 * Storage module for Homepage Extension
 * Supports local and sync storage with migration
 */

const Storage = {
  // Current schema version for data migration
  SCHEMA_VERSION: 1,
  
  // Storage keys
  KEYS: {
    BUTTONS: 'homepage_buttons',
    GROUPS: 'homepage_groups',
    SETTINGS: 'homepage_settings',
    BACKUPS: 'homepage_backups',
    ICON_CACHE: 'homepage_icon_cache',
    LAST_BACKUP: 'homepage_last_backup'
  },

  // Default settings
  DEFAULT_SETTINGS: {
    schemaVersion: 1,
    theme: 'system', // 'light', 'dark', 'system'
    background: {
      type: 'bing', // 'bing', 'solid', 'gradient', 'custom'
      color: '#2c3e50',
      gradient: 'linear-gradient(135deg, #2c3e50, #3498db)',
      customUrl: '',
      showLoadingToast: true,
      fadeEffect: true
    },
    grid: {
      fixed: true,
      columns: 8,
      rows: 3,
      density: 'standard' // 'compact', 'standard', 'loose'
    },
    openMode: 'new-tab', // 'current', 'new-tab', 'background'
    showRecentView: true, // Show recent view in groups sidebar
    search: {
      enabled: true,
      engineIntegration: true,
      searchEngine: 'google' // 'google', 'bing', 'baidu', 'duckduckgo'
    },
    icon: {
      autoFetch: true,
      retryAt18: true,
      fallbackType: 'letter' // 'letter', 'default'
    },
    sync: {
      enabled: false
    },
    backup: {
      autoBackup: true,
      maxBackups: 10
    },
    accessibility: {
      keyboardNav: true
    },
    hideEmptyGuide: false
  },

  // Default groups
  DEFAULT_GROUPS: [
    { id: 'default', name: '默认', order: 0 }
  ],

  /**
   * Get storage API (chrome.storage or browser.storage)
   * @returns {object} Storage API
   */
  getStorageApi() {
    if (typeof chrome !== 'undefined' && chrome.storage) {
      return chrome.storage;
    }
    if (typeof browser !== 'undefined' && browser.storage) {
      return browser.storage;
    }
    // Fallback to localStorage wrapper for development
    return this.localStorageFallback;
  },

  /**
   * LocalStorage fallback for development
   */
  localStorageFallback: {
    local: {
      get(keys) {
        return new Promise(resolve => {
          const result = {};
          const keyArray = Array.isArray(keys) ? keys : [keys];
          keyArray.forEach(key => {
            const value = localStorage.getItem(key);
            if (value) {
              try {
                result[key] = JSON.parse(value);
              } catch (e) {
                result[key] = value;
              }
            }
          });
          resolve(result);
        });
      },
      set(items) {
        return new Promise(resolve => {
          Object.entries(items).forEach(([key, value]) => {
            localStorage.setItem(key, JSON.stringify(value));
          });
          resolve();
        });
      },
      remove(keys) {
        return new Promise(resolve => {
          const keyArray = Array.isArray(keys) ? keys : [keys];
          keyArray.forEach(key => localStorage.removeItem(key));
          resolve();
        });
      },
      clear() {
        return new Promise(resolve => {
          localStorage.clear();
          resolve();
        });
      }
    },
    sync: {
      get(keys) {
        return Storage.localStorageFallback.local.get(keys);
      },
      set(items) {
        return Storage.localStorageFallback.local.set(items);
      },
      remove(keys) {
        return Storage.localStorageFallback.local.remove(keys);
      }
    }
  },

  /**
   * Get current storage (local or sync based on settings)
   * @returns {object} Storage object
   */
  async getCurrentStorage() {
    const api = this.getStorageApi();
    const settings = await this.getSettings();
    return settings.sync?.enabled ? api.sync : api.local;
  },

  /**
   * Get settings from storage
   * @returns {Promise<object>} Settings object
   */
  async getSettings() {
    const api = this.getStorageApi();
    const result = await api.local.get(this.KEYS.SETTINGS);
    return { ...this.DEFAULT_SETTINGS, ...result[this.KEYS.SETTINGS] };
  },

  /**
   * Save settings to storage
   * @param {object} settings - Settings to save
   */
  async saveSettings(settings) {
    const api = this.getStorageApi();
    const current = await this.getSettings();
    const updated = { ...current, ...settings };
    await api.local.set({ [this.KEYS.SETTINGS]: updated });
    return updated;
  },

  /**
   * Get all buttons
   * @returns {Promise<Array>} Array of buttons
   */
  async getButtons() {
    const storage = await this.getCurrentStorage();
    const result = await storage.get(this.KEYS.BUTTONS);
    return result[this.KEYS.BUTTONS] || [];
  },

  /**
   * Save all buttons
   * @param {Array} buttons - Buttons to save
   * @param {boolean} createBackup - Whether to create backup before saving
   */
  async saveButtons(buttons, createBackup = true) {
    if (createBackup) {
      await this.createBackup();
    }
    const storage = await this.getCurrentStorage();
    try {
      await storage.set({ [this.KEYS.BUTTONS]: buttons });
    } catch (e) {
      console.error('Failed to save buttons:', e);
      throw new Error('保存失败：可能超出存储配额');
    }
  },

  /**
   * Add a new button
   * @param {object} button - Button data
   * @returns {Promise<object>} Created button
   */
  async addButton(button) {
    const buttons = await this.getButtons();
    const newButton = {
      id: Utils.generateId(),
      title: button.title || '',
      url: button.url || '',
      icon: button.icon || null,
      iconType: button.iconType || 'favicon', // 'favicon', 'custom', 'letter'
      iconColor: button.iconColor || Utils.stringToColor(button.title || button.url),
      groupId: button.groupId || 'default',
      folderId: button.folderId || null,
      order: buttons.length,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    buttons.push(newButton);
    await this.saveButtons(buttons);
    return newButton;
  },

  /**
   * Update a button
   * @param {string} id - Button ID
   * @param {object} updates - Updates to apply
   * @returns {Promise<object>} Updated button
   */
  async updateButton(id, updates) {
    const buttons = await this.getButtons();
    const index = buttons.findIndex(b => b.id === id);
    if (index === -1) throw new Error('按钮不存在');
    
    buttons[index] = {
      ...buttons[index],
      ...updates,
      updatedAt: Date.now()
    };
    await this.saveButtons(buttons);
    return buttons[index];
  },

  /**
   * Delete a button
   * @param {string} id - Button ID
   */
  async deleteButton(id) {
    const buttons = await this.getButtons();
    const filtered = buttons.filter(b => b.id !== id);
    await this.saveButtons(filtered);
  },

  /**
   * Delete multiple buttons
   * @param {Array<string>} ids - Button IDs to delete
   */
  async deleteButtons(ids) {
    const buttons = await this.getButtons();
    const filtered = buttons.filter(b => !ids.includes(b.id));
    await this.saveButtons(filtered);
  },

  /**
   * Reorder buttons
   * @param {Array<{id: string, order: number}>} orders - New order mapping
   */
  async reorderButtons(orders) {
    const buttons = await this.getButtons();
    const orderMap = new Map(orders.map(o => [o.id, o.order]));
    buttons.forEach(b => {
      if (orderMap.has(b.id)) {
        b.order = orderMap.get(b.id);
      }
    });
    buttons.sort((a, b) => a.order - b.order);
    await this.saveButtons(buttons, false);
  },

  /**
   * Update button last accessed time
   * @param {string} id - Button ID
   */
  async updateButtonLastAccessed(id) {
    const buttons = await this.getButtons();
    const button = buttons.find(b => b.id === id);
    if (button) {
      button.lastAccessedAt = Date.now();
      await this.saveButtons(buttons);
    }
  },

  /**
   * Get all groups
   * @returns {Promise<Array>} Array of groups
   */
  async getGroups() {
    const storage = await this.getCurrentStorage();
    const result = await storage.get(this.KEYS.GROUPS);
    return result[this.KEYS.GROUPS] || Utils.deepClone(this.DEFAULT_GROUPS);
  },

  /**
   * Save all groups
   * @param {Array} groups - Groups to save
   */
  async saveGroups(groups) {
    const storage = await this.getCurrentStorage();
    await storage.set({ [this.KEYS.GROUPS]: groups });
  },

  /**
   * Add a new group
   * @param {object} group - Group data
   * @returns {Promise<object>} Created group
   */
  async addGroup(group) {
    const groups = await this.getGroups();
    const newGroup = {
      id: Utils.generateId(),
      name: group.name || '新分组',
      order: groups.length,
      createdAt: Date.now()
    };
    groups.push(newGroup);
    await this.saveGroups(groups);
    return newGroup;
  },

  /**
   * Update a group
   * @param {string} id - Group ID
   * @param {object} updates - Updates to apply
   */
  async updateGroup(id, updates) {
    const groups = await this.getGroups();
    const index = groups.findIndex(g => g.id === id);
    if (index === -1) throw new Error('分组不存在');
    groups[index] = { ...groups[index], ...updates };
    await this.saveGroups(groups);
    return groups[index];
  },

  /**
   * Delete a group (moves buttons to default)
   * @param {string} id - Group ID
   */
  async deleteGroup(id) {
    if (id === 'default') throw new Error('无法删除默认分组');
    
    // Move all buttons to default group
    const buttons = await this.getButtons();
    buttons.forEach(b => {
      if (b.groupId === id) {
        b.groupId = 'default';
      }
    });
    await this.saveButtons(buttons, false);
    
    // Delete the group
    const groups = await this.getGroups();
    const filtered = groups.filter(g => g.id !== id);
    await this.saveGroups(filtered);
  },

  /**
   * Create a backup of current data
   * @returns {Promise<object>} Backup object
   */
  async createBackup() {
    const settings = await this.getSettings();
    if (!settings.backup?.autoBackup) return null;

    const api = this.getStorageApi();
    const buttons = await this.getButtons();
    const groups = await this.getGroups();
    
    const backup = {
      id: Utils.generateId(),
      timestamp: Date.now(),
      schemaVersion: this.SCHEMA_VERSION,
      buttons: Utils.deepClone(buttons),
      groups: Utils.deepClone(groups),
      settings: Utils.deepClone(settings)
    };

    // Get existing backups
    const result = await api.local.get(this.KEYS.BACKUPS);
    let backups = result[this.KEYS.BACKUPS] || [];
    
    // Add new backup
    backups.unshift(backup);
    
    // Limit backups
    const maxBackups = settings.backup?.maxBackups || 10;
    if (maxBackups > 0 && backups.length > maxBackups) {
      backups = backups.slice(0, maxBackups);
    }
    
    await api.local.set({ 
      [this.KEYS.BACKUPS]: backups,
      [this.KEYS.LAST_BACKUP]: Date.now()
    });
    
    return backup;
  },

  /**
   * Get all backups
   * @returns {Promise<Array>} Array of backups
   */
  async getBackups() {
    const api = this.getStorageApi();
    const result = await api.local.get(this.KEYS.BACKUPS);
    return result[this.KEYS.BACKUPS] || [];
  },

  /**
   * Restore from a backup
   * @param {string} backupId - Backup ID to restore
   */
  async restoreBackup(backupId) {
    const backups = await this.getBackups();
    const backup = backups.find(b => b.id === backupId);
    if (!backup) throw new Error('备份不存在');
    
    // Create a backup before restoring
    await this.createBackup();
    
    // Restore data
    await this.saveButtons(backup.buttons, false);
    await this.saveGroups(backup.groups);
    if (backup.settings) {
      await this.saveSettings(backup.settings);
    }
  },

  /**
   * Delete a backup
   * @param {string} backupId - Backup ID to delete
   */
  async deleteBackup(backupId) {
    const api = this.getStorageApi();
    const backups = await this.getBackups();
    const filtered = backups.filter(b => b.id !== backupId);
    await api.local.set({ [this.KEYS.BACKUPS]: filtered });
  },

  /**
   * Export all data as JSON
   * @returns {Promise<string>} JSON string
   */
  async exportData() {
    const buttons = await this.getButtons();
    const groups = await this.getGroups();
    const settings = await this.getSettings();
    
    const data = {
      schemaVersion: this.SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      buttons,
      groups,
      settings
    };
    
    return JSON.stringify(data, null, 2);
  },

  /**
   * Import data from JSON
   * @param {string} jsonString - JSON string to import
   * @param {string} strategy - 'replace', 'merge', 'add-only'
   * @returns {Promise<object>} Import result
   */
  async importData(jsonString, strategy = 'replace') {
    let data;
    try {
      data = JSON.parse(jsonString);
    } catch (e) {
      throw new Error('JSON格式无效');
    }

    // Validate data structure
    if (!data.buttons || !Array.isArray(data.buttons)) {
      throw new Error('数据格式无效：缺少按钮数据');
    }

    // Create backup before import
    await this.createBackup();

    const currentButtons = await this.getButtons();
    const currentGroups = await this.getGroups();
    
    let newButtons = [];
    let newGroups = [];
    let importedCount = 0;
    let skippedCount = 0;
    let conflicts = [];

    switch (strategy) {
      case 'replace':
        // Replace all data
        newButtons = data.buttons.map((b, i) => ({
          ...b,
          id: b.id || Utils.generateId(),
          order: i,
          updatedAt: Date.now()
        }));
        newGroups = data.groups || Utils.deepClone(this.DEFAULT_GROUPS);
        importedCount = newButtons.length;
        break;

      case 'merge':
        // Merge with existing, update duplicates
        const buttonUrlMap = new Map(currentButtons.map(b => [b.url, b]));
        newButtons = [...currentButtons];
        
        data.buttons.forEach(b => {
          const existing = buttonUrlMap.get(b.url);
          if (existing) {
            // Update existing
            const idx = newButtons.findIndex(nb => nb.id === existing.id);
            if (idx !== -1) {
              newButtons[idx] = { ...newButtons[idx], ...b, id: existing.id, updatedAt: Date.now() };
              conflicts.push({ url: b.url, action: 'updated' });
            }
          } else {
            // Add new
            newButtons.push({
              ...b,
              id: Utils.generateId(),
              order: newButtons.length,
              createdAt: Date.now(),
              updatedAt: Date.now()
            });
            importedCount++;
          }
        });
        
        // Merge groups
        const groupNameMap = new Map(currentGroups.map(g => [g.name, g]));
        newGroups = [...currentGroups];
        (data.groups || []).forEach(g => {
          if (!groupNameMap.has(g.name)) {
            newGroups.push({ ...g, id: Utils.generateId() });
          }
        });
        break;

      case 'add-only':
        // Only add new items, skip duplicates
        const existingUrls = new Set(currentButtons.map(b => b.url));
        newButtons = [...currentButtons];
        
        data.buttons.forEach(b => {
          if (!existingUrls.has(b.url)) {
            newButtons.push({
              ...b,
              id: Utils.generateId(),
              order: newButtons.length,
              createdAt: Date.now(),
              updatedAt: Date.now()
            });
            importedCount++;
          } else {
            skippedCount++;
          }
        });
        
        newGroups = currentGroups;
        break;
    }

    // Save imported data
    await this.saveButtons(newButtons, false);
    await this.saveGroups(newGroups);

    if (data.settings && strategy === 'replace') {
      await this.saveSettings(data.settings);
    }

    return {
      success: true,
      imported: importedCount,
      skipped: skippedCount,
      conflicts
    };
  },

  /**
   * Cache an icon
   * @param {string} url - Button URL
   * @param {string} iconData - Base64 icon data
   */
  async cacheIcon(url, iconData) {
    const api = this.getStorageApi();
    const result = await api.local.get(this.KEYS.ICON_CACHE);
    const cache = result[this.KEYS.ICON_CACHE] || {};
    cache[url] = {
      data: iconData,
      cachedAt: Date.now()
    };
    await api.local.set({ [this.KEYS.ICON_CACHE]: cache });
  },

  /**
   * Get cached icon
   * @param {string} url - Button URL
   * @returns {Promise<string|null>} Cached icon data or null
   */
  async getCachedIcon(url) {
    const api = this.getStorageApi();
    const result = await api.local.get(this.KEYS.ICON_CACHE);
    const cache = result[this.KEYS.ICON_CACHE] || {};
    return cache[url]?.data || null;
  },

  /**
   * Clear icon cache
   */
  async clearIconCache() {
    const api = this.getStorageApi();
    await api.local.remove(this.KEYS.ICON_CACHE);
  },

  /**
   * Migrate data between local and sync storage
   * @param {boolean} toSync - If true, migrate to sync; if false, migrate to local
   * @returns {Promise<object>} Migration result
   */
  async migrateStorage(toSync) {
    const api = this.getStorageApi();
    const source = toSync ? api.local : api.sync;
    const target = toSync ? api.sync : api.local;
    
    try {
      // Get data from source
      const buttons = await source.get(this.KEYS.BUTTONS);
      const groups = await source.get(this.KEYS.GROUPS);
      
      // Save to target
      if (buttons[this.KEYS.BUTTONS]) {
        await target.set({ [this.KEYS.BUTTONS]: buttons[this.KEYS.BUTTONS] });
      }
      if (groups[this.KEYS.GROUPS]) {
        await target.set({ [this.KEYS.GROUPS]: groups[this.KEYS.GROUPS] });
      }
      
      // Update settings
      await this.saveSettings({ sync: { enabled: toSync } });
      
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },

  /**
   * Clear all data
   */
  async clearAllData() {
    await this.createBackup();
    const api = this.getStorageApi();
    await api.local.remove([
      this.KEYS.BUTTONS,
      this.KEYS.GROUPS,
      this.KEYS.ICON_CACHE
    ]);
    await api.sync.remove([
      this.KEYS.BUTTONS,
      this.KEYS.GROUPS
    ]);
  },

  /**
   * Reset to defaults
   */
  async resetToDefaults() {
    await this.createBackup();
    await this.saveButtons([]);
    await this.saveGroups(Utils.deepClone(this.DEFAULT_GROUPS));
    await this.saveSettings(Utils.deepClone(this.DEFAULT_SETTINGS));
  }
};

// Freeze the Storage object
Object.freeze(Storage);
