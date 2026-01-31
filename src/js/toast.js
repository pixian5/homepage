/**
 * Toast notification module for Homepage Extension
 */

const Toast = {
  // Default duration in ms
  DEFAULT_DURATION: 3000,
  UNDO_DURATION: 5000,
  
  // Container element
  container: null,
  
  // Active toasts
  activeToasts: new Map(),

  /**
   * Initialize toast container
   */
  init() {
    this.container = document.getElementById('toast-container');
    if (!this.container) {
      this.container = document.createElement('div');
      this.container.id = 'toast-container';
      this.container.className = 'toast-container';
      document.body.appendChild(this.container);
    }
  },

  /**
   * Show a toast notification
   * @param {object} options - Toast options
   * @returns {string} Toast ID
   */
  show(options) {
    if (!this.container) this.init();
    
    const id = Utils.generateId();
    const {
      message,
      type = 'info', // 'info', 'success', 'error', 'warning'
      duration = this.DEFAULT_DURATION,
      action = null, // { label: 'Undo', callback: fn }
      closable = true
    } = options;

    // Create toast element
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.dataset.id = id;

    // Message
    const messageEl = document.createElement('span');
    messageEl.className = 'toast-message';
    messageEl.textContent = message;
    toast.appendChild(messageEl);

    // Action button
    if (action) {
      const actionBtn = document.createElement('button');
      actionBtn.className = 'toast-action';
      actionBtn.textContent = action.label;
      actionBtn.onclick = () => {
        action.callback();
        this.hide(id);
      };
      toast.appendChild(actionBtn);
    }

    // Close button
    if (closable) {
      const closeBtn = document.createElement('button');
      closeBtn.className = 'toast-close';
      closeBtn.innerHTML = '×';
      closeBtn.onclick = () => this.hide(id);
      toast.appendChild(closeBtn);
    }

    // Add to container
    this.container.appendChild(toast);

    // Set up auto-hide
    let timeout = null;
    if (duration > 0) {
      timeout = setTimeout(() => {
        this.hide(id);
      }, duration);
    }

    // Store reference
    this.activeToasts.set(id, { element: toast, timeout });

    return id;
  },

  /**
   * Hide a toast
   * @param {string} id - Toast ID
   */
  hide(id) {
    const toast = this.activeToasts.get(id);
    if (!toast) return;

    // Clear timeout
    if (toast.timeout) {
      clearTimeout(toast.timeout);
    }

    // Animate out
    toast.element.classList.add('exiting');
    
    setTimeout(() => {
      if (toast.element.parentNode) {
        toast.element.parentNode.removeChild(toast.element);
      }
      this.activeToasts.delete(id);
    }, 300);
  },

  /**
   * Hide all toasts
   */
  hideAll() {
    this.activeToasts.forEach((_, id) => this.hide(id));
  },

  /**
   * Show success toast
   * @param {string} message - Message to show
   * @param {number} duration - Duration in ms
   */
  success(message, duration = this.DEFAULT_DURATION) {
    return this.show({ message, type: 'success', duration });
  },

  /**
   * Show error toast
   * @param {string} message - Message to show
   * @param {number} duration - Duration in ms
   */
  error(message, duration = this.DEFAULT_DURATION) {
    return this.show({ message, type: 'error', duration });
  },

  /**
   * Show warning toast
   * @param {string} message - Message to show
   * @param {number} duration - Duration in ms
   */
  warning(message, duration = this.DEFAULT_DURATION) {
    return this.show({ message, type: 'warning', duration });
  },

  /**
   * Show info toast
   * @param {string} message - Message to show
   * @param {number} duration - Duration in ms
   */
  info(message, duration = this.DEFAULT_DURATION) {
    return this.show({ message, type: 'info', duration });
  },

  /**
   * Show undo toast (for delete operations)
   * @param {string} message - Message to show
   * @param {Function} undoCallback - Callback for undo action
   * @returns {string} Toast ID
   */
  undo(message, undoCallback) {
    return this.show({
      message,
      type: 'info',
      duration: this.UNDO_DURATION,
      action: {
        label: '撤销',
        callback: undoCallback
      }
    });
  },

  /**
   * Show loading toast (no auto-hide)
   * @param {string} message - Message to show
   * @returns {string} Toast ID
   */
  loading(message) {
    return this.show({
      message,
      type: 'info',
      duration: 0,
      closable: false
    });
  },

  /**
   * Update a toast message
   * @param {string} id - Toast ID
   * @param {string} message - New message
   */
  update(id, message) {
    const toast = this.activeToasts.get(id);
    if (toast) {
      const messageEl = toast.element.querySelector('.toast-message');
      if (messageEl) {
        messageEl.textContent = message;
      }
    }
  }
};

// Initialize on load
document.addEventListener('DOMContentLoaded', () => Toast.init());
