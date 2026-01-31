/**
 * Utility functions for Homepage Extension
 */

const Utils = {
  /**
   * Generate a unique ID
   * @returns {string} UUID
   */
  generateId() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  },

  /**
   * Validate URL format
   * @param {string} url - URL to validate
   * @returns {object} { valid: boolean, url: string, error: string }
   */
  validateUrl(url) {
    if (!url || typeof url !== 'string') {
      return { valid: false, url: '', error: 'URL不能为空' };
    }

    url = url.trim();

    // Check if URL has a protocol
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)) {
      // Try adding https://
      url = 'https://' + url;
    }

    try {
      const parsed = new URL(url);
      // Only allow http, https, ftp, mailto protocols
      const allowedProtocols = ['http:', 'https:', 'ftp:', 'mailto:'];
      if (!allowedProtocols.includes(parsed.protocol)) {
        return { valid: false, url: '', error: '不支持的协议类型' };
      }
      return { valid: true, url: parsed.href, error: '' };
    } catch (e) {
      return { valid: false, url: '', error: 'URL格式无效' };
    }
  },

  /**
   * Get domain from URL
   * @param {string} url - Full URL
   * @returns {string} Domain
   */
  getDomain(url) {
    try {
      const parsed = new URL(url);
      return parsed.hostname;
    } catch (e) {
      return '';
    }
  },

  /**
   * Get favicon URL for a given URL
   * @param {string} url - Website URL
   * @returns {string} Favicon URL
   */
  getFaviconUrl(url) {
    const domain = this.getDomain(url);
    if (!domain) return '';
    // Use Google's favicon service as a reliable source
    return `https://www.google.com/s2/favicons?domain=${domain}&sz=64`;
  },

  /**
   * Get the first letter of a string for letter avatar
   * @param {string} str - Input string
   * @returns {string} First letter uppercase
   */
  getFirstLetter(str) {
    if (!str) return '?';
    // Get first character, handle Chinese characters
    const char = str.trim().charAt(0).toUpperCase();
    return char || '?';
  },

  /**
   * Generate a consistent color for a string
   * @param {string} str - Input string
   * @returns {string} Hex color
   */
  stringToColor(str) {
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
  },

  /**
   * Debounce function
   * @param {Function} func - Function to debounce
   * @param {number} wait - Wait time in ms
   * @returns {Function} Debounced function
   */
  debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
      const later = () => {
        clearTimeout(timeout);
        func(...args);
      };
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
    };
  },

  /**
   * Throttle function
   * @param {Function} func - Function to throttle
   * @param {number} limit - Limit in ms
   * @returns {Function} Throttled function
   */
  throttle(func, limit) {
    let inThrottle;
    return function executedFunction(...args) {
      if (!inThrottle) {
        func(...args);
        inThrottle = true;
        setTimeout(() => inThrottle = false, limit);
      }
    };
  },

  /**
   * Deep clone an object
   * @param {*} obj - Object to clone
   * @returns {*} Cloned object
   */
  deepClone(obj) {
    if (obj === null || typeof obj !== 'object') return obj;
    if (obj instanceof Date) return new Date(obj.getTime());
    if (obj instanceof Array) return obj.map(item => this.deepClone(item));
    if (obj instanceof Object) {
      const copy = {};
      Object.keys(obj).forEach(key => {
        copy[key] = this.deepClone(obj[key]);
      });
      return copy;
    }
    return obj;
  },

  /**
   * Fuzzy match for search
   * @param {string} needle - Search term
   * @param {string} haystack - Text to search in
   * @returns {boolean} Whether matches
   */
  fuzzyMatch(needle, haystack) {
    if (!needle || !haystack) return false;
    needle = needle.toLowerCase();
    haystack = haystack.toLowerCase();
    
    let nIdx = 0;
    for (let i = 0; i < haystack.length && nIdx < needle.length; i++) {
      if (haystack[i] === needle[nIdx]) {
        nIdx++;
      }
    }
    return nIdx === needle.length;
  },

  /**
   * Format timestamp for backup name
   * @param {Date} date - Date object
   * @returns {string} Formatted timestamp
   */
  formatTimestamp(date = new Date()) {
    const pad = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  },

  /**
   * Format date for display
   * @param {Date|string|number} date - Date to format
   * @returns {string} Formatted date string
   */
  formatDate(date) {
    const d = new Date(date);
    return d.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });
  },

  /**
   * Get file size in human readable format
   * @param {number} bytes - Size in bytes
   * @returns {string} Formatted size
   */
  formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  },

  /**
   * Escape HTML special characters
   * @param {string} str - String to escape
   * @returns {string} Escaped string
   */
  escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  },

  /**
   * Check if system prefers dark mode
   * @returns {boolean}
   */
  prefersDarkMode() {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  },

  /**
   * Convert image to base64
   * @param {string} url - Image URL
   * @returns {Promise<string>} Base64 data URL
   */
  async imageToBase64(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        try {
          const dataUrl = canvas.toDataURL('image/png');
          resolve(dataUrl);
        } catch (e) {
          reject(e);
        }
      };
      img.onerror = reject;
      img.src = url;
    });
  },

  /**
   * Download data as file
   * @param {string} data - Data to download
   * @param {string} filename - File name
   * @param {string} type - MIME type
   */
  downloadFile(data, filename, type = 'application/json') {
    const blob = new Blob([data], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  },

  /**
   * Read file as text
   * @param {File} file - File to read
   * @returns {Promise<string>} File content
   */
  readFileAsText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = e => resolve(e.target.result);
      reader.onerror = reject;
      reader.readAsText(file);
    });
  },

  /**
   * Read file as data URL
   * @param {File} file - File to read
   * @returns {Promise<string>} Data URL
   */
  readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = e => resolve(e.target.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }
};

// Freeze the Utils object to prevent modifications
Object.freeze(Utils);
