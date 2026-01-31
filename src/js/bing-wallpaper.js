/**
 * Bing Wallpaper module for Homepage Extension
 * Fetches and caches daily Bing wallpaper
 */

const BingWallpaper = {
  // Bing wallpaper API
  BING_API: 'https://www.bing.com/HPImageArchive.aspx?format=js&idx=0&n=1&mkt=zh-CN',
  // CORS proxy for reliable access
  CORS_PROXY: 'https://api.allorigins.win/raw?url=',
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
   * @param {boolean} useProxy - Whether to use CORS proxy
   * @param {number} retryCount - Number of retries attempted
   * @returns {Promise<object|null>} Wallpaper info
   */
  async fetchFromApi(useProxy = true, retryCount = 0) {
    // Prevent infinite recursion
    if (retryCount > 1) {
      console.error('Max retry attempts reached for Bing wallpaper');
      return null;
    }

    try {
      // Use CORS proxy for reliable access
      const apiUrl = useProxy 
        ? this.CORS_PROXY + encodeURIComponent(this.BING_API)
        : this.BING_API;
      
      console.log('Fetching Bing wallpaper from:', useProxy ? 'CORS proxy' : 'direct');
      
      const response = await fetch(apiUrl);
      if (!response.ok) {
        throw new Error(`API request failed with status ${response.status}`);
      }
      
      const data = await response.json();
      if (!data.images || !data.images[0]) {
        throw new Error('Invalid API response - no images found');
      }
      
      const image = data.images[0];
      const wallpaper = {
        url: this.BING_BASE + image.url,
        urlbase: this.BING_BASE + image.urlbase,
        title: image.title,
        copyright: image.copyright,
        date: image.startdate
      };
      
      console.log('Successfully fetched Bing wallpaper:', wallpaper.title);
      return wallpaper;
    } catch (e) {
      console.error('Failed to fetch Bing wallpaper:', e);
      
      // If using proxy failed, try direct access as fallback
      if (useProxy && retryCount === 0) {
        console.log('Proxy failed, trying direct access...');
        return this.fetchFromApi(false, retryCount + 1);
      }
      
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
      console.log('Converting wallpaper to base64:', url);
      // Try to fetch and convert to base64
      const response = await fetch(url);
      if (!response.ok) {
        console.error('Failed to fetch wallpaper image:', response.status);
        return null;
      }
      const blob = await response.blob();
      
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          console.log('Successfully converted wallpaper to base64');
          resolve(reader.result);
        };
        reader.onerror = (e) => {
          console.error('FileReader error:', e);
          reject(e);
        };
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
      if (cached && (cached.base64 || cached.hdUrl || cached.url)) {
        console.log('Using cached wallpaper');
        return {
          success: true,
          source: 'cache',
          data: cached
        };
      }
    }

    console.log('Fetching new wallpaper from API...');
    // Fetch from API
    const wallpaper = await this.fetchFromApi();
    
    if (wallpaper) {
      // Get high resolution version
      const hdUrl = wallpaper.urlbase + '_1920x1080.jpg';
      
      // Try to convert to base64 for local caching
      const base64 = await this.toBase64(hdUrl);
      
      const cached = {
        ...wallpaper,
        hdUrl,
        base64: base64 || null
      };
      await this.cache(cached);
      
      console.log(`Wallpaper cached successfully${cached.hdUrl ? ' with URL' : ''}${base64 ? ' with base64' : ''}`);
      
      return {
        success: true,
        source: 'api',
        data: cached
      };
    }

    // Fallback to old cache if available
    const oldCached = await this.getCached();
    if (oldCached) {
      console.log('Using old cached wallpaper as fallback');
      return {
        success: false,
        source: 'old-cache',
        data: oldCached,
        error: '无法获取今日壁纸，使用上次缓存'
      };
    }

    // Complete failure
    console.error('No wallpaper available - all methods failed');
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
    const opacity = settings?.background?.opacity || 0;
    
    // Apply opacity overlay (currently disabled in CSS)
    document.documentElement.style.setProperty('--bg-overlay-opacity', opacity);
    
    switch (bgType) {
      case 'bing':
        console.log('Applying Bing wallpaper...');
        element.classList.add('loading');
        const result = await this.get();
        element.classList.remove('loading');
        
        console.log('Wallpaper result:', result);
        
        if (result.data) {
          const imageUrl = result.data.base64 || result.data.hdUrl || result.data.url;
          const displayUrl = imageUrl && imageUrl.length > 100 
            ? imageUrl.substring(0, 100) + '...' 
            : imageUrl || 'none';
          console.log('Setting background image:', displayUrl);
          
          if (settings?.background?.fadeEffect) {
            element.style.opacity = '0';
            element.style.backgroundImage = `url(${imageUrl})`;
            element.style.background = '';
            element.style.backgroundColor = '';
            setTimeout(() => {
              element.style.opacity = '1';
            }, 50);
          } else {
            element.style.backgroundImage = `url(${imageUrl})`;
            element.style.background = '';
            element.style.backgroundColor = '';
          }
          console.log('Wallpaper applied successfully');
        } else {
          // Fallback to solid color
          console.log('No wallpaper data, using fallback color');
          element.style.backgroundImage = 'none';
          element.style.background = '';
          element.style.backgroundColor = '#2c3e50';
        }
        return result;

      case 'solid':
        element.style.backgroundImage = 'none';
        element.style.background = '';
        element.style.backgroundColor = settings.background.color || '#2c3e50';
        return { success: true, source: 'solid' };

      case 'gradient':
        const color1 = settings.background.gradientColor1 || '#2c3e50';
        const color2 = settings.background.gradientColor2 || '#3498db';
        element.style.backgroundImage = 'none';
        element.style.backgroundColor = '';
        element.style.background = `linear-gradient(135deg, ${color1}, ${color2})`;
        return { success: true, source: 'gradient' };

      case 'custom':
        if (settings.background.customUrl) {
          element.style.background = '';
          element.style.backgroundImage = `url(${settings.background.customUrl})`;
          return { success: true, source: 'custom' };
        }
        element.style.backgroundImage = 'none';
        element.style.background = '';
        element.style.backgroundColor = '#2c3e50';
        return { success: false, error: '未设置自定义背景' };

      default:
        element.style.backgroundImage = 'none';
        element.style.background = '';
        element.style.backgroundColor = '#2c3e50';
        return { success: true, source: 'default' };
    }
  }
};

// Freeze the object
Object.freeze(BingWallpaper);
