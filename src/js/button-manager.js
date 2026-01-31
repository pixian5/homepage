/**
 * Button Manager module for Homepage Extension
 * Handles button rendering and interactions
 */

const ButtonManager = {
  // State
  buttons: [],
  selectedButtons: new Set(),
  selectionMode: false,
  currentGroupId: 'default',
  currentFolderId: null,
  
  // Pending delete for undo
  pendingDelete: null,
  
  // Elements
  gridElement: null,
  emptyStateElement: null,

  /**
   * Initialize button manager
   */
  async init() {
    this.gridElement = document.getElementById('button-grid');
    this.emptyStateElement = document.getElementById('empty-state');
    
    await this.load();
    this.setupEventListeners();
  },

  /**
   * Load buttons from storage
   */
  async load() {
    this.buttons = await Storage.getButtons();
    this.render();
  },

  /**
   * Setup event listeners
   */
  setupEventListeners() {
    // Grid click handling
    this.gridElement.addEventListener('click', (e) => this.handleGridClick(e));
    this.gridElement.addEventListener('contextmenu', (e) => this.handleContextMenu(e));
    
    // Empty state dismiss
    const dismissBtn = document.getElementById('empty-dismiss');
    if (dismissBtn) {
      dismissBtn.addEventListener('click', async () => {
        await Storage.saveSettings({ hideEmptyGuide: true });
        this.emptyStateElement.classList.add('hidden');
      });
    }
  },

  /**
   * Get buttons for current view
   * @returns {Array} Filtered buttons
   */
  getVisibleButtons() {
    // Handle "最近浏览" special group
    if (this.currentGroupId === 'recent') {
      // Get all buttons sorted by last accessed time (descending)
      const allButtons = [...this.buttons].filter(b => b.lastAccessedAt);
      allButtons.sort((a, b) => (b.lastAccessedAt || 0) - (a.lastAccessedAt || 0));
      // Return top 20 most recently accessed buttons
      return allButtons.slice(0, 20);
    }

    let filtered = this.buttons.filter(b => b.groupId === this.currentGroupId);
    
    if (this.currentFolderId) {
      filtered = filtered.filter(b => b.folderId === this.currentFolderId);
    } else {
      // Only show top-level buttons and folders
      filtered = filtered.filter(b => !b.folderId);
    }
    
    // Sort by order
    filtered.sort((a, b) => (a.order || 0) - (b.order || 0));
    
    return filtered;
  },

  /**
   * Get folders from buttons
   * @returns {Array} Folder objects
   */
  getFolders() {
    const folderMap = new Map();
    
    this.buttons.forEach(b => {
      if (b.folderId) {
        if (!folderMap.has(b.folderId)) {
          folderMap.set(b.folderId, {
            id: b.folderId,
            name: b.folderName || '文件夹',
            children: []
          });
        }
        folderMap.get(b.folderId).children.push(b);
      }
    });
    
    // Find buttons that represent folders
    const folders = [];
    this.buttons.forEach(b => {
      if (b.isFolder && folderMap.has(b.id)) {
        folders.push({
          ...b,
          children: folderMap.get(b.id).children
        });
      }
    });
    
    return folders;
  },

  /**
   * Render the button grid
   */
  render() {
    const visibleButtons = this.getVisibleButtons();
    const settings = App.settings;
    
    // Show/hide empty state
    if (visibleButtons.length === 0 && !settings?.hideEmptyGuide) {
      this.emptyStateElement.classList.remove('hidden');
      this.gridElement.innerHTML = '';
      return;
    }
    
    this.emptyStateElement.classList.add('hidden');
    
    // Use DocumentFragment for better performance
    const fragment = document.createDocumentFragment();
    
    // Render buttons
    visibleButtons.forEach(button => {
      const buttonEl = this.createButtonElement(button);
      fragment.appendChild(buttonEl);
    });
    
    // Clear and append in one operation
    this.gridElement.innerHTML = '';
    this.gridElement.appendChild(fragment);
  },

  /**
   * Create a button element
   * @param {object} button - Button data
   * @returns {HTMLElement} Button element
   */
  createButtonElement(button) {
    const el = document.createElement('div');
    el.className = 'button-item';
    el.dataset.id = button.id;
    el.draggable = true;
    el.tabIndex = 0;
    el.setAttribute('role', 'button');
    el.setAttribute('aria-label', `${button.title}: ${button.url}`);
    
    if (button.isFolder) {
      el.classList.add('folder');
    }
    
    if (this.selectionMode) {
      el.classList.add('selection-mode');
    }
    
    if (this.selectedButtons.has(button.id)) {
      el.classList.add('selected');
    }

    // Selection checkbox
    const checkbox = document.createElement('div');
    checkbox.className = 'select-checkbox';
    el.appendChild(checkbox);

    // Icon
    const icon = this.createIconElement(button);
    el.appendChild(icon);

    // Title
    const title = document.createElement('span');
    title.className = 'button-title';
    title.textContent = button.title || Utils.getDomain(button.url) || '无标题';
    if (button.titleColor) {
      title.style.color = button.titleColor;
    }
    el.appendChild(title);

    return el;
  },

  /**
   * Create icon element for a button
   * @param {object} button - Button data
   * @returns {HTMLElement} Icon element
   */
  createIconElement(button) {
    if (button.isFolder) {
      // Folder preview with child icons
      const preview = document.createElement('div');
      preview.className = 'folder-preview';
      
      const children = this.buttons.filter(b => b.folderId === button.id).slice(0, 4);
      children.forEach(child => {
        const childIcon = document.createElement('img');
        childIcon.className = 'folder-preview-icon';
        childIcon.src = child.icon || Utils.getFaviconUrl(child.url);
        childIcon.onerror = () => {
          childIcon.style.backgroundColor = child.iconColor || Utils.stringToColor(child.title);
        };
        preview.appendChild(childIcon);
      });
      
      // Fill remaining slots
      for (let i = children.length; i < 4; i++) {
        const placeholder = document.createElement('div');
        placeholder.className = 'folder-preview-icon';
        placeholder.style.backgroundColor = 'var(--bg-tertiary)';
        preview.appendChild(placeholder);
      }
      
      return preview;
    }
    
    if (button.iconType === 'letter' || !button.icon) {
      // Letter avatar
      const avatar = document.createElement('div');
      avatar.className = 'button-icon letter-avatar';
      avatar.textContent = Utils.getFirstLetter(button.title || button.url);
      avatar.style.backgroundColor = button.iconColor || Utils.stringToColor(button.title || button.url);
      return avatar;
    }
    
    // Image icon
    const img = document.createElement('img');
    img.className = 'button-icon';
    img.src = button.icon;
    img.alt = '';
    img.loading = 'lazy';
    
    // Fallback to letter avatar on error
    img.onerror = () => {
      const avatar = document.createElement('div');
      avatar.className = 'button-icon letter-avatar';
      avatar.textContent = Utils.getFirstLetter(button.title || button.url);
      avatar.style.backgroundColor = button.iconColor || Utils.stringToColor(button.title || button.url);
      img.replaceWith(avatar);
    };
    
    return img;
  },

  /**
   * Handle grid click
   * @param {Event} e - Click event
   */
  handleGridClick(e) {
    const buttonEl = e.target.closest('.button-item');
    if (!buttonEl) return;
    
    const id = buttonEl.dataset.id;
    const button = this.buttons.find(b => b.id === id);
    if (!button) return;

    // Selection mode
    if (this.selectionMode) {
      this.toggleSelection(id);
      return;
    }

    // Ctrl/Cmd click for multi-select
    if (e.ctrlKey || e.metaKey) {
      this.toggleSelection(id);
      return;
    }

    // Shift click for range select
    if (e.shiftKey && this.selectedButtons.size > 0) {
      this.selectRange(id);
      return;
    }

    // Normal click - open link or folder
    if (button.isFolder) {
      Folders.open(button.id, button.title);
    } else {
      this.openButton(button);
    }
  },

  /**
   * Handle context menu
   * @param {Event} e - Context menu event
   */
  handleContextMenu(e) {
    const buttonEl = e.target.closest('.button-item');
    if (!buttonEl) return;
    
    e.preventDefault();
    const id = buttonEl.dataset.id;
    const button = this.buttons.find(b => b.id === id);
    if (!button) return;

    ContextMenu.show(e.clientX, e.clientY, button);
  },

  /**
   * Open a button's URL
   * @param {object} button - Button to open
   */
  openButton(button) {
    const settings = App.settings;
    const openMode = settings?.openMode || 'new-tab';
    
    if (!button.url) {
      Toast.error('URL无效');
      return;
    }

    // Update last accessed time
    Storage.updateButtonLastAccessed(button.id);

    try {
      switch (openMode) {
        case 'current':
          window.location.href = button.url;
          break;
        case 'new-tab':
          window.open(button.url, '_blank');
          break;
        case 'background':
          // Use chrome.tabs API if available
          if (typeof chrome !== 'undefined' && chrome.tabs) {
            chrome.tabs.create({ url: button.url, active: false });
          } else {
            // Fallback
            window.open(button.url, '_blank');
          }
          break;
        default:
          window.open(button.url, '_blank');
      }
    } catch (e) {
      Toast.error('无法打开链接: ' + e.message);
    }
  },

  /**
   * Toggle button selection
   * @param {string} id - Button ID
   */
  toggleSelection(id) {
    if (this.selectedButtons.has(id)) {
      this.selectedButtons.delete(id);
    } else {
      this.selectedButtons.add(id);
    }
    this.updateSelectionUI();
  },

  /**
   * Select range of buttons
   * @param {string} toId - End button ID
   */
  selectRange(toId) {
    const visibleButtons = this.getVisibleButtons();
    const ids = visibleButtons.map(b => b.id);
    
    const lastSelected = Array.from(this.selectedButtons).pop();
    const fromIndex = ids.indexOf(lastSelected);
    const toIndex = ids.indexOf(toId);
    
    if (fromIndex === -1 || toIndex === -1) return;
    
    const start = Math.min(fromIndex, toIndex);
    const end = Math.max(fromIndex, toIndex);
    
    for (let i = start; i <= end; i++) {
      this.selectedButtons.add(ids[i]);
    }
    
    this.updateSelectionUI();
  },

  /**
   * Select all visible buttons
   */
  selectAll() {
    this.getVisibleButtons().forEach(b => {
      this.selectedButtons.add(b.id);
    });
    this.updateSelectionUI();
  },

  /**
   * Clear selection
   */
  clearSelection() {
    this.selectedButtons.clear();
    this.selectionMode = false;
    this.updateSelectionUI();
  },

  /**
   * Update selection UI
   */
  updateSelectionUI() {
    document.querySelectorAll('.button-item').forEach(el => {
      const id = el.dataset.id;
      el.classList.toggle('selected', this.selectedButtons.has(id));
      el.classList.toggle('selection-mode', this.selectionMode || this.selectedButtons.size > 0);
    });

    // Update batch delete button state
    const batchDeleteBtn = document.getElementById('btn-batch-delete');
    if (batchDeleteBtn) {
      batchDeleteBtn.classList.toggle('active', this.selectedButtons.size > 0);
    }
  },

  /**
   * Enter selection mode
   */
  enterSelectionMode() {
    this.selectionMode = true;
    this.updateSelectionUI();
  },

  /**
   * Add a new button
   * @param {object} buttonData - Button data
   * @returns {Promise<object>} Created button
   */
  async add(buttonData) {
    const button = await Storage.addButton({
      ...buttonData,
      groupId: this.currentGroupId
    });
    this.buttons.push(button);
    this.render();
    Toast.success('添加成功');
    return button;
  },

  /**
   * Edit a button
   * @param {string} id - Button ID
   * @param {object} updates - Updates to apply
   */
  async edit(id, updates) {
    const button = await Storage.updateButton(id, updates);
    const index = this.buttons.findIndex(b => b.id === id);
    if (index !== -1) {
      this.buttons[index] = button;
    }
    this.render();
    Toast.success('保存成功');
  },

  /**
   * Delete a button with undo support
   * @param {string} id - Button ID
   */
  async delete(id) {
    const button = this.buttons.find(b => b.id === id);
    if (!button) return;

    // Store for potential undo
    this.pendingDelete = {
      type: 'single',
      buttons: [Utils.deepClone(button)],
      timeout: null
    };

    // Remove from local state
    this.buttons = this.buttons.filter(b => b.id !== id);
    this.render();

    // Show undo toast
    Toast.undo(`已删除「${button.title || '无标题'}」`, async () => {
      await this.undoDelete();
    });

    // Set timeout for permanent deletion
    this.pendingDelete.timeout = setTimeout(async () => {
      await Storage.deleteButton(id);
      this.pendingDelete = null;
    }, Toast.UNDO_DURATION);
  },

  /**
   * Delete selected buttons
   */
  async deleteSelected() {
    const ids = Array.from(this.selectedButtons);
    if (ids.length === 0) return;

    const buttonsToDelete = this.buttons.filter(b => ids.includes(b.id));
    
    // Store for potential undo
    this.pendingDelete = {
      type: 'batch',
      buttons: buttonsToDelete.map(b => Utils.deepClone(b)),
      timeout: null
    };

    // Remove from local state
    this.buttons = this.buttons.filter(b => !ids.includes(b.id));
    this.selectedButtons.clear();
    this.selectionMode = false;
    this.render();

    // Show undo toast
    Toast.undo(`已删除 ${ids.length} 个快捷按钮`, async () => {
      await this.undoDelete();
    });

    // Set timeout for permanent deletion
    this.pendingDelete.timeout = setTimeout(async () => {
      await Storage.deleteButtons(ids);
      this.pendingDelete = null;
    }, Toast.UNDO_DURATION);
  },

  /**
   * Undo last delete
   */
  async undoDelete() {
    if (!this.pendingDelete) return;

    // Clear timeout
    if (this.pendingDelete.timeout) {
      clearTimeout(this.pendingDelete.timeout);
    }

    // Restore buttons
    this.pendingDelete.buttons.forEach(b => {
      this.buttons.push(b);
    });

    this.pendingDelete = null;
    this.render();
    Toast.success('已恢复');
  },

  /**
   * Move button to a different group
   * @param {string} buttonId - Button ID
   * @param {string} groupId - Target group ID
   */
  async moveToGroup(buttonId, groupId) {
    await this.edit(buttonId, { groupId });
  },

  /**
   * Move selected buttons to a group
   * @param {string} groupId - Target group ID
   */
  async moveSelectedToGroup(groupId) {
    const ids = Array.from(this.selectedButtons);
    for (const id of ids) {
      await Storage.updateButton(id, { groupId });
    }
    await this.load();
    this.clearSelection();
    Toast.success(`已移动 ${ids.length} 个按钮`);
  },

  /**
   * Update button order after drag
   * @param {Array<{id: string, order: number}>} newOrder - New order mapping
   */
  async updateOrder(newOrder) {
    await Storage.reorderButtons(newOrder);
    await this.load();
  },

  /**
   * Fetch and update icon for a button
   * @param {string} id - Button ID
   * @param {boolean} force - Force refresh even if cached
   */
  async refreshIcon(id, force = false) {
    const button = this.buttons.find(b => b.id === id);
    if (!button || button.iconType === 'custom' || button.iconType === 'letter') {
      return;
    }

    // Check cache first
    if (!force) {
      const cached = await Storage.getCachedIcon(button.url);
      if (cached) {
        await this.edit(id, { icon: cached });
        return;
      }
    }

    // Fetch favicon
    const faviconUrl = Utils.getFaviconUrl(button.url);
    try {
      const base64 = await Utils.imageToBase64(faviconUrl);
      await Storage.cacheIcon(button.url, base64);
      await this.edit(id, { icon: base64 });
    } catch (e) {
      console.warn('Icon fetch failed for:', button.url, '- using letter avatar');
      // Switch to letter avatar as fallback
      await this.edit(id, { iconType: 'letter', icon: null });
    }
  },

  /**
   * Refresh all icons
   */
  async refreshAllIcons() {
    const loadingToast = Toast.loading('正在刷新图标...');
    let count = 0;
    
    for (const button of this.buttons) {
      if (button.iconType === 'favicon') {
        try {
          await this.refreshIcon(button.id, true);
          count++;
        } catch (e) {
          // Continue with next
        }
      }
    }
    
    Toast.hide(loadingToast);
    Toast.success(`已刷新 ${count} 个图标`);
  },

  /**
   * Filter buttons by search term
   * @param {string} term - Search term
   */
  filter(term) {
    if (!term) {
      document.querySelectorAll('.button-item').forEach(el => {
        el.style.display = '';
      });
      return;
    }

    document.querySelectorAll('.button-item').forEach(el => {
      const id = el.dataset.id;
      const button = this.buttons.find(b => b.id === id);
      if (!button) return;

      const matches = Utils.fuzzyMatch(term, button.title) || 
                      Utils.fuzzyMatch(term, button.url);
      el.style.display = matches ? '' : 'none';
    });
  },

  /**
   * Switch to a different group
   * @param {string} groupId - Group ID
   */
  switchGroup(groupId) {
    this.currentGroupId = groupId;
    this.currentFolderId = null;
    this.clearSelection();
    this.render();
  }
};
