/**
 * Bing Wallpaper module for Homepage Extension
 * Fetches and caches daily Bing wallpaper
 */

const BingWallpaper = {
  // Bing wallpaper API (via CORS proxy or direct)
  BING_API: 'https://www.bing.com/HPImageArchive.aspx?format=js&idx=0&n=1&mkt=zh-CN',
  BING_BASE: 'https://www.bing.com',
  
  // Cache key
  CACHE_KEY: 'homepage_bing_wallpaper',
  
  // Cache duration (24 hours)
  CACHE_DURATION: 24 * 60 * 60 * 1000,

  /**
   * Get cached wallpaper info
   * @returns {Promise<object|null>} Cached wallpaper data
   */
  async getCached() {
    try {
      const api = Storage.getStorageApi();
      const result = await api.local.get(this.CACHE_KEY);
      const cached = result[this.CACHE_KEY];
      
      if (cached && cached.cachedAt) {
        const age = Date.now() - cached.cachedAt;
        if (age < this.CACHE_DURATION) {
          return cached;
        }
      }
      return null;
    } catch (e) {
      console.error('Failed to get cached wallpaper:', e);
      return null;
    }
  },

  /**
   * Cache wallpaper data
   * @param {object} data - Wallpaper data to cache
   */
  async cache(data) {
    try {
      const api = Storage.getStorageApi();
      await api.local.set({
        [this.CACHE_KEY]: {
          ...data,
          cachedAt: Date.now()
        }
      });
    } catch (e) {
      console.error('Failed to cache wallpaper:', e);
    }
  },

  /**
   * Fetch wallpaper info from Bing API
   * @returns {Promise<object|null>} Wallpaper info
   */
  async fetchFromApi() {
    try {
      const response = await fetch(this.BING_API);
      if (!response.ok) throw new Error('API request failed');
      
      const data = await response.json();
      if (!data.images || !data.images[0]) {
        throw new Error('Invalid API response');
      }
      
      const image = data.images[0];
      const wallpaper = {
        url: this.BING_BASE + image.url,
        urlbase: this.BING_BASE + image.urlbase,
        title: image.title,
        copyright: image.copyright,
        date: image.startdate
      };
      
      return wallpaper;
    } catch (e) {
      console.error('Failed to fetch Bing wallpaper:', e);
      return null;
    }
  },

  /**
   * Convert wallpaper to base64 for local caching
   * @param {string} url - Wallpaper URL
   * @returns {Promise<string|null>} Base64 data URL
   */
  async toBase64(url) {
    try {
      // Try to fetch and convert to base64
      const response = await fetch(url);
      const blob = await response.blob();
      
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    } catch (e) {
      console.error('Failed to convert wallpaper to base64:', e);
      return null;
    }
  },

  /**
   * Get wallpaper (from cache or API)
   * @param {boolean} forceRefresh - Force refresh from API
   * @returns {Promise<object>} Wallpaper data with status
   */
  async get(forceRefresh = false) {
    // Try cache first
    if (!forceRefresh) {
      const cached = await this.getCached();
      if (cached && cached.base64) {
        return {
          success: true,
          source: 'cache',
          data: cached
        };
      }
    }

    // Fetch from API
    const wallpaper = await this.fetchFromApi();
    
    if (wallpaper) {
      // Get high resolution version
      const hdUrl = wallpaper.urlbase + '_1920x1080.jpg';
      
      // Try to convert to base64 for local caching
      const base64 = await this.toBase64(hdUrl);
      
      if (base64) {
        const cached = {
          ...wallpaper,
          hdUrl,
          base64
        };
        await this.cache(cached);
        return {
          success: true,
          source: 'api',
          data: cached
        };
      } else {
        // Cache URL only (will require network for display)
        const cached = {
          ...wallpaper,
          hdUrl
        };
        await this.cache(cached);
        return {
          success: true,
          source: 'api',
          data: cached
        };
      }
    }

    // Fallback to old cache if available
    const oldCached = await this.getCached();
    if (oldCached) {
      return {
        success: false,
        source: 'old-cache',
        data: oldCached,
        error: '无法获取今日壁纸，使用上次缓存'
      };
    }

    // Complete failure
    return {
      success: false,
      source: 'none',
      data: null,
      error: '无法获取壁纸'
    };
  },

  /**
   * Apply wallpaper to background element
   * @param {HTMLElement} element - Background element
   * @param {object} settings - Background settings
   * @returns {Promise<object>} Result
   */
  async apply(element, settings) {
    if (!element) return { success: false, error: 'Element not found' };
    
    const bgType = settings?.background?.type || 'bing';
    
    switch (bgType) {
      case 'bing':
        element.classList.add('loading');
        const result = await this.get();
        element.classList.remove('loading');
        
        if (result.data) {
          const imageUrl = result.data.base64 || result.data.hdUrl || result.data.url;
          if (settings?.background?.fadeEffect) {
            element.style.opacity = '0';
            element.style.backgroundImage = `url(${imageUrl})`;
            setTimeout(() => {
              element.style.opacity = '1';
            }, 50);
          } else {
            element.style.backgroundImage = `url(${imageUrl})`;
          }
        } else {
          // Fallback to solid color
          element.style.backgroundImage = 'none';
          element.style.backgroundColor = '#2c3e50';
        }
        return result;

      case 'solid':
        element.style.backgroundImage = 'none';
        element.style.backgroundColor = settings.background.color || '#2c3e50';
        return { success: true, source: 'solid' };

      case 'gradient':
        element.style.backgroundImage = 'none';
        element.style.background = settings.background.gradient || 'linear-gradient(135deg, #2c3e50, #3498db)';
        return { success: true, source: 'gradient' };

      case 'custom':
        if (settings.background.customUrl) {
          element.style.backgroundImage = `url(${settings.background.customUrl})`;
          return { success: true, source: 'custom' };
        }
        element.style.backgroundImage = 'none';
        element.style.backgroundColor = '#2c3e50';
        return { success: false, error: '未设置自定义背景' };

      default:
        element.style.backgroundImage = 'none';
        element.style.backgroundColor = '#2c3e50';
        return { success: true, source: 'default' };
    }
  }
};

// Freeze the object
Object.freeze(BingWallpaper);
