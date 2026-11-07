/**
 * 主题与背景样式应用管线（从 app.js 拆出，解耦第六阶段）。
 *
 * 职责：页面视觉外观的热应用——主题（light/dark/system + prefers-color-scheme 监听）、
 * 密度与字号（CSS 变量）、背景（每日 Bing / 纯色 / 渐变 / 自定义图）的切换渲染、
 * 遮罩强度、签名对比避免重复请求壁纸、同页并发合并。
 *
 * 用 IIFE 包裹：Firefox 版把所有模块拼成一个经典脚本，
 * 顶层 const/let 会和其它模块重名。IIFE 保证只暴露一个全局名。
 */

var HomepageThemeManager = (() => {
  const DENSITY_MAP = {
    compact: { gap: 10 },
    standard: { gap: 16 },
    spacious: { gap: 22 },
  };
  const DEFAULT_TILE_SIZE = 150;
  const DEFAULT_BASE_FONT = 13;

  /**
   * 背景相关设置的轻量签名：只取决定「显示什么背景」的字段。
   * 自定义背景图可能有几百 KB，不做全量比较，取长度 + 前 32 字符足够区分。
   */
  function backgroundSignature(settings) {
    const s = settings || {};
    const custom = typeof s.backgroundCustom === "string" ? s.backgroundCustom : "";
    return [
      s.backgroundType || "",
      s.backgroundColor || "",
      s.backgroundGradient || "",
      custom.length,
      custom.slice(0, 32),
      Number(s.backgroundOverlayStrength) || 0,
      // 每日 Bing 按语言取图，语言变了也要重取
      s.language || "",
    ].join("|");
  }

  /**
   * @param {{
   *   getData: () => object,
   *   getBackgroundEl: () => HTMLElement,
   *   getBingWallpaper: (language?: string) => Promise<{dataUrl: string, failed?: boolean, fromCache?: boolean}>,
   *   isSafeCssColor: (input: string) => boolean,
   *   toast: (message: string, kind?: string) => void,
   *   t: (key: string, vars?: object) => string,
   * }} deps
   */
  function createThemeManager(deps) {
    /** 已应用过的背景签名：数据整包替换后只有签名变了才重跑（避免重复请求壁纸） */
    let appliedBackgroundSignature = "";
    /** 同一页面内并发调用合并成一次 */
    let backgroundLoading = null;
    /** system 主题的媒体查询监听是否已挂载 */
    let systemThemeBound = false;

    const docEl = () => deps.getDocumentElement?.() || document.documentElement;

    /** 主题切换：light / dark / system（system 跟随 prefers-color-scheme） */
    function applyTheme(themeMode) {
      const theme = themeMode || deps.getData()?.settings?.theme || "system";
      if (theme === "system") {
        const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
        docEl().setAttribute("data-theme", mq?.matches ? "dark" : "light");
        applyBackgroundOverlay();
        bindSystemThemeListener();
        return;
      }
      docEl().setAttribute("data-theme", theme);
      applyBackgroundOverlay();
    }

    /** system 模式下监听系统深浅色变化（幂等挂载一次） */
    function bindSystemThemeListener() {
      if (systemThemeBound) return;
      if (typeof window === "undefined" || !window.matchMedia) return;
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      mq.addEventListener?.("change", () => {
        if ((deps.getData()?.settings?.theme || "system") === "system") applyTheme("system");
      });
      systemThemeBound = true;
    }

    /** 字号（写入 --tile-font / --base-font 两个 CSS 变量） */
    function applyFontSize(fontSize) {
      const baseFont = Number(fontSize) || Number(deps.getData()?.settings?.fontSize) || DEFAULT_BASE_FONT;
      docEl().style.setProperty("--tile-font", `${baseFont}px`);
      docEl().style.setProperty("--base-font", `${baseFont}px`);
    }

    /** 网格密度（--grid-gap）与卡片尺寸兜底；内部同时应用字号 */
    function applyDensity() {
      const settings = deps.getData()?.settings || {};
      const d = DENSITY_MAP[settings.gridDensity] || DENSITY_MAP.standard;
      docEl().style.setProperty("--grid-gap", `${d.gap}px`);
      applyFontSize(settings.fontSize);
      if (!settings.lastTileSize || settings.lastTileSize <= 0 || settings.lastTileSize < DEFAULT_TILE_SIZE) {
        settings.lastTileSize = DEFAULT_TILE_SIZE;
      }
    }

    /** 副作用型设置统一入口（render() 尾部调用） */
    function applyThemeAndDensity() {
      applyTheme();
      applyDensity();
    }

    /** 遮罩强度：仅图片类背景（bing/custom）生效，其它类型透明 */
    function applyBackgroundOverlay() {
      const type = deps.getData()?.settings?.backgroundType || "color";
      const isImage = type === "bing" || type === "custom";
      const strength = Math.min(0.6, Math.max(0, Number(deps.getData()?.settings?.backgroundOverlayStrength)));
      docEl().style.setProperty("--bg-overlay", isImage ? `rgba(0, 0, 0, ${strength})` : "rgba(0, 0, 0, 0)");
    }

    function setSolidBackgroundColor(color) {
      const safe = deps.isSafeCssColor(color) ? String(color).trim() : "#0b0f14";
      const el = deps.getBackgroundEl();
      el.style.backgroundImage = "none";
      el.style.backgroundColor = safe;
      el.style.background = safe;
    }

    function isSafeCssGradient(style) {
      if (typeof style !== "string") return false;
      const s = style.trim();
      if (!/^(?:(?:repeating-)?(?:linear|radial|conic)-gradient)\(.*\)$/s.test(s)) return false;
      if (/[;{}<>]|url\s*\(|javascript\s*:/i.test(s)) return false;
      return true;
    }

    /** 写入背景样式：data:/http 走 url()，仅放行 CSS 函数与关键字，防注入 */
    function setBackground(style) {
      if (!style) return;
      const el = deps.getBackgroundEl();
      el.style.backgroundSize = "cover";
      el.style.backgroundPosition = "center";
      el.style.backgroundRepeat = "no-repeat";
      if (style.startsWith("data:") || style.startsWith("http")) {
        // JSON.stringify 给 URL 加引号并转义，比 CSS.escape(标识符) 更适合 url() 值
        el.style.backgroundImage = `url(${JSON.stringify(style)})`;
      } else if (isSafeCssGradient(style) || /^[a-zA-Z-]+\([^)]*\)$/.test(style)) {
        // 仅允许形如 linear-gradient(...) / radial-gradient(...) 的合法 CSS 渐变函数（含嵌套 rgba）
        el.style.backgroundImage = style;
      } else if (/^[a-zA-Z-]+$/.test(style)) {
        // 仅允许纯关键字（如 none）
        el.style.backgroundImage = style;
      }
      // 其它情况一律忽略，避免注入
    }

    /**
     * @param {{silent?: boolean}} [options]
     *   silent=true 时不弹提示——页面加载、同步后自动刷新都属于「用户没主动操作」，
     *   每个新标签页都弹一次「已更新今日 Bing 壁纸」会变成刷屏（实测一次开几十个标签）。
     */
    async function loadBackground(options = {}) {
      if (backgroundLoading) return backgroundLoading;
      backgroundLoading = doLoadBackground(options);
      try {
        return await backgroundLoading;
      } finally {
        backgroundLoading = null;
      }
    }

    async function doLoadBackground({ silent = false } = {}) {
      const settings = deps.getData()?.settings || {};
      deps.getBackgroundEl().classList.add("is-loading");

      if (settings.backgroundType === "bing") {
        const info = await deps.getBingWallpaper(settings.language, {
          onUpdated: (fresh) => {
            if (deps.getData()?.settings?.backgroundType === "bing" && fresh?.dataUrl) {
              setBackground(fresh.dataUrl);
              appliedBackgroundSignature = backgroundSignature(deps.getData()?.settings);
            }
          },
        });
        if (info.dataUrl) {
          setBackground(info.dataUrl);
          if (!silent) {
            if (info.failed) deps.toast(deps.t("background.fetchFailedCache"), "warning");
            else if (!info.fromCache) deps.toast(deps.t("background.updatedToday"));
          }
        } else {
          setSolidBackgroundColor(settings.backgroundColor);
          if (!silent) deps.toast(deps.t("background.failedDefault"), "error");
        }
      } else if (settings.backgroundType === "color") {
        setSolidBackgroundColor(settings.backgroundColor);
      } else if (settings.backgroundType === "gradient") {
        setBackground(settings.backgroundGradient);
      } else if (settings.backgroundType === "custom") {
        if (settings.backgroundCustom) setBackground(settings.backgroundCustom);
        else setSolidBackgroundColor(settings.backgroundColor);
      }

      applyBackgroundOverlay();
      appliedBackgroundSignature = backgroundSignature(settings);
      deps.getBackgroundEl().classList.remove("is-loading");
    }

    /** 数据被整包替换后调用：只有背景相关设置确实变了才重跑 */
    async function refreshBackgroundIfChanged() {
      const settings = deps.getData()?.settings;
      if (!settings) return;
      // 首次加载背景还没跑过（签名空），交给初始化流程，避免重复请求壁纸
      if (!appliedBackgroundSignature) return;
      if (backgroundSignature(settings) === appliedBackgroundSignature) return;
      try {
        await loadBackground({ silent: true });
      } catch (e) {
        console.warn("refreshBackgroundIfChanged failed", e);
      }
    }

    return {
      applyTheme,
      applyFontSize,
      applyDensity,
      applyThemeAndDensity,
      applyBackgroundOverlay,
      setBackground,
      setSolidBackgroundColor,
      loadBackground,
      refreshBackgroundIfChanged,
      get appliedBackgroundSignature() {
        return appliedBackgroundSignature;
      },
    };
  }

  return { createThemeManager, backgroundSignature };
})();

// ESM 构建（Chrome/Safari）从这里取；Firefox 拼接时会剥掉 export，改用上面的全局变量。
export const createThemeManager = HomepageThemeManager.createThemeManager;
export const backgroundSignature = HomepageThemeManager.backgroundSignature;
