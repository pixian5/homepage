/**
 * Groups module for Homepage Extension
 */

const Groups = {
  // State
  groups: [],
  activeGroupId: 'default',
  
  // Elements
  tabsContainer: null,

  /**
   * Initialize groups
   */
  async init() {
    this.tabsContainer = document.getElementById('groups-tabs');
    
    await this.load();
    this.render();
    this.setupEventListeners();
  },

  /**
   * Load groups from storage
   */
  async load() {
    this.groups = await Storage.getGroups();
    
    // Ensure default group exists
    if (!this.groups.find(g => g.id === 'default')) {
      this.groups.unshift({ id: 'default', name: '默认', order: 0 });
      await Storage.saveGroups(this.groups);
    }

    // Check if recent view is enabled in settings
    const settings = App.settings || await Storage.getSettings();
    
    // Remove any existing virtual recent group first
    this.groups = this.groups.filter(g => g.id !== 'recent');
    
    if (settings?.showRecentView !== false) {
      // Add "最近浏览" as a virtual group at the top
      this.groups.unshift({ id: 'recent', name: '最近浏览', order: -1, virtual: true });
    }
  },

  /**
   * Setup event listeners
   */
  setupEventListeners() {
    // Add group button
    const addBtn = document.getElementById('btn-add-group');
    if (addBtn) {
      addBtn.addEventListener('click', () => this.showAddDialog());
    }

    // Tab container click handling
    this.tabsContainer.addEventListener('click', (e) => {
      const tab = e.target.closest('.group-tab');
      if (!tab) return;
      
      const id = tab.dataset.id;
      this.switchTo(id);
    });

    // Tab context menu
    this.tabsContainer.addEventListener('contextmenu', (e) => {
      const tab = e.target.closest('.group-tab');
      if (!tab) return;
      
      e.preventDefault();
      const id = tab.dataset.id;
      this.showContextMenu(e.clientX, e.clientY, id);
    });

    // Tab double-click for rename
    this.tabsContainer.addEventListener('dblclick', (e) => {
      const tab = e.target.closest('.group-tab');
      if (!tab) return;
      
      const id = tab.dataset.id;
      if (id === 'default') return; // Can't rename default
      
      this.startRename(id);
    });

    // Mouse wheel to switch groups
    this.tabsContainer.addEventListener('wheel', (e) => {
      const settings = App.settings;
      if (!settings?.accessibility?.keyboardNav) return;
      
      e.preventDefault();
      const currentIndex = this.groups.findIndex(g => g.id === this.activeGroupId);
      
      if (e.deltaY > 0) {
        // Scroll down - next group
        const nextIndex = Math.min(currentIndex + 1, this.groups.length - 1);
        this.switchTo(this.groups[nextIndex].id);
      } else {
        // Scroll up - previous group
        const prevIndex = Math.max(currentIndex - 1, 0);
        this.switchTo(this.groups[prevIndex].id);
      }
    });
  },

  /**
   * Render group tabs
   */
  render() {
    this.tabsContainer.innerHTML = '';
    
    // Sort by order
    const sorted = [...this.groups].sort((a, b) => (a.order || 0) - (b.order || 0));
    
    sorted.forEach(group => {
      const tab = document.createElement('button');
      tab.className = 'group-tab';
      tab.dataset.id = group.id;
      tab.textContent = group.name;
      
      if (group.id === this.activeGroupId) {
        tab.classList.add('active');
      }
      
      this.tabsContainer.appendChild(tab);
    });
  },

  /**
   * Switch to a group
   * @param {string} groupId - Group ID
   */
  switchTo(groupId) {
    this.activeGroupId = groupId;
    ButtonManager.switchGroup(groupId);
    this.render();
  },

  /**
   * Show add group dialog
   */
  showAddDialog() {
    Modals.show({
      title: '添加分组',
      content: `
        <div class="form-group">
          <label class="form-label">分组名称</label>
          <input type="text" id="group-name-input" class="form-input" placeholder="输入分组名称" maxlength="20">
        </div>
      `,
      buttons: [
        { label: '取消', type: 'secondary', action: () => Modals.hide() },
        { label: '添加', type: 'primary', action: () => this.add() }
      ],
      onShow: () => {
        const input = document.getElementById('group-name-input');
        input.focus();
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            this.add();
          }
        });
      }
    });
  },

  /**
   * Add a new group
   */
  async add() {
    const input = document.getElementById('group-name-input');
    const name = input?.value?.trim();
    
    if (!name) {
      Toast.error('请输入分组名称');
      return;
    }
    
    // Check for duplicate names
    if (this.groups.some(g => g.name === name)) {
      Toast.error('分组名称已存在');
      return;
    }
    
    const group = await Storage.addGroup({ name });
    this.groups.push(group);
    this.render();
    Modals.hide();
    Toast.success('分组添加成功');
  },

  /**
   * Start inline rename
   * @param {string} id - Group ID
   */
  startRename(id) {
    const group = this.groups.find(g => g.id === id);
    if (!group) return;
    
    const tab = this.tabsContainer.querySelector(`[data-id="${id}"]`);
    if (!tab) return;
    
    tab.classList.add('editing');
    
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'group-tab-input';
    input.value = group.name;
    input.maxLength = 20;
    
    tab.textContent = '';
    tab.appendChild(input);
    input.focus();
    input.select();
    
    const finishRename = async () => {
      const newName = input.value.trim();
      tab.classList.remove('editing');
      
      if (newName && newName !== group.name) {
        // Check for duplicate
        if (this.groups.some(g => g.id !== id && g.name === newName)) {
          Toast.error('分组名称已存在');
          tab.textContent = group.name;
          return;
        }
        
        await this.rename(id, newName);
      } else {
        tab.textContent = group.name;
      }
    };
    
    input.addEventListener('blur', finishRename);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        input.blur();
      } else if (e.key === 'Escape') {
        input.value = group.name;
        input.blur();
      }
    });
  },

  /**
   * Rename a group
   * @param {string} id - Group ID
   * @param {string} newName - New name
   */
  async rename(id, newName) {
    const group = this.groups.find(g => g.id === id);
    if (!group) return;
    
    await Storage.updateGroup(id, { name: newName });
    group.name = newName;
    this.render();
    Toast.success('分组已重命名');
  },

  /**
   * Show context menu for group
   * @param {number} x - X position
   * @param {number} y - Y position
   * @param {string} id - Group ID
   */
  showContextMenu(x, y, id) {
    const group = this.groups.find(g => g.id === id);
    if (!group) return;
    
    const items = [
      { label: '重命名', action: () => this.startRename(id), disabled: id === 'default' },
      { label: '删除', action: () => this.confirmDelete(id), danger: true, disabled: id === 'default' }
    ];
    
    ContextMenu.showCustom(x, y, items);
  },

  /**
   * Confirm delete group
   * @param {string} id - Group ID
   */
  confirmDelete(id) {
    if (id === 'default') return;
    
    const group = this.groups.find(g => g.id === id);
    if (!group) return;
    
    const buttonCount = ButtonManager.buttons.filter(b => b.groupId === id).length;
    
    Modals.confirm({
      title: '删除分组',
      message: buttonCount > 0 
        ? `确定要删除分组「${group.name}」吗？其中的 ${buttonCount} 个按钮将移至默认分组。`
        : `确定要删除分组「${group.name}」吗？`,
      confirmLabel: '删除',
      confirmType: 'danger',
      onConfirm: () => this.delete(id)
    });
  },

  /**
   * Delete a group
   * @param {string} id - Group ID
   */
  async delete(id) {
    if (id === 'default') return;
    
    await Storage.deleteGroup(id);
    this.groups = this.groups.filter(g => g.id !== id);
    
    // Switch to default if current group was deleted
    if (this.activeGroupId === id) {
      this.switchTo('default');
    } else {
      this.render();
    }
    
    await ButtonManager.load();
    Toast.success('分组已删除');
  },

  /**
   * Reorder groups
   * @param {Array<{id: string, order: number}>} newOrder - New order
   */
  async reorder(newOrder) {
    const orderMap = new Map(newOrder.map(o => [o.id, o.order]));
    
    this.groups.forEach(g => {
      if (orderMap.has(g.id)) {
        g.order = orderMap.get(g.id);
      }
    });
    
    await Storage.saveGroups(this.groups);
    this.render();
  }
};

// Initialize on load
document.addEventListener('DOMContentLoaded', () => Groups.init());
