import { loadIconCache, saveIconCache } from "./storage.js";

const FAVICON_API = "https://www.google.com/s2/favicons";
const SPECIAL_FAVICONS = {
  "gmail.com": ["https://mail.google.com/favicon.ico", "https://ssl.gstatic.com/ui/v1/icons/mail/rfr/gmail.ico"],
  "mail.google.com": ["https://mail.google.com/favicon.ico", "https://ssl.gstatic.com/ui/v1/icons/mail/rfr/gmail.ico"],
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

function isBrowserExtension() {
  try {
    if (!isExtensionContext()) return false;
    const ua = navigator?.userAgent || "";
    return /firefox/i.test(ua) || /safari/i.test(ua) || /applewebkit/i.test(ua);
  } catch (_e) {
    return false;
  }
}
const FINAL_URL_CACHE = new Map();
const FINAL_URL_CACHE_MAX = 200;
const ICON_FAILURE_TTL_MS = 24 * 60 * 60 * 1000;
// 失败退避表：失败次数越多下次重试等待越久，封顶 7 天，避免持续打挂的站点被反复请求。
const ICON_FAILURE_BACKOFF_STEPS = [
  15 * 60 * 1000, // 1 次：15 分钟
  60 * 60 * 1000, // 2 次：1 小时
  6 * 60 * 60 * 1000, // 3 次：6 小时
  ICON_FAILURE_TTL_MS, // 4 次：24 小时
  7 * 24 * 60 * 60 * 1000, // 5+ 次：7 天
];

/**
 * 全局抓取并发上限：tile fallback / 后台抓取共享此信号量，
 * 避免一次渲染 N 个 tile 全部并发触发请求风暴。
 */
const ICON_FETCH_CONCURRENCY = 6;
let _iconFetchActive = 0;
const _iconFetchQueue = [];

function acquireIconFetchSlot() {
  if (_iconFetchActive < ICON_FETCH_CONCURRENCY) {
    _iconFetchActive += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    _iconFetchQueue.push(resolve);
  });
}

function releaseIconFetchSlot() {
  _iconFetchActive = Math.max(0, _iconFetchActive - 1);
  const next = _iconFetchQueue.shift();
  if (next) {
    _iconFetchActive += 1;
    next();
  }
}

async function runWithIconFetchConcurrency(task) {
  await acquireIconFetchSlot();
  try {
    return await task();
  } finally {
    releaseIconFetchSlot();
  }
}

/**
 * 在全局抓取并发上限内执行 task。供 app.js 的 tile fallback / 后台抓取共用，
 * 避免一次渲染 N 个 tile 全部并发触发请求风暴。
 * @param {() => Promise<any>} task
 * @returns {Promise<any>}
 */
export async function withIconFetchConcurrency(task) {
  return runWithIconFetchConcurrency(task);
}

export function hashColor(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  const c = (hash & 0x00ffffff).toString(16).toUpperCase();
  return `#${"00000".substring(0, 6 - c.length)}${c}`;
}

/**
 * 字母头像：128x128 canvas + 首字母大写。被 icons.js 与 app.js 共用。
 * @param {string} text
 * @param {string} [color]
 * @returns {string} dataURL
 */
export function avatarDataUrl(text, color) {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 128, 128);
  ctx.fillStyle = "rgba(255,255,255,0.9)";
  ctx.font = "bold 64px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text.slice(0, 1).toUpperCase(), 64, 72);
  return canvas.toDataURL("image/png");
}

