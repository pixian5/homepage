/**
 * Keyboard navigation module for Homepage Extension
 */

const Keyboard = {
  // Current focused index
  focusedIndex: -1,

  /**
   * Initialize keyboard navigation
   */
  init() {
    document.addEventListener('keydown', (e) => this.handleKeyDown(e));
  },

  /**
   * Handle keydown event
   * @param {KeyboardEvent} e - Keyboard event
   */
  handleKeyDown(e) {
    const settings = App.settings;
    if (!settings?.accessibility?.keyboardNav) return;

    // Skip if in input/textarea
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) {
      return;
    }

    // Skip if modal is open
    if (!document.getElementById('modal-overlay')?.classList.contains('hidden')) {
      return;
    }

    switch (e.key) {
      case 'ArrowUp':
        e.preventDefault();
        this.moveFocus('up');
        break;
      case 'ArrowDown':
        e.preventDefault();
        this.moveFocus('down');
        break;
      case 'ArrowLeft':
        e.preventDefault();
        this.moveFocus('left');
        break;
      case 'ArrowRight':
        e.preventDefault();
        this.moveFocus('right');
        break;
      case 'Enter':
        this.activateFocused();
        break;
      case 'Delete':
      case 'Backspace':
        // Require Shift key for deletion to prevent accidental data loss
        if (settings?.accessibility?.keyboardNav && e.shiftKey) {
          this.deleteFocused();
        }
        break;
      case 'Escape':
        this.clearFocus();
        break;
      case 'Tab':
        // Allow default tab behavior
        break;
      case 'a':
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          ButtonManager.selectAll();
        }
        break;
    }
  },

  /**
   * Move focus in a direction
   * @param {string} direction - 'up', 'down', 'left', 'right'
   */
  moveFocus(direction) {
    const buttons = this.getVisibleButtons();
    if (buttons.length === 0) return;

    const grid = document.getElementById('button-grid');
    const gridStyle = window.getComputedStyle(grid);
    const columns = gridStyle.gridTemplateColumns.split(' ').length;

    if (this.focusedIndex === -1) {
      this.focusedIndex = 0;
    } else {
      const currentRow = Math.floor(this.focusedIndex / columns);
      const currentCol = this.focusedIndex % columns;
      const totalRows = Math.ceil(buttons.length / columns);

      switch (direction) {
        case 'up':
          if (currentRow > 0) {
            this.focusedIndex -= columns;
          }
          break;
        case 'down':
          if (currentRow < totalRows - 1 && this.focusedIndex + columns < buttons.length) {
            this.focusedIndex += columns;
          }
          break;
        case 'left':
          if (this.focusedIndex > 0) {
            this.focusedIndex--;
          }
          break;
        case 'right':
          if (this.focusedIndex < buttons.length - 1) {
            this.focusedIndex++;
          }
          break;
      }
    }

    this.updateFocusVisual(buttons);
  },

  /**
   * Get visible button elements
   * @returns {NodeListOf<Element>}
   */
  getVisibleButtons() {
    // Check if folder is open
    if (!document.getElementById('folder-overlay')?.classList.contains('hidden')) {
      return document.querySelectorAll('#folder-grid .button-item:not([style*="display: none"])');
    }
    return document.querySelectorAll('#button-grid .button-item:not([style*="display: none"])');
  },

  /**
   * Update focus visual
   * @param {NodeListOf<Element>} buttons - Button elements
   */
  updateFocusVisual(buttons) {
    // Remove focus from all
    document.querySelectorAll('.button-item').forEach(el => {
      el.classList.remove('keyboard-focused');
      el.removeAttribute('tabindex');
    });

    // Focus the current one
    if (this.focusedIndex >= 0 && this.focusedIndex < buttons.length) {
      const focusedEl = buttons[this.focusedIndex];
      focusedEl.classList.add('keyboard-focused');
      focusedEl.setAttribute('tabindex', '0');
      focusedEl.focus();
      
      // Show tooltip
      this.showTooltip(focusedEl);
    }
  },

  /**
   * Show tooltip for focused button
   * @param {HTMLElement} element - Button element
   */
  showTooltip(element) {
    const id = element.dataset.id;
    const button = ButtonManager.buttons.find(b => b.id === id);
    if (!button) return;

    // Remove existing tooltip
    const existingTooltip = document.querySelector('.tooltip');
    if (existingTooltip) {
      existingTooltip.remove();
    }

    // Create tooltip
    const tooltip = document.createElement('div');
    tooltip.className = 'tooltip';
    tooltip.innerHTML = `
      <div class="tooltip-title">${Utils.escapeHtml(button.title || '无标题')}</div>
      <div class="tooltip-url">${Utils.escapeHtml(button.url || '')}</div>
    `;

    document.body.appendChild(tooltip);

    // Position tooltip
    const rect = element.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();
    
    let left = rect.left + (rect.width - tooltipRect.width) / 2;
    let top = rect.bottom + 8;

    // Keep within viewport
    if (left < 10) left = 10;
    if (left + tooltipRect.width > window.innerWidth - 10) {
      left = window.innerWidth - tooltipRect.width - 10;
    }
    if (top + tooltipRect.height > window.innerHeight - 10) {
      top = rect.top - tooltipRect.height - 8;
    }

    tooltip.style.left = left + 'px';
    tooltip.style.top = top + 'px';

    // Remove tooltip after a delay or on any key press
    const removeTooltip = () => {
      tooltip.remove();
      document.removeEventListener('keydown', removeTooltip);
    };
    
    setTimeout(() => {
      if (document.body.contains(tooltip)) {
        tooltip.remove();
      }
    }, 3000);
  },

  /**
   * Activate the focused button
   */
  activateFocused() {
    const buttons = this.getVisibleButtons();
    if (this.focusedIndex >= 0 && this.focusedIndex < buttons.length) {
      const id = buttons[this.focusedIndex].dataset.id;
      const button = ButtonManager.buttons.find(b => b.id === id);
      if (button) {
        if (button.isFolder) {
          Folders.open(button.id, button.title);
        } else {
          ButtonManager.openButton(button);
        }
      }
    }
  },

  /**
   * Delete the focused button
   */
  deleteFocused() {
    const buttons = this.getVisibleButtons();
    if (this.focusedIndex >= 0 && this.focusedIndex < buttons.length) {
      const id = buttons[this.focusedIndex].dataset.id;
      ButtonManager.delete(id);
      
      // Adjust focus index
      if (this.focusedIndex >= buttons.length - 1) {
        this.focusedIndex = Math.max(0, buttons.length - 2);
      }
    }
  },

  /**
   * Clear focus
   */
  clearFocus() {
    this.focusedIndex = -1;
    document.querySelectorAll('.button-item').forEach(el => {
      el.classList.remove('keyboard-focused');
    });
    
    // Remove tooltip
    const tooltip = document.querySelector('.tooltip');
    if (tooltip) {
      tooltip.remove();
    }
  }
};

// Initialize on load
document.addEventListener('DOMContentLoaded', () => Keyboard.init());
