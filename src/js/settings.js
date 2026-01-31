/**
 * Settings module for Homepage Extension
 */

const Settings = {
  /**
   * Get version from manifest
   * @returns {string} Version string
   */
  getVersion() {
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest) {
        return chrome.runtime.getManifest().version;
      }
      if (typeof browser !== 'undefined' && browser.runtime && browser.runtime.getManifest) {
        return browser.runtime.getManifest().version;
      }
    } catch (e) {
      // Fallback
    }
    return '1.0.0';
  },

  /**
   * Show settings modal
   */
  show() {
    const settings = App.settings;
    
    const content = `
      <div class="settings-panel">
        <!-- Theme Settings -->
        <div class="settings-section">
          <h3 class="settings-section-title">外观设置</h3>
          
          <div class="settings-row">
            <div>
              <span class="settings-label">主题</span>
            </div>
            <select id="setting-theme" class="form-select">
              <option value="system" ${settings.theme === 'system' ? 'selected' : ''}>跟随系统</option>
              <option value="light" ${settings.theme === 'light' ? 'selected' : ''}>浅色</option>
              <option value="dark" ${settings.theme === 'dark' ? 'selected' : ''}>深色</option>
            </select>
          </div>
          
          <div class="settings-row">
            <div>
              <span class="settings-label">背景类型</span>
            </div>
            <select id="setting-bg-type" class="form-select">
              <option value="bing" ${settings.background?.type === 'bing' ? 'selected' : ''}>每日 Bing 壁纸</option>
              <option value="solid" ${settings.background?.type === 'solid' ? 'selected' : ''}>纯色</option>
              <option value="gradient" ${settings.background?.type === 'gradient' ? 'selected' : ''}>渐变色</option>
              <option value="custom" ${settings.background?.type === 'custom' ? 'selected' : ''}>自定义图片</option>
            </select>
          </div>
          
          <div class="settings-row" id="bg-color-row" style="${settings.background?.type === 'solid' ? '' : 'display:none'}">
            <div>
              <span class="settings-label">背景颜色</span>
            </div>
            <input type="color" id="setting-bg-color" value="${settings.background?.color || '#2c3e50'}">
          </div>
          
          <div id="bg-gradient-row" style="${settings.background?.type === 'gradient' ? '' : 'display:none'}">
            <div class="settings-row">
              <div>
                <span class="settings-label">渐变起始颜色</span>
              </div>
              <input type="color" id="setting-gradient-color1" value="${settings.background?.gradientColor1 || '#2c3e50'}">
            </div>
            
            <div class="settings-row">
              <div>
                <span class="settings-label">渐变结束颜色</span>
              </div>
              <input type="color" id="setting-gradient-color2" value="${settings.background?.gradientColor2 || '#3498db'}">
            </div>
          </div>
          
          <div class="settings-row" id="bg-custom-row" style="${settings.background?.type === 'custom' ? '' : 'display:none'}">
            <div>
              <span class="settings-label">自定义背景</span>
            </div>
            <button id="setting-bg-upload" class="btn btn-secondary">上传图片</button>
            <input type="file" id="bg-upload-input" accept="image/*" style="display:none">
          </div>
          
          <div class="settings-row">
            <div>
              <span class="settings-label">背景淡入效果</span>
            </div>
            <div class="toggle-switch ${settings.background?.fadeEffect ? 'active' : ''}" id="setting-fade-effect"></div>
          </div>
        </div>

        <!-- Grid Settings -->
        <div class="settings-section">
          <h3 class="settings-section-title">网格布局</h3>
          
          <div class="settings-row">
            <div>
              <span class="settings-label">固定布局</span>
              <p class="settings-description">开启后使用固定的行列数</p>
            </div>
            <div class="toggle-switch ${settings.grid?.fixed ? 'active' : ''}" id="setting-grid-fixed"></div>
          </div>
          
          <div id="grid-size-settings" style="${settings.grid?.fixed ? '' : 'display:none'}">
            <div class="settings-row">
              <div>
                <span class="settings-label">列数</span>
              </div>
              <select id="setting-grid-cols" class="form-select">
                ${[4,6,8,10,12].map(n => `<option value="${n}" ${settings.grid?.columns === n ? 'selected' : ''}>${n}</option>`).join('')}
              </select>
            </div>
            
            <div class="settings-row">
              <div>
                <span class="settings-label">行数</span>
              </div>
              <select id="setting-grid-rows" class="form-select">
                ${[2,3,4,5,6].map(n => `<option value="${n}" ${settings.grid?.rows === n ? 'selected' : ''}>${n}</option>`).join('')}
              </select>
            </div>
          </div>
          
          <div class="settings-row">
            <div>
              <span class="settings-label">网格密度</span>
            </div>
            <select id="setting-grid-density" class="form-select">
              <option value="compact" ${settings.grid?.density === 'compact' ? 'selected' : ''}>紧凑</option>
              <option value="standard" ${settings.grid?.density === 'standard' ? 'selected' : ''}>标准</option>
              <option value="loose" ${settings.grid?.density === 'loose' ? 'selected' : ''}>宽松</option>
            </select>
          </div>
        </div>

        <!-- Open Mode -->
        <div class="settings-section">
          <h3 class="settings-section-title">打开方式</h3>
          
          <div class="settings-row">
            <div>
              <span class="settings-label">默认打开方式</span>
            </div>
            <select id="setting-open-mode" class="form-select">
              <option value="current" ${settings.openMode === 'current' ? 'selected' : ''}>当前标签页</option>
              <option value="new-tab" ${settings.openMode === 'new-tab' ? 'selected' : ''}>新标签页</option>
              <option value="background" ${settings.openMode === 'background' ? 'selected' : ''}>后台新标签页</option>
            </select>
          </div>
        </div>

        <!-- Group Settings -->
        <div class="settings-section">
          <h3 class="settings-section-title">分组设置</h3>
          
          <div class="settings-row">
            <div>
              <span class="settings-label">显示最近浏览</span>
              <p class="settings-description">在左侧分组最上方显示最近访问的按钮</p>
            </div>
            <div class="toggle-switch ${settings.showRecentView !== false ? 'active' : ''}" id="setting-show-recent"></div>
          </div>

          <div class="settings-row">
            <div>
              <span class="settings-label">记住上次分组</span>
              <p class="settings-description">重新打开时回到上次点击的分组</p>
            </div>
            <div class="toggle-switch ${settings.rememberLastGroup !== false ? 'active' : ''}" id="setting-remember-group"></div>
          </div>
        </div>

        <!-- Search Settings -->
        <div class="settings-section">
          <h3 class="settings-section-title">搜索设置</h3>
          
          <div class="settings-row">
            <div>
              <span class="settings-label">显示搜索框</span>
            </div>
            <div class="toggle-switch ${settings.search?.enabled ? 'active' : ''}" id="setting-search-enabled"></div>
          </div>
          
          <div class="settings-row">
            <div>
              <span class="settings-label">集成搜索引擎</span>
              <p class="settings-description">回车可使用搜索引擎搜索</p>
            </div>
            <div class="toggle-switch ${settings.search?.engineIntegration ? 'active' : ''}" id="setting-search-engine"></div>
          </div>
          
          <div class="settings-row">
            <div>
              <span class="settings-label">默认搜索引擎</span>
            </div>
            <select id="setting-search-engine-type" class="form-select">
              <option value="google" ${settings.search?.searchEngine === 'google' ? 'selected' : ''}>Google</option>
              <option value="bing" ${settings.search?.searchEngine === 'bing' ? 'selected' : ''}>Bing</option>
              <option value="baidu" ${settings.search?.searchEngine === 'baidu' ? 'selected' : ''}>百度</option>
              <option value="duckduckgo" ${settings.search?.searchEngine === 'duckduckgo' ? 'selected' : ''}>DuckDuckGo</option>
            </select>
          </div>
        </div>

        <!-- Icon Settings -->
        <div class="settings-section">
          <h3 class="settings-section-title">图标设置</h3>
          
          <div class="settings-row">
            <div>
              <span class="settings-label">自动获取图标</span>
            </div>
            <div class="toggle-switch ${settings.icon?.autoFetch ? 'active' : ''}" id="setting-icon-auto"></div>
          </div>
          
          <div class="settings-row">
            <div>
              <span class="settings-label">定时重试失败图标</span>
              <p class="settings-description">每天在指定时间自动重试获取失败的图标</p>
            </div>
            <div class="toggle-switch ${settings.icon?.retryEnabled !== false ? 'active' : ''}" id="setting-icon-retry"></div>
          </div>
          
          <div class="settings-row" id="retry-time-row" style="${settings.icon?.retryEnabled !== false ? '' : 'display:none'}">
            <div>
              <span class="settings-label">重试时间</span>
            </div>
            <input type="time" id="setting-retry-time" class="form-select" value="${settings.icon?.retryTime || '18:00'}" style="width: 120px;">
          </div>
          
          <div class="settings-row">
            <button id="btn-refresh-icons" class="btn btn-secondary">刷新所有图标</button>
          </div>
        </div>

        <!-- Sync Settings -->
        <div class="settings-section">
          <h3 class="settings-section-title">数据同步</h3>
          
          <div class="settings-row">
            <div>
              <span class="settings-label">启用云同步</span>
              <p class="settings-description">同步到浏览器账号（有配额限制）</p>
            </div>
            <div class="toggle-switch ${settings.sync?.enabled ? 'active' : ''}" id="setting-sync-enabled"></div>
          </div>
        </div>

        <!-- Backup Settings -->
        <div class="settings-section">
          <h3 class="settings-section-title">备份与恢复</h3>
          
          <div class="settings-row">
            <div>
              <span class="settings-label">自动备份</span>
              <p class="settings-description">每次修改前自动创建备份</p>
            </div>
            <div class="toggle-switch ${settings.backup?.autoBackup ? 'active' : ''}" id="setting-auto-backup"></div>
          </div>
          
          <div class="settings-row">
            <div>
              <span class="settings-label">最大备份数</span>
            </div>
            <select id="setting-max-backups" class="form-select">
              <option value="5" ${settings.backup?.maxBackups === 5 ? 'selected' : ''}>5</option>
              <option value="10" ${settings.backup?.maxBackups === 10 ? 'selected' : ''}>10</option>
              <option value="20" ${settings.backup?.maxBackups === 20 ? 'selected' : ''}>20</option>
              <option value="0" ${settings.backup?.maxBackups === 0 ? 'selected' : ''}>不限制</option>
            </select>
          </div>
          
          <div class="settings-row" style="gap: 8px;">
            <button id="btn-backup-manage" class="btn btn-secondary">管理备份</button>
            <button id="btn-import" class="btn btn-secondary">导入</button>
            <button id="btn-export" class="btn btn-secondary">导出</button>
          </div>
        </div>

        <!-- Accessibility -->
        <div class="settings-section">
          <h3 class="settings-section-title">辅助功能</h3>
          
          <div class="settings-row">
            <div>
              <span class="settings-label">键盘导航</span>
              <p class="settings-description">使用方向键移动焦点</p>
            </div>
            <div class="toggle-switch ${settings.accessibility?.keyboardNav ? 'active' : ''}" id="setting-keyboard-nav"></div>
          </div>
        </div>

        <!-- Data Management -->
        <div class="settings-section">
          <h3 class="settings-section-title">数据管理</h3>
          
          <div class="settings-row" style="gap: 8px;">
            <button id="btn-clear-cache" class="btn btn-secondary">清空图标缓存</button>
            <button id="btn-reset" class="btn btn-danger">恢复默认</button>
          </div>
        </div>

        <!-- About -->
        <div class="settings-section">
          <h3 class="settings-section-title">关于</h3>
          <p style="color: var(--text-muted); font-size: 12px;">
            Homepage Extension v${this.getVersion()}<br>
            本扩展不收集任何用户数据。<br>
            数据仅存储在本地或用户开启同步后进入浏览器同步存储。
          </p>
        </div>
      </div>
    `;

    Modals.show({
      title: '设置',
      content,
      buttons: [
        { label: '关闭', type: 'primary', action: () => Modals.hide() }
      ],
      onShow: () => this.setupEvents()
    });
  },

  /**
   * Setup settings events
   */
  setupEvents() {
    // Toggle switches
    document.querySelectorAll('.toggle-switch').forEach(toggle => {
      toggle.addEventListener('click', () => {
        toggle.classList.toggle('active');
        this.handleToggle(toggle.id, toggle.classList.contains('active'));
      });
    });

    // Theme
    document.getElementById('setting-theme')?.addEventListener('change', async (e) => {
      await this.update({ theme: e.target.value });
      App.applyTheme();
    });

    // Background type
    document.getElementById('setting-bg-type')?.addEventListener('change', async (e) => {
      const type = e.target.value;
      document.getElementById('bg-color-row').style.display = type === 'solid' ? '' : 'none';
      document.getElementById('bg-gradient-row').style.display = type === 'gradient' ? '' : 'none';
      document.getElementById('bg-custom-row').style.display = type === 'custom' ? '' : 'none';
      await this.update({ background: { ...App.settings.background, type } });
      await App.applyBackground();
    });

    // Background color
    document.getElementById('setting-bg-color')?.addEventListener('change', async (e) => {
      await this.update({ background: { ...App.settings.background, color: e.target.value } });
      await App.applyBackground();
    });

    // Gradient color 1
    document.getElementById('setting-gradient-color1')?.addEventListener('change', async (e) => {
      await this.update({ background: { ...App.settings.background, gradientColor1: e.target.value } });
      await App.applyBackground();
    });

    // Gradient color 2
    document.getElementById('setting-gradient-color2')?.addEventListener('change', async (e) => {
      await this.update({ background: { ...App.settings.background, gradientColor2: e.target.value } });
      await App.applyBackground();
    });

    // Custom background upload
    const bgUploadBtn = document.getElementById('setting-bg-upload');
    const bgUploadInput = document.getElementById('bg-upload-input');
    if (bgUploadBtn && bgUploadInput) {
      bgUploadBtn.addEventListener('click', () => bgUploadInput.click());
      bgUploadInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (file) {
          try {
            const dataUrl = await Utils.readFileAsDataUrl(file);
            this.update({ background: { ...App.settings.background, customUrl: dataUrl } });
            App.applyBackground();
            Toast.success('背景已更新');
          } catch (err) {
            Toast.error('读取图片失败');
          }
        }
      });
    }

    // Grid fixed toggle
    document.getElementById('setting-grid-fixed')?.addEventListener('click', () => {
      const fixed = document.getElementById('setting-grid-fixed').classList.contains('active');
      document.getElementById('grid-size-settings').style.display = fixed ? '' : 'none';
    });

    // Grid columns
    document.getElementById('setting-grid-cols')?.addEventListener('change', async (e) => {
      await this.update({ grid: { ...App.settings.grid, columns: parseInt(e.target.value) } });
      App.applyGridSettings();
    });

    // Grid rows
    document.getElementById('setting-grid-rows')?.addEventListener('change', async (e) => {
      await this.update({ grid: { ...App.settings.grid, rows: parseInt(e.target.value) } });
      App.applyGridSettings();
    });

    // Grid density
    document.getElementById('setting-grid-density')?.addEventListener('change', async (e) => {
      await this.update({ grid: { ...App.settings.grid, density: e.target.value } });
      App.applyGridSettings();
    });

    // Open mode
    document.getElementById('setting-open-mode')?.addEventListener('change', async (e) => {
      await this.update({ openMode: e.target.value });
    });

    // Search engine type
    document.getElementById('setting-search-engine-type')?.addEventListener('change', async (e) => {
      await this.update({ search: { ...App.settings.search, searchEngine: e.target.value } });
    });

    // Max backups
    document.getElementById('setting-max-backups')?.addEventListener('change', async (e) => {
      await this.update({ backup: { ...App.settings.backup, maxBackups: parseInt(e.target.value) } });
    });

    // Icon retry time
    document.getElementById('setting-retry-time')?.addEventListener('change', async (e) => {
      await this.update({ icon: { ...App.settings.icon, retryTime: e.target.value } });
    });

    // Buttons
    document.getElementById('btn-refresh-icons')?.addEventListener('click', () => {
      ButtonManager.refreshAllIcons();
    });

    document.getElementById('btn-backup-manage')?.addEventListener('click', () => {
      this.showBackupManager();
    });

    document.getElementById('btn-import')?.addEventListener('click', () => {
      Modals.showImportDialog();
    });

    document.getElementById('btn-export')?.addEventListener('click', () => {
      Modals.showExportDialog();
    });

    document.getElementById('btn-clear-cache')?.addEventListener('click', async () => {
      await Storage.clearIconCache();
      Toast.success('图标缓存已清空');
    });

    document.getElementById('btn-reset')?.addEventListener('click', () => {
      Modals.confirm({
        title: '恢复默认设置',
        message: '确定要恢复所有设置和数据到默认状态吗？此操作不可撤销（但会创建备份）。',
        confirmLabel: '恢复默认',
        confirmType: 'danger',
        onConfirm: async () => {
          await Storage.resetToDefaults();
          Toast.success('已恢复默认设置');
          location.reload();
        }
      });
    });
  },

  /**
   * Handle toggle switch
   * @param {string} id - Toggle ID
   * @param {boolean} value - New value
   */
  async handleToggle(id, value) {
    const settings = App.settings;
    
    switch (id) {
      case 'setting-fade-effect':
        await this.update({ background: { ...settings.background, fadeEffect: value } });
        break;
      case 'setting-grid-fixed':
        await this.update({ grid: { ...settings.grid, fixed: value } });
        App.applyGridSettings();
        break;
      case 'setting-show-recent':
        await this.update({ showRecentView: value });
        // Reload groups to show/hide recent view
        await Groups.load();
        Groups.render();
        Toast.success(value ? '已开启最近浏览' : '已关闭最近浏览');
        break;
      case 'setting-remember-group':
        await this.update({ rememberLastGroup: value });
        break;
      case 'setting-search-enabled':
        await this.update({ search: { ...settings.search, enabled: value } });
        document.querySelector('.search-wrapper').style.display = value ? '' : 'none';
        break;
      case 'setting-search-engine':
        await this.update({ search: { ...settings.search, engineIntegration: value } });
        break;
      case 'setting-icon-auto':
        await this.update({ icon: { ...settings.icon, autoFetch: value } });
        break;
      case 'setting-icon-retry':
        await this.update({ icon: { ...settings.icon, retryEnabled: value } });
        // Update visibility of retry time input
        document.getElementById('retry-time-row').style.display = value ? '' : 'none';
        break;
      case 'setting-sync-enabled':
        await this.handleSyncToggle(value);
        break;
      case 'setting-auto-backup':
        await this.update({ backup: { ...settings.backup, autoBackup: value } });
        break;
      case 'setting-keyboard-nav':
        await this.update({ accessibility: { ...settings.accessibility, keyboardNav: value } });
        break;
    }
  },

  /**
   * Handle sync toggle with migration
   * @param {boolean} enable - Whether to enable sync
   */
  async handleSyncToggle(enable) {
    const loadingToast = Toast.loading(enable ? '正在迁移数据到云端...' : '正在迁移数据到本地...');
    
    try {
      const result = await Storage.migrateStorage(enable);
      Toast.hide(loadingToast);
      
      if (result.success) {
        Toast.success(enable ? '已启用云同步' : '已关闭云同步');
      } else {
        Toast.error('迁移失败: ' + (result.error || '未知错误'));
        // Revert toggle
        document.getElementById('setting-sync-enabled')?.classList.toggle('active');
      }
    } catch (e) {
      Toast.hide(loadingToast);
      Toast.error('迁移失败');
      document.getElementById('setting-sync-enabled')?.classList.toggle('active');
    }
  },

  /**
   * Update settings
   * @param {object} updates - Settings to update
   */
  async update(updates) {
    App.settings = await Storage.saveSettings(updates);
  },

  /**
   * Show backup manager
   */
  async showBackupManager() {
    const backups = await Storage.getBackups();
    
    let backupList = '';
    if (backups.length === 0) {
      backupList = '<p style="color: var(--text-muted); text-align: center; padding: 20px;">暂无备份</p>';
    } else {
      backupList = backups.map(b => `
        <div class="backup-item" style="display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--border-color);">
          <div>
            <div style="font-weight: 500;">${Utils.formatDate(b.timestamp)}</div>
            <div style="font-size: 12px; color: var(--text-muted);">${b.buttons?.length || 0} 个按钮</div>
          </div>
          <div style="display: flex; gap: 8px;">
            <button class="btn btn-secondary btn-restore" data-id="${b.id}">恢复</button>
            <button class="btn btn-text btn-delete" data-id="${b.id}">删除</button>
          </div>
        </div>
      `).join('');
    }

    Modals.show({
      title: '备份管理',
      content: `
        <div style="max-height: 400px; overflow-y: auto;">
          ${backupList}
        </div>
      `,
      buttons: [
        { label: '关闭', type: 'secondary', action: () => Modals.hide() },
        { label: '立即备份', type: 'primary', action: async () => {
          await Storage.createBackup();
          Toast.success('备份已创建');
          this.showBackupManager();
        }}
      ],
      onShow: () => {
        // Restore buttons
        document.querySelectorAll('.btn-restore').forEach(btn => {
          btn.addEventListener('click', async () => {
            const id = btn.dataset.id;
            Modals.confirm({
              title: '恢复备份',
              message: '确定要恢复此备份吗？当前数据将会被覆盖（但会先创建备份）。',
              confirmLabel: '恢复',
              onConfirm: async () => {
                try {
                  await Storage.restoreBackup(id);
                  Toast.success('备份已恢复');
                  location.reload();
                } catch (e) {
                  Toast.error('恢复失败: ' + e.message);
                }
              }
            });
          });
        });

        // Delete buttons
        document.querySelectorAll('.btn-delete').forEach(btn => {
          btn.addEventListener('click', async () => {
            const id = btn.dataset.id;
            await Storage.deleteBackup(id);
            Toast.success('备份已删除');
            this.showBackupManager();
          });
        });
      }
    });
  }
};