function isHttpUrl(pageUrl) {
  try {
    const u = new URL(pageUrl);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch (_e) {
    // URL 解析失败是预期行为
    return false;
  }
}

export function getSiteKey(pageUrl) {
  try {
    if (!isHttpUrl(pageUrl)) return "";
    const host = new URL(pageUrl).hostname.toLowerCase();
    if (!host.includes(".")) return "";
    if (host === "localhost" || host.endsWith(".local")) return "";
    return `site:${host}`;
  } catch (_e) {
    // URL 解析失败是预期行为
    return "";
  }
}

export function getFaviconCandidates(pageUrl) {
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
          // Firefox/Safari 扩展：优先站点自身 favicon，DuckDuckGo 作为后备
          ...pathSpecific,
          ...special,
          `https://${host}/favicon.ico`,
          ...siblingHostSpecial,
          ...dynamicSpecial,
          buildGoogleFaviconByPageUrl(pageUrl),
          buildGoogleFaviconUrl(host),
          buildGoogleDomainFaviconUrl(host),
          duckduckgo,
        ]
      : [
          ...pathSpecific,
          ...special,
          ...siblingHostSpecial,
          ...dynamicSpecial,
          buildGoogleFaviconByPageUrl(pageUrl),
          `https://${host}/favicon.ico`,
          buildGoogleFaviconUrl(host),
          buildGoogleDomainFaviconUrl(host),
          duckduckgo,
        ];
    const normalized = rawCandidates.map((candidate) => normalizeCandidateUrl(candidate)).filter(Boolean);
    const filtered = normalized.filter((candidate) => !shouldSkipCandidate(candidate));
    return Array.from(new Set(filtered));
  } catch (_e) {
    // URL 解析失败是预期行为
    return [];
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
    return parsed.toString();
  } catch (_e) {
    // 非法 URL 直接丢弃
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
    // 容错：解析失败不跳过
    return false;
  }
}

function sanitizeCachedIconUrl(cache, key) {
  const entry = cache[key];
  if (isFailedCacheEntry(entry)) return "";
  if (!entry?.url) return "";
  const normalized = normalizeCandidateUrl(entry.url);
  if (!normalized || shouldSkipCandidate(normalized)) {
    delete cache[key];
    return "";
  }
  if (entry.url !== normalized) {
    cache[key] = { ...entry, url: normalized };
  }
  return normalized;
}

function isFailedCacheEntry(entry) {
  if (!entry?.failed) return false;
  if (!entry.ts) return true;
  return Date.now() - entry.ts < failureTtlMs(entry);
}

/**
 * 按失败次数返回退避 TTL：次数越多等待越久，封顶 7 天。
 * 兼容旧的 { failed: true }（无 attempts 字段）→ 视为 1 次，沿用 24h。
 */
function failureTtlMs(entry) {
  const attempts = Number(entry?.attempts) || 1;
  const idx = Math.min(attempts, ICON_FAILURE_BACKOFF_STEPS.length) - 1;
  return ICON_FAILURE_BACKOFF_STEPS[Math.max(0, idx)];
}

/**
 * 记录一次失败到缓存：累加 attempts 并按退避表设置失败时刻 ts。
 * isFailedCacheEntry 用 (now - ts < failureTtlMs) 判断仍在退避期。
 * 导出供 app.js 在 tile fallback / 后台抓取失败时统一写入。
 */
export function applyFailureToCache(cache, key, prevEntry) {
  const attempts = (Number(prevEntry?.attempts) || 0) + 1;
  cache[key] = { failed: true, attempts, ts: Date.now() };
}

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
    // 环境检测失败是预期行为
    return false;
  }
}

async function resolveFinalUrl(pageUrl, timeoutMs = 6000) {
  try {
    if (!isHttpUrl(pageUrl)) return pageUrl;
    if (isExtensionContext()) return pageUrl;
    const cached = FINAL_URL_CACHE.get(pageUrl);
    if (cached && Date.now() - cached.ts < 12 * 60 * 60 * 1000) {
      return cached.url;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(pageUrl, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
    });
    clearTimeout(timer);
    const finalUrl = res?.url || pageUrl;
    FINAL_URL_CACHE.set(pageUrl, { url: finalUrl, ts: Date.now() });
    if (FINAL_URL_CACHE.size > FINAL_URL_CACHE_MAX) {
      const oldest = FINAL_URL_CACHE.keys().next().value;
      FINAL_URL_CACHE.delete(oldest);
    }
    return finalUrl;
  } catch (_e) {
    // fetch 失败是预期行为（网络错误、超时等）
    return pageUrl;
  }
}

function buildFaviconUrl(url) {
  const candidates = getFaviconCandidates(url);
  return candidates[0] || "";
}

