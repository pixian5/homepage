/**
 * Popup script for Homepage Extension
 * Handles adding current tab to a group
 */

(async function() {
  const loadingEl = document.getElementById('loading');
  const contentEl = document.getElementById('content');
  const pageIconEl = document.getElementById('page-icon');
  const iconLetterEl = document.getElementById('icon-letter');
  const pageTitleEl = document.getElementById('page-title');
  const pageUrlEl = document.getElementById('page-url');
  const groupSelectEl = document.getElementById('group-select');
  const btnAddEl = document.getElementById('btn-add');
  const messageEl = document.getElementById('message');

  let currentTab = null;

  // Storage keys (must match storage.js)
  const KEYS = {
    BUTTONS: 'homepage_buttons',
    GROUPS: 'homepage_groups',
    SETTINGS: 'homepage_settings'
  };

  /**
   * Get storage API
   */
  function getStorageApi() {
    if (typeof chrome !== 'undefined' && chrome.storage) {
      return chrome.storage;
    }
    if (typeof browser !== 'undefined' && browser.storage) {
      return browser.storage;
    }
    return null;
  }

  /**
   * Generate a unique ID
   */
  function generateId() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  /**
   * Get first letter of string
   */
  function getFirstLetter(str) {
    if (!str) return '?';
    return str.trim().charAt(0).toUpperCase() || '?';
  }

  /**
   * Get domain from URL
   */
  function getDomain(url) {
    try {
      return new URL(url).hostname;
    } catch (e) {
      return '';
    }
  }

  /**
   * Get favicon URL
   */
  function getFaviconUrl(url) {
    try {
      const parsed = new URL(url);
      return `${parsed.protocol}//${parsed.hostname}/favicon.ico`;
    } catch (e) {
      return '';
    }
  }

  /**
   * String to color
   */
  function stringToColor(str) {
    if (!str) return '#666666';
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    const colors = [
      '#e74c3c', '#e91e63', '#9c27b0', '#673ab7',
      '#3f51b5', '#2196f3', '#03a9f4', '#00bcd4',
      '#009688', '#4caf50', '#8bc34a', '#cddc39',
      '#ffc107', '#ff9800', '#ff5722', '#795548'
    ];
    return colors[Math.abs(hash) % colors.length];
  }

  /**
   * Get groups from storage
   */
  async function getGroups() {
    const api = getStorageApi();
    if (!api) return [{ id: 'default', name: '默认', order: 0 }];
    
    try {
      const result = await api.local.get(KEYS.GROUPS);
      return result[KEYS.GROUPS] || [{ id: 'default', name: '默认', order: 0 }];
    } catch (e) {
      return [{ id: 'default', name: '默认', order: 0 }];
    }
  }

  /**
   * Get buttons from storage
   */
  async function getButtons() {
    const api = getStorageApi();
    if (!api) return [];
    
    try {
      const result = await api.local.get(KEYS.BUTTONS);
      return result[KEYS.BUTTONS] || [];
    } catch (e) {
      return [];
    }
  }

  /**
   * Save buttons to storage
   */
  async function saveButtons(buttons) {
    const api = getStorageApi();
    if (!api) throw new Error('Storage not available');
    
    await api.local.set({ [KEYS.BUTTONS]: buttons });
  }

  /**
   * Show message
   */
  function showMessage(text, type = 'success') {
    messageEl.textContent = text;
    messageEl.className = `message ${type}`;
    messageEl.style.display = 'block';
  }

  /**
   * Initialize popup
   */
  async function init() {
    try {
      // Get current tab
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      currentTab = tab;

      if (!tab || !tab.url) {
        showMessage('无法获取当前页面信息', 'error');
        loadingEl.style.display = 'none';
        messageEl.style.display = 'block';
        return;
      }

      // Check if it's a valid URL (not chrome:// or extension pages)
      if (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || 
          tab.url.startsWith('about:') || tab.url.startsWith('moz-extension://')) {
        showMessage('无法添加浏览器内部页面', 'error');
        loadingEl.style.display = 'none';
        messageEl.style.display = 'block';
        return;
      }

      // Set page info
      pageTitleEl.textContent = tab.title || '无标题';
      pageUrlEl.textContent = getDomain(tab.url);
      iconLetterEl.textContent = getFirstLetter(tab.title);
      pageIconEl.style.backgroundColor = stringToColor(tab.title);

      // Try to load favicon
      if (tab.favIconUrl) {
        const img = document.createElement('img');
        img.src = tab.favIconUrl;
        img.onload = () => {
          pageIconEl.innerHTML = '';
          pageIconEl.appendChild(img);
        };
      }

      // Load groups
      const groups = await getGroups();
      groupSelectEl.innerHTML = '';
      groups.sort((a, b) => (a.order || 0) - (b.order || 0));
      groups.forEach(group => {
        const option = document.createElement('option');
        option.value = group.id;
        option.textContent = group.name;
        groupSelectEl.appendChild(option);
      });

      // Show content
      loadingEl.style.display = 'none';
      contentEl.style.display = 'block';

      // Setup add button (remove previous listener if any to prevent duplicates)
      btnAddEl.removeEventListener('click', handleAdd);
      btnAddEl.addEventListener('click', handleAdd);

    } catch (e) {
      console.error('Popup init error:', e);
      showMessage('初始化失败: ' + e.message, 'error');
      loadingEl.style.display = 'none';
      messageEl.style.display = 'block';
    }
  }

  /**
   * Handle add button click
   */
  async function handleAdd() {
    if (!currentTab) return;

    btnAddEl.disabled = true;
    btnAddEl.textContent = '添加中...';

    try {
      const buttons = await getButtons();
      
      // Check if URL already exists
      const exists = buttons.some(b => b.url === currentTab.url);
      if (exists) {
        showMessage('此页面已经添加过了', 'error');
        btnAddEl.disabled = false;
        btnAddEl.textContent = '添加到主页';
        return;
      }

      // Create new button
      const newButton = {
        id: generateId(),
        title: currentTab.title || getDomain(currentTab.url),
        url: currentTab.url,
        icon: getFaviconUrl(currentTab.url),
        iconType: 'favicon',
        iconColor: stringToColor(currentTab.title),
        groupId: groupSelectEl.value,
        folderId: null,
        order: buttons.length,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };

      buttons.push(newButton);
      await saveButtons(buttons);

      // Notify all tabs to refresh
      if (chrome.runtime && chrome.runtime.sendMessage) {
        try {
          chrome.runtime.sendMessage({ 
            type: 'BUTTON_ADDED', 
            button: newButton 
          });
        } catch (e) {
          console.log('Could not send message to tabs:', e);
        }
      }

      showMessage('已添加到主页！', 'success');
      btnAddEl.textContent = '已添加';

      // Close popup after a delay
      setTimeout(() => {
        window.close();
      }, 1000);

    } catch (e) {
      console.error('Add error:', e);
      showMessage('添加失败: ' + e.message, 'error');
      btnAddEl.disabled = false;
      btnAddEl.textContent = '添加到主页';
    }
  }

  // Initialize
  init();
})();
