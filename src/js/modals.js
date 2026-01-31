/**
 * Modals and Context Menu module for Homepage Extension
 */

const Modals = {
  // Elements
  overlay: null,
  content: null,
  
  // Current modal callback
  currentCallbacks: {},
  
  // Click handler reference for cleanup
  _clickHandler: null,

  /**
   * Initialize modals
   */
  init() {
    this.overlay = document.getElementById('modal-overlay');
    this.content = document.getElementById('modal-content');
    
    // Close on overlay click
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) {
        this.hide();
      }
    });

    // Close on escape
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.overlay.classList.contains('hidden')) {
        this.hide();
      }
    });
  },

  /**
   * Show a modal
   * @param {object} options - Modal options
   */
  show(options) {
    const {
      title,
      content,
      buttons = [],
      onShow = null,
      className = ''
    } = options;

    let html = `
      <div class="modal-header">
        <h2 class="modal-title">${Utils.escapeHtml(title)}</h2>
        <button class="modal-close-btn" data-action="close">
          <svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
        </button>
      </div>
      <div class="modal-body">
        ${content}
      </div>
    `;

    if (buttons.length > 0) {
      html += `
        <div class="modal-footer">
          ${buttons.map((btn, i) => `
            <button class="btn btn-${btn.type || 'secondary'}" data-action="button-${i}">
              ${Utils.escapeHtml(btn.label)}
            </button>
          `).join('')}
        </div>
      `;
    }

    this.content.innerHTML = html;
    this.content.className = `modal-content ${className}`;
    
    // Store button callbacks
    this.currentCallbacks = {};
    buttons.forEach((btn, i) => {
      this.currentCallbacks[`button-${i}`] = btn.action;
    });

    // Remove old click handler to prevent duplicates
    if (this._clickHandler) {
      this.content.removeEventListener('click', this._clickHandler);
    }

    // Handle button clicks
    this._clickHandler = (e) => {
      const action = e.target.closest('[data-action]')?.dataset.action;
      if (action === 'close') {
        this.hide();
      } else if (action && this.currentCallbacks[action]) {
        this.currentCallbacks[action]();
      }
    };
    this.content.addEventListener('click', this._clickHandler);

    this.overlay.classList.remove('hidden');
    
    if (onShow) {
      setTimeout(onShow, 50);
    }
  },

  /**
   * Hide the modal
   */
  hide() {
    this.overlay.classList.add('hidden');
    this.content.innerHTML = '';
    this.currentCallbacks = {};
  },

  /**
   * Show confirmation dialog
   * @param {object} options - Confirmation options
   */
  confirm(options) {
    const {
      title,
      message,
      confirmLabel = '确定',
      cancelLabel = '取消',
      confirmType = 'primary',
      onConfirm,
      onCancel = null
    } = options;

    this.show({
      title,
      content: `<p>${Utils.escapeHtml(message)}</p>`,
      buttons: [
        { label: cancelLabel, type: 'secondary', action: () => { this.hide(); if (onCancel) onCancel(); } },
        { label: confirmLabel, type: confirmType, action: () => { this.hide(); onConfirm(); } }
      ]
    });
  },

  /**
   * Show add/edit button modal
   * @param {object} button - Existing button data (for edit mode)
   */
  showButtonForm(button = null) {
    const isEdit = !!button;
    const title = isEdit ? '编辑按钮' : '新增按钮';
    
    const colors = ['#e74c3c', '#e91e63', '#9c27b0', '#673ab7', '#3f51b5', '#2196f3', 
                    '#03a9f4', '#00bcd4', '#009688', '#4caf50', '#8bc34a', '#cddc39',
                    '#ffc107', '#ff9800', '#ff5722', '#795548'];
    
    const colorSwatches = colors.map(c => 
      `<div class="color-swatch ${button?.iconColor === c ? 'selected' : ''}" 
            data-color="${c}" 
            style="background-color: ${c}"></div>`
    ).join('');

    const content = `
      <div class="form-group">
        <label class="form-label">网址 *</label>
        <input type="text" id="button-url" class="form-input" 
               placeholder="https://example.com" 
               value="${Utils.escapeHtml(button?.url || '')}">
        <p class="form-error" id="url-error"></p>
      </div>
      
      <div class="form-group">
        <label class="form-label">标题</label>
        <input type="text" id="button-title" class="form-input" 
               placeholder="网站标题（可选，留空自动获取）" 
               value="${Utils.escapeHtml(button?.title || '')}">
      </div>
      
      <div class="form-group">
        <label class="form-label">图标来源</label>
        <div class="icon-options">
          <label class="icon-option ${button?.iconType !== 'custom' && button?.iconType !== 'letter' ? 'selected' : ''}" data-type="favicon">
            <div class="icon-preview" id="favicon-preview">
              ${button?.icon && button?.iconType === 'favicon' ? `<img src="${button.icon}">` : '🌐'}
            </div>
            <span>自动获取</span>
          </label>
          <label class="icon-option ${button?.iconType === 'letter' ? 'selected' : ''}" data-type="letter">
            <div class="icon-preview" id="letter-preview" style="background-color: ${button?.iconColor || '#4a90d9'}; color: white; font-weight: bold;">
              ${Utils.getFirstLetter(button?.title || button?.url || 'A')}
            </div>
            <span>字母头像</span>
          </label>
          <label class="icon-option ${button?.iconType === 'custom' ? 'selected' : ''}" data-type="custom">
            <div class="icon-preview" id="custom-preview">
              ${button?.icon && button?.iconType === 'custom' ? `<img src="${button.icon}">` : '📤'}
            </div>
            <span>上传图标</span>
            <input type="file" id="icon-upload" accept="image/*" style="display: none;">
          </label>
        </div>
      </div>
      
      <div class="form-group" id="color-picker-group" style="${button?.iconType === 'letter' ? '' : 'display: none;'}">
        <label class="form-label">头像颜色</label>
        <div class="color-picker">
          ${colorSwatches}
        </div>
      </div>
      
      <div class="form-group" id="add-current-tab" style="${isEdit ? 'display: none;' : ''}">
        <button type="button" class="btn btn-secondary" id="btn-add-current">
          从当前标签页添加
        </button>
      </div>
    `;

    this.show({
      title,
      content,
      className: 'button-form-modal',
      buttons: [
        { label: '取消', type: 'secondary', action: () => this.hide() },
        { label: isEdit ? '保存' : '添加', type: 'primary', action: () => this.submitButtonForm(button?.id) }
      ],
      onShow: () => this.setupButtonFormEvents(button)
    });
  },

  /**
   * Setup button form events
   * @param {object} existingButton - Existing button data
   */
  setupButtonFormEvents(existingButton) {
    const urlInput = document.getElementById('button-url');
    const titleInput = document.getElementById('button-title');
    const iconOptions = document.querySelectorAll('.icon-option');
    const colorPicker = document.getElementById('color-picker-group');
    const colorSwatches = document.querySelectorAll('.color-swatch');
    const letterPreview = document.getElementById('letter-preview');
    const fileInput = document.getElementById('icon-upload');
    const addCurrentBtn = document.getElementById('btn-add-current');

    let selectedIconType = existingButton?.iconType || 'favicon';
    let selectedColor = existingButton?.iconColor || '#4a90d9';
    let customIconData = existingButton?.iconType === 'custom' ? existingButton.icon : null;

    // Icon type selection
    iconOptions.forEach(option => {
      option.addEventListener('click', () => {
        const type = option.dataset.type;
        selectedIconType = type;
        
        iconOptions.forEach(o => o.classList.remove('selected'));
        option.classList.add('selected');
        
        colorPicker.style.display = type === 'letter' ? '' : 'none';
        
        if (type === 'custom') {
          fileInput.click();
        }
      });
    });

    // Color selection
    colorSwatches.forEach(swatch => {
      swatch.addEventListener('click', () => {
        colorSwatches.forEach(s => s.classList.remove('selected'));
        swatch.classList.add('selected');
        selectedColor = swatch.dataset.color;
        letterPreview.style.backgroundColor = selectedColor;
      });
    });

    // Update letter preview on title change
    titleInput.addEventListener('input', () => {
      letterPreview.textContent = Utils.getFirstLetter(titleInput.value || urlInput.value || 'A');
    });

    // File upload
    fileInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      
      if (file.size > 1024 * 1024) {
        Toast.error('图标文件大小不能超过 1MB');
        return;
      }
      
      try {
        customIconData = await Utils.readFileAsDataUrl(file);
        document.getElementById('custom-preview').innerHTML = `<img src="${customIconData}">`;
      } catch (e) {
        Toast.error('读取图标文件失败');
      }
    });

    // Add current tab
    if (addCurrentBtn) {
      addCurrentBtn.addEventListener('click', async () => {
        try {
          if (typeof chrome !== 'undefined' && chrome.tabs) {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tab) {
              urlInput.value = tab.url;
              titleInput.value = tab.title;
              letterPreview.textContent = Utils.getFirstLetter(tab.title);
              Toast.info('已获取当前标签页信息');
            }
          } else {
            Toast.warning('此功能需要浏览器扩展权限');
          }
        } catch (e) {
          Toast.error('无法获取当前标签页');
        }
      });
    }

    // Store references for form submission
    this._buttonFormData = {
      getIconType: () => selectedIconType,
      getColor: () => selectedColor,
      getCustomIcon: () => customIconData
    };
  },

  /**
   * Submit button form
   * @param {string|null} buttonId - Button ID for edit, null for add
   */
  async submitButtonForm(buttonId) {
    const urlInput = document.getElementById('button-url');
    const titleInput = document.getElementById('button-title');
    const urlError = document.getElementById('url-error');
    
    // Validate URL
    const urlResult = Utils.validateUrl(urlInput.value);
    if (!urlResult.valid) {
      urlError.textContent = urlResult.error;
      urlInput.classList.add('error');
      return;
    }
    
    urlError.textContent = '';
    urlInput.classList.remove('error');
    
    const iconType = this._buttonFormData.getIconType();
    let icon = null;
    
    if (iconType === 'custom') {
      icon = this._buttonFormData.getCustomIcon();
    } else if (iconType === 'favicon') {
      icon = Utils.getFaviconUrl(urlResult.url);
    }
    
    const buttonData = {
      url: urlResult.url,
      title: titleInput.value.trim() || Utils.getDomain(urlResult.url),
      iconType,
      icon,
      iconColor: this._buttonFormData.getColor()
    };
    
    try {
      if (buttonId) {
        await ButtonManager.edit(buttonId, buttonData);
      } else {
        await ButtonManager.add(buttonData);
      }
      this.hide();
    } catch (e) {
      Toast.error(e.message || '操作失败');
    }
  },

  /**
   * Show import dialog
   */
  showImportDialog() {
    const content = `
      <div class="form-group">
        <label class="form-label">选择 JSON 文件</label>
        <input type="file" id="import-file" class="form-input" accept=".json,application/json">
      </div>
      
      <div class="form-group">
        <label class="form-label">或粘贴 JSON 内容</label>
        <textarea id="import-content" class="form-input" rows="6" placeholder='{"buttons": [...]}'>
        </textarea>
      </div>
      
      <div class="form-group">
        <label class="form-label">导入策略</label>
        <select id="import-strategy" class="form-select">
          <option value="replace">覆盖所有数据</option>
          <option value="merge">合并并更新重复项</option>
          <option value="add-only">仅添加新项</option>
        </select>
        <p class="form-hint">
          • 覆盖：删除现有数据，完全替换为导入内容<br>
          • 合并：保留现有数据，相同URL的按钮将被更新<br>
          • 仅添加：只添加不存在的按钮
        </p>
      </div>
    `;

    this.show({
      title: '导入配置',
      content,
      buttons: [
        { label: '取消', type: 'secondary', action: () => this.hide() },
        { label: '导入', type: 'primary', action: () => this.doImport() }
      ],
      onShow: () => {
        const fileInput = document.getElementById('import-file');
        const contentArea = document.getElementById('import-content');
        
        fileInput.addEventListener('change', async (e) => {
          const file = e.target.files[0];
          if (file) {
            try {
              const text = await Utils.readFileAsText(file);
              contentArea.value = text;
            } catch (e) {
              Toast.error('读取文件失败');
            }
          }
        });
      }
    });
  },

  /**
   * Execute import
   */
  async doImport() {
    const content = document.getElementById('import-content').value;
    const strategy = document.getElementById('import-strategy').value;
    
    if (!content.trim()) {
      Toast.error('请选择文件或粘贴 JSON 内容');
      return;
    }
    
    try {
      const result = await Storage.importData(content, strategy);
      this.hide();
      
      let message = `导入成功！添加了 ${result.imported} 个按钮`;
      if (result.skipped > 0) {
        message += `，跳过了 ${result.skipped} 个重复项`;
      }
      
      Toast.success(message);
      await ButtonManager.load();
      await Groups.load();
      Groups.render();
    } catch (e) {
      Toast.error(e.message || '导入失败');
    }
  },

  /**
   * Show export dialog
   */
  async showExportDialog() {
    try {
      const json = await Storage.exportData();
      const buttons = await Storage.getButtons();
      const groups = await Storage.getGroups();
      
      const content = `
        <div class="form-group">
          <p>将导出以下数据：</p>
          <ul>
            <li>${buttons.length} 个按钮</li>
            <li>${groups.length} 个分组</li>
            <li>所有设置</li>
          </ul>
        </div>
        <div class="form-group">
          <textarea id="export-content" class="form-input" rows="8" readonly>${Utils.escapeHtml(json)}</textarea>
        </div>
      `;

      this.show({
        title: '导出配置',
        content,
        buttons: [
          { label: '复制', type: 'secondary', action: () => this.copyExport() },
          { label: '下载', type: 'primary', action: () => this.downloadExport(json) }
        ]
      });
    } catch (e) {
      Toast.error('导出失败');
    }
  },

  /**
   * Copy export content
   */
  async copyExport() {
    const content = document.getElementById('export-content').value;
    try {
      await navigator.clipboard.writeText(content);
      Toast.success('已复制到剪贴板');
    } catch (e) {
      Toast.error('复制失败');
    }
  },

  /**
   * Download export file
   * @param {string} json - JSON content
   */
  downloadExport(json) {
    const filename = `homepage_backup_${Utils.formatTimestamp()}.json`;
    Utils.downloadFile(json, filename);
    Toast.success('下载已开始');
    this.hide();
  }
};