/**
 * 验证图片 URL/dataURL 是否可加载且尺寸达标
 * @param {string} url
 * @param {number} minSize
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
export function probeImage(url, minSize = 16, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const img = new Image();
    let done = false;
    const timer = setTimeout(() => finish(false), timeoutMs);
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      img.onload = null;
      img.onerror = null;
      resolve(ok);
    };
    img.onload = () => finish(img.naturalWidth >= minSize && img.naturalHeight >= minSize);
    img.onerror = () => finish(false);
    img.src = url;
  });
}

/**
 * 将远程图片 URL 抓取为 dataURL，便于缓存后瞬显
 * 抓取失败或图片无效（如 1x1 透明像素）时返回空字符串
 */
export async function fetchAsDataUrl(url, timeoutMs = 8000) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, { signal: controller.signal, credentials: "omit", cache: "force-cache" });
    clearTimeout(timer);
    if (!res.ok) return "";
    const blob = await res.blob();
    if (!blob || blob.size === 0 || blob.size > 512 * 1024) return "";
    const type = blob.type || "image/png";
    const dataUrl = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result || "");
      reader.onerror = () => resolve("");
      reader.readAsDataURL(new Blob([blob], { type }));
    });
    if (!dataUrl) return "";
    if (await probeImage(dataUrl)) return dataUrl;
    return "";
  } catch (_e) {
    return "";
  }
}

export async function resolveIcon(node, _settings, preloadedCache = null) {
  const base = node.title || node.url || "?";
  const isHttp = node.url ? isHttpUrl(node.url) : false;
  const siteKey = node.url ? getSiteKey(node.url) : "";
  const cache = preloadedCache || (await loadIconCache());
  const cacheKey = node.url || node.id;

  if (node.url && !isHttp) {
    if (cache[cacheKey]) {
      delete cache[cacheKey];
      await saveIconCache(cache);
    }
    return avatarDataUrl(base, node.color || hashColor(base));
  }

  if (node.iconType === "upload" && node.iconData) {
    if (siteKey && !cache[siteKey]) {
      cache[siteKey] = { dataUrl: node.iconData, ts: Date.now() };
      await saveIconCache(cache);
    }
    return node.iconData;
  }

  if (node.iconType === "remote" && node.iconData) {
    const remoteUrl = normalizeCandidateUrl(node.iconData);
    if (!remoteUrl || shouldSkipCandidate(remoteUrl)) {
      return avatarDataUrl(base, node.color || hashColor(base));
    }
    if (siteKey && !cache[siteKey]) {
      cache[siteKey] = { url: remoteUrl, ts: Date.now() };
      await saveIconCache(cache);
    }
    return remoteUrl;
  }

  if (node.iconType === "color") {
    const dataUrl = avatarDataUrl(base, node.color || hashColor(base));
    if (siteKey && !cache[siteKey]) {
      cache[siteKey] = { dataUrl, ts: Date.now() };
      await saveIconCache(cache);
    }
    return dataUrl;
  }

  let cacheChanged = false;

  if (siteKey && cache[siteKey]) {
    if (isFailedCacheEntry(cache[siteKey])) {
      return avatarDataUrl(base, node.color || hashColor(base));
    }
    // 优先 dataURL（瞬显，无网络请求）
    if (cache[siteKey]?.dataUrl) {
      if (cacheChanged) await saveIconCache(cache);
      return cache[siteKey].dataUrl;
    }
    // 其次远程 URL（可能是旧缓存，render 时会后台迁移为 dataUrl）
    const safeUrl = sanitizeCachedIconUrl(cache, siteKey);
    if (!safeUrl && !cache[siteKey]) cacheChanged = true;
    if (safeUrl) {
      if (cacheChanged) await saveIconCache(cache);
      return safeUrl;
    }
  }

  if (cache[cacheKey]) {
    if (isFailedCacheEntry(cache[cacheKey])) {
      return avatarDataUrl(base, node.color || hashColor(base));
    }
    // 优先 dataURL（瞬显，无网络请求）
    if (cache[cacheKey]?.dataUrl) {
      if (cacheChanged) await saveIconCache(cache);
      return cache[cacheKey].dataUrl;
    }
    // 其次远程 URL
    const safeUrl = sanitizeCachedIconUrl(cache, cacheKey);
    if (!safeUrl && !cache[cacheKey]) cacheChanged = true;
    if (safeUrl) {
      if (cacheChanged) await saveIconCache(cache);
      return safeUrl;
    }
  }

  if (node.iconType === "letter") {
    const dataUrl = avatarDataUrl(base, node.color || hashColor(base));
    if (siteKey && !cache[siteKey]) {
      cache[siteKey] = { dataUrl, ts: Date.now() };
      await saveIconCache(cache);
    }
    return dataUrl;
  }

  // 不再自动获取图标，只返回字母头像
  // 图标应该通过 fetchFaviconInBackground() 或手动刷新获取
  if (cacheChanged) await saveIconCache(cache);
  return avatarDataUrl(base, node.color || hashColor(base));
}

