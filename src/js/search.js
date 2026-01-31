/**
 * Search module for Homepage Extension
 */

const Search = {
  // Search engines
  ENGINES: {
    google: 'https://www.google.com/search?q=',
    bing: 'https://www.bing.com/search?q=',
    baidu: 'https://www.baidu.com/s?wd=',
    duckduckgo: 'https://duckduckgo.com/?q='
  },

  // Elements
  input: null,
  engineBtn: null,

  /**
   * Initialize search
   */
  init() {
    this.input = document.getElementById('search-input');
    this.engineBtn = document.getElementById('search-engine-btn');
    
    if (!this.input) return;

    this.setupEventListeners();
  },

  /**
   * Setup event listeners
   */
  setupEventListeners() {
    // Input change - filter buttons
    this.input.addEventListener('input', Utils.debounce((e) => {
      this.filter(e.target.value);
    }, 200));

    // Enter key - search or use engine
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        this.handleEnter();
      } else if (e.key === 'Escape') {
        this.clear();
        this.input.blur();
      }
    });

    // Engine button click
    this.engineBtn?.addEventListener('click', () => {
      if (this.input.value.trim()) {
        this.searchWithEngine(this.input.value);
      }
    });

    // Focus shortcut (Ctrl/Cmd + K)
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        this.input.focus();
        this.input.select();
      }
    });
  },

  /**
   * Filter buttons by search term
   * @param {string} term - Search term
   */
  filter(term) {
    ButtonManager.filter(term);
    
    // Also filter folder contents if open
    if (Folders.currentFolderId) {
      const folderGrid = document.getElementById('folder-grid');
      if (folderGrid) {
        folderGrid.querySelectorAll('.button-item').forEach(el => {
          const id = el.dataset.id;
          const button = ButtonManager.buttons.find(b => b.id === id);
          if (!button) return;

          const matches = !term || 
                          Utils.fuzzyMatch(term, button.title) || 
                          Utils.fuzzyMatch(term, button.url);
          el.style.display = matches ? '' : 'none';
        });
      }
    }
  },

  /**
   * Handle enter key
   */
  handleEnter() {
    const term = this.input.value.trim();
    if (!term) return;

    const settings = App.settings;
    
    // Check if any button matches exactly
    const exactMatch = ButtonManager.buttons.find(b => 
      b.title.toLowerCase() === term.toLowerCase() ||
      b.url.toLowerCase().includes(term.toLowerCase())
    );
    
    if (exactMatch) {
      ButtonManager.openButton(exactMatch);
      this.clear();
      return;
    }

    // Use search engine if integration is enabled
    if (settings.search?.engineIntegration) {
      this.searchWithEngine(term);
    }
  },

  /**
   * Search with configured search engine
   * @param {string} term - Search term
   */
  searchWithEngine(term) {
    const settings = App.settings;
    const engine = settings.search?.searchEngine || 'google';
    const baseUrl = this.ENGINES[engine] || this.ENGINES.google;
    
    const url = baseUrl + encodeURIComponent(term);
    
    const openMode = settings.openMode || 'new-tab';
    if (openMode === 'current') {
      window.location.href = url;
    } else {
      window.open(url, '_blank');
    }
    
    this.clear();
  },

  /**
   * Clear search
   */
  clear() {
    this.input.value = '';
    ButtonManager.filter('');
  },

  /**
   * Toggle visibility based on settings
   * @param {boolean} visible - Whether to show search
   */
  setVisible(visible) {
    const wrapper = document.querySelector('.search-wrapper');
    if (wrapper) {
      wrapper.style.display = visible ? '' : 'none';
    }
  }
};

// Initialize on load
document.addEventListener('DOMContentLoaded', () => Search.init());