/**
 * Context Menu
 */
const ContextMenu = {
  // Element
  menu: null,
  currentButton: null,
  isInFolder: false,

  /**
   * Initialize context menu
   */
  init() {
    this.menu = document.getElementById('context-menu');
    
    // Hide on click outside
    document.addEventListener('click', () => this.hide());
    document.addEventListener('contextmenu', (e) => {
      if (!e.target.closest('.button-item')) {
        this.hide();
      }
    });

    // Handle menu item clicks
    this.menu.addEventListener('click', (e) => {
      const action = e.target.dataset.action;
      if (action) {
        this.handleAction(action);
      }
    });
  },

  /**
   * Show context menu for a button
   * @param {number} x - X position
   * @param {number} y - Y position
   * @param {object} button - Button data
   * @param {boolean} isInFolder - Whether button is in folder view
   */
  show(x, y, button, isInFolder = false) {
    this.currentButton = button;
    this.isInFolder = isInFolder;
    
    // Build menu items
    let items = '';
    
    if (button.isFolder) {
      items = `
        <li data-action="open-folder">打开</li>
        <li data-action="rename-folder">重命名</li>
        <li class="separator"></li>
        <li data-action="dissolve-folder" class="danger">解散文件夹</li>
      `;
    } else {
      items = `
        <li data-action="edit">编辑</li>
        <li data-action="open-new-tab">新标签页打开</li>
        <li data-action="open-background">后台打开</li>
        ${isInFolder ? '<li data-action="move-out">移出文件夹</li>' : ''}
        <li class="separator"></li>
        <li data-action="delete" class="danger">删除</li>
      `;
    }
    
    this.menu.querySelector('.context-menu-list').innerHTML = items;
    
    // Position menu
    this.menu.style.left = x + 'px';
    this.menu.style.top = y + 'px';
    this.menu.classList.remove('hidden');
    
    // Adjust if off screen
    const rect = this.menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
      this.menu.style.left = (x - rect.width) + 'px';
    }
    if (rect.bottom > window.innerHeight) {
      this.menu.style.top = (y - rect.height) + 'px';
    }
  },

  /**
   * Show custom context menu
   * @param {number} x - X position
   * @param {number} y - Y position
   * @param {Array} items - Menu items
   */
  showCustom(x, y, items) {
    let html = items.map(item => {
      if (item.separator) {
        return '<li class="separator"></li>';
      }
      const classes = [];
      if (item.danger) classes.push('danger');
      if (item.disabled) classes.push('disabled');
      return `<li data-action="${item.action || ''}" class="${classes.join(' ')}" ${item.disabled ? 'style="pointer-events:none;opacity:0.5"' : ''}>${Utils.escapeHtml(item.label)}</li>`;
    }).join('');
    
    this.menu.querySelector('.context-menu-list').innerHTML = html;
    
    // Store custom callbacks
    this._customCallbacks = {};
    items.forEach(item => {
      if (item.action) {
        this._customCallbacks[item.action] = item.action;
      }
    });
    
    // Position menu
    this.menu.style.left = x + 'px';
    this.menu.style.top = y + 'px';
    this.menu.classList.remove('hidden');
    
    // Handle clicks
    const clickHandler = (e) => {
      const li = e.target.closest('li');
      const item = items.find(i => i.label === li?.textContent);
      if (item?.action) {
        item.action();
      }
      this.hide();
      this.menu.removeEventListener('click', clickHandler);
    };
    
    this.menu.addEventListener('click', clickHandler);
  },

  /**
   * Hide context menu
   */
  hide() {
    this.menu.classList.add('hidden');
    this.currentButton = null;
    this._customCallbacks = {};
  },

  /**
   * Handle menu action
   * @param {string} action - Action name
   */
  handleAction(action) {
    if (!this.currentButton) return;
    
    const button = this.currentButton;
    this.hide();
    
    switch (action) {
      case 'edit':
        Modals.showButtonForm(button);
        break;
      case 'delete':
        ButtonManager.delete(button.id);
        break;
      case 'open-new-tab':
        window.open(button.url, '_blank');
        break;
      case 'open-background':
        if (typeof chrome !== 'undefined' && chrome.tabs) {
          chrome.tabs.create({ url: button.url, active: false });
        } else {
          window.open(button.url, '_blank');
        }
        break;
      case 'move-out':
        Folders.moveOut(button.id);
        break;
      case 'open-folder':
        Folders.open(button.id, button.title);
        break;
      case 'rename-folder':
        Folders.open(button.id, button.title);
        setTimeout(() => Folders.startRename(), 100);
        break;
      case 'dissolve-folder':
        Folders.confirmDissolve(button.id);
        break;
    }
  }
};

// Initialize on load
document.addEventListener('DOMContentLoaded', () => {
  Modals.init();
  ContextMenu.init();
});