export async function refreshAllIcons(nodes) {
  const cache = await loadIconCache();
  const tasks = nodes.filter((n) => n.url);
  const limit = 6;
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (cursor < tasks.length) {
      const idx = cursor++;
      const node = tasks[idx];
      if (!node?.url) continue;
      const finalUrl = await resolveFinalUrl(node.url);
      const candidate = buildFaviconUrl(finalUrl);
      // 优先抓取为 dataURL，下次打开页面可瞬显
      const dataUrl = await fetchAsDataUrl(candidate);
      if (dataUrl) {
        cache[node.url] = { dataUrl, ts: Date.now() };
        const siteKey = getSiteKey(node.url);
        if (siteKey) cache[siteKey] = { dataUrl, ts: Date.now() };
      } else {
        cache[node.url] = { url: candidate, ts: Date.now() };
        const siteKey = getSiteKey(node.url);
        if (siteKey) cache[siteKey] = { url: candidate, ts: Date.now() };
      }
    }
  });
  await Promise.all(workers);
  await saveIconCache(cache);
}

export async function retryFailedIconsIfDue(settings) {
  const retryHour = settings.iconRetryHour ?? (settings.iconRetryAtSix ? 18 : "");
  if (retryHour === "" || retryHour === null || retryHour === undefined) return;
  const targetHour = Number(retryHour);
  if (!Number.isInteger(targetHour) || targetHour < 0 || targetHour > 23) return;
  const now = new Date();
  if (now.getHours() !== targetHour) return;
  const cache = await loadIconCache();
  let changed = false;
  const keys = Object.keys(cache);
  const limit = 6;
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, keys.length) }, async () => {
    while (cursor < keys.length) {
      const idx = cursor++;
      const key = keys[idx];
      if (!cache[key]) continue;
      const raw = key.startsWith("site:") ? `https://${key.slice(5)}` : key;
      const candidate = buildFaviconUrl(raw);
      // 优先抓取为 dataURL，下次打开页面可瞬显
      const dataUrl = await fetchAsDataUrl(candidate);
      if (dataUrl) {
        cache[key] = { dataUrl, ts: Date.now() };
      } else {
        // 重试仍失败：累加 attempts 走退避表，而非写回 { url } 让条目立刻可用
        applyFailureToCache(cache, key, cache[key]);
      }
      changed = true;
    }
  });
  await Promise.all(workers);
  if (changed) await saveIconCache(cache);
}

export async function clearIconCacheForUrl(oldUrl, newUrl) {
  const cache = await loadIconCache();
  let changed = false;

  // 清除旧 URL 的缓存
  if (oldUrl && cache[oldUrl]) {
    delete cache[oldUrl];
    changed = true;
  }

  // 清除旧 URL 的站点缓存
  const oldSiteKey = getSiteKey(oldUrl);
  if (oldSiteKey && cache[oldSiteKey]) {
    delete cache[oldSiteKey];
    changed = true;
  }

  // 如果 URL 改变，也清除新 URL 的缓存，强制重新获取
  if (newUrl && oldUrl !== newUrl) {
    if (cache[newUrl]) {
      delete cache[newUrl];
      changed = true;
    }
    const newSiteKey = getSiteKey(newUrl);
    if (newSiteKey && cache[newSiteKey]) {
      delete cache[newSiteKey];
      changed = true;
    }
  }

  if (changed) await saveIconCache(cache);
}
