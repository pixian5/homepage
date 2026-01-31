/**
 * Drag and Drop module for Homepage Extension
 */

const DragDrop = {
  // State
  draggedElement: null,
  draggedId: null,
  placeholder: null,
  dropTarget: null,
  
  // Folder creation threshold
  FOLDER_CREATE_DELAY: 800,
  folderCreateTimeout: null,

  /**
   * Initialize drag and drop
   */
  init() {
    const grid = document.getElementById('button-grid');
    if (!grid) return;

    grid.addEventListener('dragstart', (e) => this.handleDragStart(e));
    grid.addEventListener('dragend', (e) => this.handleDragEnd(e));
    grid.addEventListener('dragover', (e) => this.handleDragOver(e));
    grid.addEventListener('dragenter', (e) => this.handleDragEnter(e));
    grid.addEventListener('dragleave', (e) => this.handleDragLeave(e));
    grid.addEventListener('drop', (e) => this.handleDrop(e));
  },

  /**
   * Handle drag start
   * @param {DragEvent} e - Drag event
   */
  handleDragStart(e) {
    const buttonEl = e.target.closest('.button-item');
    if (!buttonEl) return;

    this.draggedElement = buttonEl;
    this.draggedId = buttonEl.dataset.id;
    
    buttonEl.classList.add('dragging');
    
    // Set drag data
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', this.draggedId);
    
    // Create placeholder
    this.placeholder = document.createElement('div');
    this.placeholder.className = 'drop-placeholder';
  },

  /**
   * Handle drag end
   * @param {DragEvent} e - Drag event
   */
  handleDragEnd(e) {
    if (this.draggedElement) {
      this.draggedElement.classList.remove('dragging');
    }
    
    if (this.placeholder && this.placeholder.parentNode) {
      this.placeholder.parentNode.removeChild(this.placeholder);
    }
    
    // Clear folder creation timeout
    if (this.folderCreateTimeout) {
      clearTimeout(this.folderCreateTimeout);
      this.folderCreateTimeout = null;
    }
    
    // Remove drag-over class from all elements
    document.querySelectorAll('.button-item.drag-over').forEach(el => {
      el.classList.remove('drag-over');
    });
    
    this.draggedElement = null;
    this.draggedId = null;
    this.placeholder = null;
    this.dropTarget = null;
  },

  /**
   * Handle drag over
   * @param {DragEvent} e - Drag event
   */
  handleDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    
    const buttonEl = e.target.closest('.button-item');
    const grid = document.getElementById('button-grid');
    
    if (!buttonEl || buttonEl === this.draggedElement) {
      // Insert at end of grid or between items
      if (grid && this.placeholder && !this.placeholder.parentNode) {
        grid.appendChild(this.placeholder);
      }
      return;
    }
    
    // Insert placeholder before or after the hovered button
    const rect = buttonEl.getBoundingClientRect();
    const midX = rect.left + rect.width / 2;
    
    if (e.clientX < midX) {
      buttonEl.parentNode.insertBefore(this.placeholder, buttonEl);
    } else {
      buttonEl.parentNode.insertBefore(this.placeholder, buttonEl.nextSibling);
    }
  },

  /**
   * Handle drag enter
   * @param {DragEvent} e - Drag event
   */
  handleDragEnter(e) {
    const buttonEl = e.target.closest('.button-item');
    if (!buttonEl || buttonEl === this.draggedElement) return;
    
    buttonEl.classList.add('drag-over');
    this.dropTarget = buttonEl;
    
    // Start folder creation timer
    if (!buttonEl.classList.contains('folder')) {
      this.folderCreateTimeout = setTimeout(() => {
        this.createFolderFromDrag(buttonEl);
      }, this.FOLDER_CREATE_DELAY);
    }
  },

  /**
   * Handle drag leave
   * @param {DragEvent} e - Drag event
   */
  handleDragLeave(e) {
    const buttonEl = e.target.closest('.button-item');
    if (!buttonEl) return;
    
    // Check if we're still within the button
    const rect = buttonEl.getBoundingClientRect();
    if (e.clientX >= rect.left && e.clientX <= rect.right &&
        e.clientY >= rect.top && e.clientY <= rect.bottom) {
      return;
    }
    
    buttonEl.classList.remove('drag-over');
    
    // Clear folder creation timeout
    if (this.folderCreateTimeout) {
      clearTimeout(this.folderCreateTimeout);
      this.folderCreateTimeout = null;
    }
  },

  /**
   * Handle drop
   * @param {DragEvent} e - Drag event
   */
  async handleDrop(e) {
    e.preventDefault();
    
    const targetEl = e.target.closest('.button-item');
    
    // Clear folder creation timeout
    if (this.folderCreateTimeout) {
      clearTimeout(this.folderCreateTimeout);
      this.folderCreateTimeout = null;
    }
    
    // If dropping on a folder, move into folder
    if (targetEl && targetEl.classList.contains('folder') && targetEl !== this.draggedElement) {
      const folderId = targetEl.dataset.id;
      await ButtonManager.edit(this.draggedId, { folderId });
      Toast.success('已移入文件夹');
      return;
    }
    
    // Calculate new order
    const grid = document.getElementById('button-grid');
    const buttons = Array.from(grid.querySelectorAll('.button-item:not(.dragging)'));
    
    let newIndex = buttons.length;
    
    if (this.placeholder && this.placeholder.parentNode) {
      const placeholderIndex = Array.from(grid.children).indexOf(this.placeholder);
      if (placeholderIndex !== -1) {
        newIndex = placeholderIndex;
      }
    }
    
    // Build new order
    const newOrder = [];
    const visibleButtons = ButtonManager.getVisibleButtons();
    
    // Remove dragged button from current position
    const filteredButtons = visibleButtons.filter(b => b.id !== this.draggedId);
    
    // Insert at new position
    filteredButtons.splice(newIndex, 0, visibleButtons.find(b => b.id === this.draggedId));
    
    // Update order
    filteredButtons.forEach((b, i) => {
      if (b) {
        newOrder.push({ id: b.id, order: i });
      }
    });
    
    await ButtonManager.updateOrder(newOrder);
  },

  /**
   * Create a folder from dragging button onto another
   * @param {HTMLElement} targetEl - Target button element
   */
  async createFolderFromDrag(targetEl) {
    const targetId = targetEl.dataset.id;
    if (!targetId || targetId === this.draggedId) return;
    
    const draggedButton = ButtonManager.buttons.find(b => b.id === this.draggedId);
    const targetButton = ButtonManager.buttons.find(b => b.id === targetId);
    
    if (!draggedButton || !targetButton) return;
    if (draggedButton.isFolder || targetButton.isFolder) return;
    
    // Create a folder
    const folderId = Utils.generateId();
    const folderName = '新文件夹';
    
    // Update target to become a folder
    await ButtonManager.edit(targetId, {
      isFolder: true,
      title: folderName,
      url: '',
      originalUrl: targetButton.url,
      originalTitle: targetButton.title
    });
    
    // Create buttons for original content
    await ButtonManager.add({
      title: targetButton.originalTitle || targetButton.title,
      url: targetButton.originalUrl || targetButton.url,
      icon: targetButton.icon,
      iconType: targetButton.iconType,
      iconColor: targetButton.iconColor,
      folderId: targetId
    });
    
    // Move dragged button into folder
    await ButtonManager.edit(this.draggedId, { folderId: targetId });
    
    Toast.success('已创建文件夹');
  }
};

// Initialize on load
document.addEventListener('DOMContentLoaded', () => DragDrop.init());
