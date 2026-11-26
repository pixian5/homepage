/**
 * 图标候选生成与隐私过滤纯函数模块（从 icons.js 拆出）。
 *
 * 用 IIFE 包裹，保证 Firefox 拼接经典脚本时不污染全局作用域。
 */
var HomepageIconCandidates = (() => {
  const FAVICON_API = "https://www.google.com/s2/favicons";
  const SPECIAL_FAVICONS = {
    "gmail.com": ["https://mail.google.com/favicon.ico", "https://ssl.gstatic.com/ui/v1/icons/mail/rfr/gmail.ico"],
    "mail.google.com": [
      "https://mail.google.com/favicon.ico",
      "https://ssl.gstatic.com/ui/v1/icons/mail/rfr/gmail.ico",
    ],
    "google.com": ["https://www.google.com/favicon.ico", "https://google.com/favicon.ico"],
    "www.google.com": ["https://www.google.com/favicon.ico"],
    "gemini.google.com": ["https://gemini.google.com/favicon.ico", "https://www.google.com/favicon.ico"],
    "gitcode.com": [
      "https://gitcode.com/favicon.ico",
      "https://gitcode.com/favicon.svg",
      "https://www.gitcode.com/favicon.ico",
    ],
    "www.gitcode.com": [
      "https://www.gitcode.com/favicon.ico",
      "https://gitcode.com/favicon.ico",
      "https://gitcode.com/favicon.svg",
    ],
    "chatgpt.com": [
      "https://chatgpt.com/favicon.ico",
      "https://chat.openai.com/favicon.ico",
      "https://openai.com/favicon.ico",
    ],
    "openai.com": ["https://openai.com/favicon.ico", "https://chatgpt.com/favicon.ico"],
    "chat.openai.com": ["https://chatgpt.com/favicon.ico", "https://openai.com/favicon.ico"],
    "grok.com": ["https://grok.com/favicon.ico", "https://x.ai/favicon.ico"],
    "x.ai": ["https://x.ai/favicon.ico", "https://grok.com/favicon.ico"],
    "doubao.com": ["https://doubao.com/favicon.ico", "https://www.doubao.com/favicon.ico"],
    "www.doubao.com": ["https://www.doubao.com/favicon.ico", "https://doubao.com/favicon.ico"],
    "ip233.cn": ["https://www.ip233.cn/favicon.ico", "https://ip233.cn/favicon.ico"],
    "www.ip233.cn": ["https://www.ip233.cn/favicon.ico", "https://ip233.cn/favicon.ico"],
    "sharepoint.com": [
      "https://www.sharepoint.com/favicon.ico",
      "https://sharepoint.com/favicon.ico",
      "https://login.microsoftonline.com/favicon.ico",
    ],
  };
  const FIREFOX_EXTENSION_CORP_BLOCKLIST = new Set(["mail.google.com", "chatgpt.com", "openai.com"]);

  function isExtensionContext() {
    try {
      if (typeof window === "undefined" || !window.location?.protocol) return false;
      const protocol = window.location.protocol;
      return (
        protocol === "chrome-extension:" ||
        protocol === "moz-extension:" ||
        protocol === "edge-extension:" ||
        protocol === "safari-web-extension:"
      );
    } catch (_e) {
      return false;
    }
  }

  function isBrowserExtension() {
    try {
      if (!isExtensionContext()) return false;
      const ua = navigator?.userAgent || "";
      return /firefox/i.test(ua) || /safari/i.test(ua) || /applewebkit/i.test(ua);
    } catch (_e) {
      return false;
    }
  }

  function isHttpUrl(pageUrl) {
    try {
      const u = new URL(pageUrl);
      return u.protocol === "http:" || u.protocol === "https:";
    } catch (_e) {
      return false;
    }
  }

  function getSiteKey(pageUrl) {
    try {
      if (!isHttpUrl(pageUrl)) return "";
      const host = new URL(pageUrl).hostname.toLowerCase();
      if (!host.includes(".")) return "";
      if (host === "localhost" || host.endsWith(".local")) return "";
      return `site:${host}`;
    } catch (_e) {
      return "";
    }
  }

  /** 路径深度 >=1 的站点：失败缓存可能来自错误的根路径 favicon，应允许重试 */
  function shouldBypassIconFailureCache(pageUrl) {
    try {
      const path = new URL(pageUrl).pathname || "/";
      return path.split("/").filter(Boolean).length >= 1 && path !== "/";
    } catch (_e) {
      return false;
    }
  }

  /**
   * 判断候选 URL 是否属于第三方图标代理服务（Google Favicon / DuckDuckGo）。
   * 开启隐私保护开关（iconThirdPartyFallback === false）时禁止向这些域名外发请求。
   */
  function isThirdPartyFaviconUrl(raw) {
    try {
      const parsed = new URL(raw);
      const host = parsed.hostname.toLowerCase();
      const pathname = parsed.pathname || "/";
      if (host === "icons.duckduckgo.com") return true;
      if (host === "www.google.com" && pathname.startsWith("/s2/favicons")) return true;
      if (/^t\d+\.gstatic\.com$/i.test(host) && pathname.startsWith("/faviconV2")) return true;
      return false;
    } catch {
      return false;
    }
  }

  function buildGoogleFaviconUrl(host) {
    return `${FAVICON_API}?sz=128&domain_url=${encodeURIComponent(`https://${host}`)}`;
  }

  function buildGoogleFaviconByPageUrl(pageUrl) {
    return `https://t2.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&size=128&url=${encodeURIComponent(pageUrl)}`;
  }

  function buildGoogleDomainFaviconUrl(host) {
    return `${FAVICON_API}?sz=128&domain=${encodeURIComponent(host)}`;
  }

  function getPathSpecificCandidates(host, pathname) {
    const candidates = [];
    const normalizedPath = (pathname || "/").toLowerCase();

    if (host === "gmail.com" || host === "mail.google.com") {
      candidates.push("https://mail.google.com/mail/u/0/images/2/favicon.ico");
      candidates.push("https://mail.google.com/mail/u/0/images/2/5/unreadcounticon.ico");
    }

    if (host === "gemini.google.com") {
      candidates.push("https://gemini.google.com/app/favicon.ico");
      candidates.push("https://gemini.google.com/favicon.ico");
    }

    if (host.endsWith(".sharepoint.com") && normalizedPath.startsWith("/my")) {
      candidates.push(`https://${host}/_layouts/15/images/favicon.ico`);
      candidates.push(`https://${host}/_layouts/15/images/favicon.ico?rev=47`);
    }

    if (host === "gitcode.com" || host === "www.gitcode.com") {
      candidates.push("https://gitcode.com/favicon.svg");
      candidates.push("https://gitcode.com/favicon.ico");
    }

    // SPA 部署在子路径时（如 /list/），favicon 常在该路径下而非站点根
    if (normalizedPath && normalizedPath !== "/") {
      const segments = normalizedPath.split("/").filter(Boolean);
      if (segments.length >= 1) {
        const base = `https://${host}/${segments[0]}`;
        candidates.push(`${base}/logo.svg`);
        candidates.push(`${base}/favicon.svg`);
        candidates.push(`${base}/favicon.ico`);
        candidates.push(`${base}/apple-touch-icon.png`);
      }
      if (segments.length >= 2) {
        const dir = `https://${host}/${segments.slice(0, -1).join("/")}`;
        candidates.push(`${dir}/logo.svg`);
        candidates.push(`${dir}/favicon.svg`);
        candidates.push(`${dir}/favicon.ico`);
      }
    }

    return candidates;
  }

  function getDynamicSpecialFaviconCandidates(host) {
    const candidates = [];
    if (host.endsWith(".sharepoint.com")) {
      candidates.push(`https://${host}/_layouts/15/images/favicon.ico`);
    }
    return candidates;
  }

  function getSiblingHostCandidates(host) {
    if (host.startsWith("www.")) {
      return [`https://${host.slice(4)}/favicon.ico`];
    }
    return [`https://www.${host}/favicon.ico`];
  }

  function normalizeCandidateUrl(raw) {
    try {
      const parsed = new URL(raw);
      if (parsed.protocol === "http:") parsed.protocol = "https:";
      if (parsed.protocol !== "https:") return "";
      return parsed.toString();
    } catch (_e) {
      return "";
    }
  }

  function shouldSkipCandidate(candidate) {
    try {
      if (!isExtensionContext()) return false;
      if (!/firefox/i.test(navigator?.userAgent || "")) return false;
      const host = new URL(candidate).hostname;
      return FIREFOX_EXTENSION_CORP_BLOCKLIST.has(host);
    } catch (_e) {
      return false;
    }
  }

  function getFaviconCandidates(pageUrl, options = {}) {
    const allowThirdPartyFallback = options?.allowThirdPartyFallback !== false;
    try {
      if (!isHttpUrl(pageUrl)) return [];
      const u = new URL(pageUrl);
      const host = u.hostname.toLowerCase();
      const pathname = u.pathname || "/";
      if (!host.includes(".")) return [];
      if (host === "localhost" || host.endsWith(".local")) return [];
      const special = SPECIAL_FAVICONS[host] || [];
      const siblingHostSpecial = getSiblingHostCandidates(host);
      const dynamicSpecial = getDynamicSpecialFaviconCandidates(host);
      const pathSpecific = getPathSpecificCandidates(host, pathname);
      const duckduckgo = `https://icons.duckduckgo.com/ip3/${host}.ico`;
      const rawCandidates = isBrowserExtension()
        ? [
            ...pathSpecific,
            ...special,
            `https://${host}/favicon.ico`,
            ...siblingHostSpecial,
            ...dynamicSpecial,
            ...(allowThirdPartyFallback
              ? [
                  buildGoogleFaviconByPageUrl(pageUrl),
                  buildGoogleFaviconUrl(host),
                  buildGoogleDomainFaviconUrl(host),
                  duckduckgo,
                ]
              : []),
          ]
        : [
            ...pathSpecific,
            ...special,
            ...siblingHostSpecial,
            ...dynamicSpecial,
            ...(allowThirdPartyFallback ? [buildGoogleFaviconByPageUrl(pageUrl)] : []),
            `https://${host}/favicon.ico`,
            ...(allowThirdPartyFallback
              ? [buildGoogleFaviconUrl(host), buildGoogleDomainFaviconUrl(host), duckduckgo]
              : []),
          ];
      const normalized = rawCandidates.map((candidate) => normalizeCandidateUrl(candidate)).filter(Boolean);
      const filtered = normalized.filter(
        (candidate) =>
          !shouldSkipCandidate(candidate) && (allowThirdPartyFallback || !isThirdPartyFaviconUrl(candidate)),
      );
      return Array.from(new Set(filtered));
    } catch (_e) {
      return [];
    }
  }

  return {
    isExtensionContext,
    isHttpUrl,
    getSiteKey,
    shouldBypassIconFailureCache,
    isThirdPartyFaviconUrl,
    normalizeCandidateUrl,
    shouldSkipCandidate,
    getFaviconCandidates,
  };
})();

export const isExtensionContext = HomepageIconCandidates.isExtensionContext;
export const isHttpUrl = HomepageIconCandidates.isHttpUrl;
export const getSiteKey = HomepageIconCandidates.getSiteKey;
export const shouldBypassIconFailureCache = HomepageIconCandidates.shouldBypassIconFailureCache;
export const isThirdPartyFaviconUrl = HomepageIconCandidates.isThirdPartyFaviconUrl;
export const normalizeCandidateUrl = HomepageIconCandidates.normalizeCandidateUrl;
export const shouldSkipCandidate = HomepageIconCandidates.shouldSkipCandidate;
export const getFaviconCandidates = HomepageIconCandidates.getFaviconCandidates;
