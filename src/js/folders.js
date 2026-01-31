/**
 * Folders module for Homepage Extension
 */

const Folders = {
  // State
  currentFolderId: null,
  
  // Elements
  overlay: null,
  gridElement: null,
  titleElement: null,

  /**
   * Initialize folders
   */
  init() {
    this.overlay = document.getElementById('folder-overlay');
    this.gridElement = document.getElementById('folder-grid');
    this.titleElement = document.getElementById('folder-title');
    
    this.setupEventListeners();
  },

  /**
   * Setup event listeners
   */
  setupEventListeners() {
    // Close button
    const closeBtn = document.getElementById('folder-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => this.close());
    }

    // Click outside to close
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) {
        this.close();
      }
    });

    // Escape key to close
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.currentFolderId) {
        this.close();
      }
    });

    // Grid click handling
    this.gridElement.addEventListener('click', (e) => this.handleGridClick(e));
    this.gridElement.addEventListener('contextmenu', (e) => this.handleContextMenu(e));

    // Title click to rename
    this.titleElement.addEventListener('dblclick', () => this.startRename());
  },

  /**
   * Open a folder
   * @param {string} folderId - Folder ID
   * @param {string} title - Folder title
   */
  open(folderId, title) {
    this.currentFolderId = folderId;
    this.titleElement.textContent = title || '文件夹';
    this.render();
    this.overlay.classList.remove('hidden');
    
    // Focus first button for accessibility
    const firstButton = this.gridElement.querySelector('.button-item');
    if (firstButton) {
      firstButton.focus();
    }
  },

  /**
   * Close folder view
   */
  close() {
    this.currentFolderId = null;
    this.overlay.classList.add('hidden');
  },

  /**
   * Render folder contents
   */
  render() {
    if (!this.currentFolderId) return;
    
    const buttons = ButtonManager.buttons.filter(b => b.folderId === this.currentFolderId);
    buttons.sort((a, b) => (a.order || 0) - (b.order || 0));
    
    this.gridElement.innerHTML = '';
    
    if (buttons.length === 0) {
      this.gridElement.innerHTML = '<p style="color: var(--text-muted); text-align: center; padding: 20px;">文件夹为空</p>';
      return;
    }
    
    buttons.forEach(button => {
      const buttonEl = ButtonManager.createButtonElement(button);
      this.gridElement.appendChild(buttonEl);
    });
  },

  /**
   * Handle grid click
   * @param {Event} e - Click event
   */
  handleGridClick(e) {
    const buttonEl = e.target.closest('.button-item');
    if (!buttonEl) return;
    
    const id = buttonEl.dataset.id;
    const button = ButtonManager.buttons.find(b => b.id === id);
    if (!button) return;

    // Open the link
    ButtonManager.openButton(button);
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
    const button = ButtonManager.buttons.find(b => b.id === id);
    if (!button) return;

    ContextMenu.show(e.clientX, e.clientY, button, true);
  },

  /**
   * Start folder rename
   */
  startRename() {
    if (!this.currentFolderId) return;
    
    const folder = ButtonManager.buttons.find(b => b.id === this.currentFolderId);
    if (!folder) return;
    
    const currentTitle = folder.title || '文件夹';
    
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'form-input';
    input.value = currentTitle;
    input.style.maxWidth = '200px';
    
    this.titleElement.textContent = '';
    this.titleElement.appendChild(input);
    input.focus();
    input.select();
    
    const finishRename = async () => {
      const newTitle = input.value.trim() || '文件夹';
      this.titleElement.textContent = newTitle;
      
      if (newTitle !== currentTitle) {
        await ButtonManager.edit(this.currentFolderId, { title: newTitle });
        Toast.success('文件夹已重命名');
      }
    };
    
    input.addEventListener('blur', finishRename);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        input.blur();
      } else if (e.key === 'Escape') {
        input.value = currentTitle;
        input.blur();
      }
    });
  },

  /**
   * Move button out of folder
   * @param {string} buttonId - Button ID
   */
  async moveOut(buttonId) {
    await ButtonManager.edit(buttonId, { folderId: null });
    this.render();
    ButtonManager.render();
    Toast.success('已移出文件夹');
  },

  /**
   * Delete folder and move contents out
   * @param {string} folderId - Folder ID
   */
  async dissolve(folderId) {
    const folder = ButtonManager.buttons.find(b => b.id === folderId);
    if (!folder || !folder.isFolder) return;
    
    // Move all buttons out of folder
    const children = ButtonManager.buttons.filter(b => b.folderId === folderId);
    for (const child of children) {
      await Storage.updateButton(child.id, { folderId: null });
    }
    
    // Delete the folder
    await Storage.deleteButton(folderId);
    
    await ButtonManager.load();
    this.close();
    Toast.success('文件夹已解散');
  },

  /**
   * Confirm dissolve folder
   * @param {string} folderId - Folder ID
   */
  confirmDissolve(folderId) {
    const folder = ButtonManager.buttons.find(b => b.id === folderId);
    if (!folder) return;
    
    const childCount = ButtonManager.buttons.filter(b => b.folderId === folderId).length;
    
    Modals.confirm({
      title: '解散文件夹',
      message: `确定要解散文件夹「${folder.title || '文件夹'}」吗？其中的 ${childCount} 个按钮将移至主面板。`,
      confirmLabel: '解散',
      confirmType: 'danger',
      onConfirm: () => this.dissolve(folderId)
    });
  }
};

// Initialize on load
document.addEventListener('DOMContentLoaded', () => Folders.init());
