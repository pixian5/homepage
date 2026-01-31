/**
 * Main App module for Homepage Extension
 */

const App = {
  // Settings
  settings: null,

  /**
   * Initialize the application
   */
  async init() {
    try {
      // Load settings
      this.settings = await Storage.getSettings();
      
      // Apply theme
      this.applyTheme();
      
      // Apply grid settings
      this.applyGridSettings();
      
      // Apply background
      await this.applyBackground();
      
      // Initialize modules
      await ButtonManager.init();
      DragDrop.init();
      
      // Setup toolbar events
      this.setupToolbarEvents();
      
      // Apply search visibility
      Search.setVisible(this.settings.search?.enabled !== false);
      
      // Listen for system theme changes
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        if (this.settings.theme === 'system') {
          this.applyTheme();
        }
      });

      console.log('Homepage Extension initialized');
    } catch (e) {
      console.error('Failed to initialize:', e);
      Toast.error('初始化失败');
    }
  },

  /**
   * Apply theme based on settings
   */
  applyTheme() {
    let theme = this.settings.theme || 'system';
    
    if (theme === 'system') {
      theme = Utils.prefersDarkMode() ? 'dark' : 'light';
    }
    
    document.documentElement.setAttribute('data-theme', theme);
  },

  /**
   * Apply grid settings
   */
  applyGridSettings() {
    const grid = this.settings.grid || {};
    const root = document.documentElement;
    
    // Set columns
    if (grid.fixed) {
      root.style.setProperty('--grid-columns', grid.columns || 8);
    } else {
      document.getElementById('button-grid')?.classList.add('adaptive');
    }
    
    // Apply density
    switch (grid.density) {
      case 'compact':
        root.style.setProperty('--button-size', '60px');
        root.style.setProperty('--button-gap', '8px');
        break;
      case 'loose':
        root.style.setProperty('--button-size', '100px');
        root.style.setProperty('--button-gap', '24px');
        break;
      default: // standard
        root.style.setProperty('--button-size', '80px');
        root.style.setProperty('--button-gap', '16px');
    }
  },

  /**
   * Apply background settings
   */
  async applyBackground() {
    const bgElement = document.getElementById('background');
    if (!bgElement) return;

    const result = await BingWallpaper.apply(bgElement, this.settings);
    
    // Show toast for Bing wallpaper status if enabled
    if (this.settings.background?.type === 'bing' && 
        this.settings.background?.showLoadingToast !== false) {
      if (!result.success && result.error) {
        Toast.warning(result.error);
      }
    }
  },

  /**
   * Setup toolbar event listeners
   */
  setupToolbarEvents() {
    // Add button
    document.getElementById('btn-add')?.addEventListener('click', () => {
      Modals.showButtonForm();
    });

    // Batch delete
    document.getElementById('btn-batch-delete')?.addEventListener('click', () => {
      if (ButtonManager.selectedButtons.size > 0) {
        Modals.confirm({
          title: '批量删除',
          message: `确定要删除选中的 ${ButtonManager.selectedButtons.size} 个按钮吗？`,
          confirmLabel: '删除',
          confirmType: 'danger',
          onConfirm: () => ButtonManager.deleteSelected()
        });
      } else {
        ButtonManager.enterSelectionMode();
        Toast.info('请选择要删除的按钮，然后再次点击删除');
      }
    });

    // Open mode toggle
    document.getElementById('btn-open-mode')?.addEventListener('click', () => {
      this.cycleOpenMode();
    });

    // Search button (toggle search visibility)
    document.getElementById('btn-search')?.addEventListener('click', () => {
      const searchWrapper = document.querySelector('.search-wrapper');
      const input = document.getElementById('search-input');
      
      if (searchWrapper.style.display === 'none') {
        searchWrapper.style.display = '';
        input?.focus();
      } else {
        input?.focus();
        input?.select();
      }
    });

    // Settings
    document.getElementById('btn-settings')?.addEventListener('click', () => {
      Settings.show();
    });
  },

  /**
   * Cycle through open modes
   */
  cycleOpenMode() {
    const modes = ['current', 'new-tab', 'background'];
    const labels = {
      'current': '当前标签页',
      'new-tab': '新标签页',
      'background': '后台新标签页'
    };
    
    const currentIndex = modes.indexOf(this.settings.openMode || 'new-tab');
    const nextIndex = (currentIndex + 1) % modes.length;
    const newMode = modes[nextIndex];
    
    this.settings = { ...this.settings, openMode: newMode };
    Storage.saveSettings({ openMode: newMode });
    
    Toast.info(`打开方式: ${labels[newMode]}`);
    
    // Update button tooltip
    const btn = document.getElementById('btn-open-mode');
    if (btn) {
      btn.title = `打开方式: ${labels[newMode]}`;
    }
  }
};

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => App.init());
