import { loadIconCache, saveIconCache } from "./storage.js";

const FAVICON_API = "https://www.google.com/s2/favicons";
const SPECIAL_FAVICONS = {
  "gmail.com": [
    "https://mail.google.com/favicon.ico",
    "https://ssl.gstatic.com/ui/v1/icons/mail/rfr/gmail.ico",
  ],
  "mail.google.com": [
    "https://mail.google.com/favicon.ico",
    "https://ssl.gstatic.com/ui/v1/icons/mail/rfr/gmail.ico",
  ],
  "google.com": [
    "https://www.google.com/favicon.ico",
    "https://google.com/favicon.ico",
  ],
  "www.google.com": [
    "https://www.google.com/favicon.ico",
  ],
  "gemini.google.com": [
    "https://gemini.google.com/favicon.ico",
    "https://www.google.com/favicon.ico",
  ],
  "gitcode.com": [
    "https://gitcode.com/favicon.ico",
    "https://www.gitcode.com/favicon.ico",
  ],
  "chatgpt.com": [
    "https://chatgpt.com/favicon.ico",
    "https://chat.openai.com/favicon.ico",
    "https://openai.com/favicon.ico",
  ],
  "openai.com": [
    "https://openai.com/favicon.ico",
    "https://chatgpt.com/favicon.ico",
  ],
  "chat.openai.com": [
    "https://chatgpt.com/favicon.ico",
    "https://openai.com/favicon.ico",
  ],
};
const FIREFOX_EXTENSION_CORP_BLOCKLIST = new Set([
  "mail.google.com",
  "chatgpt.com",
  "openai.com",
]);
const FINAL_URL_CACHE = new Map();
const ICON_FAILURE_TTL_MS = 24 * 60 * 60 * 1000;

function hashColor(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  const c = (hash & 0x00ffffff).toString(16).toUpperCase();
  return `#${"00000".substring(0, 6 - c.length)}${c}`;
}

function avatarDataUrl(text, color) {
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
  } catch (e) {
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
  } catch (e) {
    // URL 解析失败是预期行为
    return "";
  }
}

export function getFaviconCandidates(pageUrl) {
  try {
    if (!isHttpUrl(pageUrl)) return [];
    const u = new URL(pageUrl);
    const host = u.hostname.toLowerCase();
    if (!host.includes(".")) return [];
    if (host === "localhost" || host.endsWith(".local")) return [];
    const special = SPECIAL_FAVICONS[host] || [];
    const siblingHostSpecial = getSiblingHostCandidates(host);
    const dynamicSpecial = getDynamicSpecialFaviconCandidates(host);
    const rawCandidates = [
      ...special,
      ...siblingHostSpecial,
      ...dynamicSpecial,
      `https://${host}/favicon.ico`,
      buildGoogleFaviconUrl(host),
      buildGoogleDomainFaviconUrl(host),
      `https://icons.duckduckgo.com/ip3/${host}.ico`,
    ];
    const normalized = rawCandidates
      .map((candidate) => normalizeCandidateUrl(candidate))
      .filter(Boolean);
    const filtered = normalized.filter((candidate) => !shouldSkipCandidate(candidate));
    return Array.from(new Set(filtered));
  } catch (e) {
    // URL 解析失败是预期行为
    return [];
  }
}

function buildGoogleFaviconUrl(host) {
  return `${FAVICON_API}?sz=128&domain_url=${encodeURIComponent(`https://${host}`)}`;
}

function buildGoogleDomainFaviconUrl(host) {
  return `${FAVICON_API}?sz=128&domain=${encodeURIComponent(host)}`;
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
  } catch (e) {
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
  } catch (e) {
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
  return Date.now() - entry.ts < ICON_FAILURE_TTL_MS;
}

function isExtensionContext() {
  try {
    if (typeof window === "undefined" || !window.location?.protocol) return false;
    const protocol = window.location.protocol;
    return protocol === "chrome-extension:" || protocol === "moz-extension:" || protocol === "edge-extension:";
  } catch (e) {
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
    return finalUrl;
  } catch (e) {
    // fetch 失败是预期行为（网络错误、超时等）
    return pageUrl;
  }
}

function buildFaviconUrl(url) {
  const candidates = getFaviconCandidates(url);
  return candidates[0] || "";
}

export async function resolveIcon(node, settings) {
  const base = node.title || node.url || "?";
  const isHttp = node.url ? isHttpUrl(node.url) : false;
  const siteKey = node.url ? getSiteKey(node.url) : "";
  const cache = await loadIconCache();
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
    const safeUrl = sanitizeCachedIconUrl(cache, siteKey);
    if (!safeUrl && !cache[siteKey]) cacheChanged = true;
    if (safeUrl) {
      if (cacheChanged) await saveIconCache(cache);
      return safeUrl;
    }
    if (cache[siteKey]?.dataUrl) {
      if (cacheChanged) await saveIconCache(cache);
      return cache[siteKey].dataUrl;
    }
  }

  if (cache[cacheKey]) {
    if (isFailedCacheEntry(cache[cacheKey])) {
      return avatarDataUrl(base, node.color || hashColor(base));
    }
    const safeUrl = sanitizeCachedIconUrl(cache, cacheKey);
    if (!safeUrl && !cache[cacheKey]) cacheChanged = true;
    if (safeUrl) {
      if (cacheChanged) await saveIconCache(cache);
      return safeUrl;
    }
    if (cache[cacheKey]?.dataUrl) {
      if (cacheChanged) await saveIconCache(cache);
      return cache[cacheKey].dataUrl;
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

  if (settings.iconFetch && node.url) {
    const finalUrl = await resolveFinalUrl(node.url);
    const url = buildFaviconUrl(finalUrl);
    if (!url) {
      if (cacheChanged) await saveIconCache(cache);
      return avatarDataUrl(base, node.color || hashColor(base));
    }
    cache[cacheKey] = { url, ts: Date.now() };
    if (siteKey && !cache[siteKey]) {
      cache[siteKey] = { url, ts: Date.now() };
    }
    await saveIconCache(cache);
    return url;
  }

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
      const url = buildFaviconUrl(finalUrl);
      cache[node.url] = { url, ts: Date.now() };
      const siteKey = getSiteKey(node.url);
      if (siteKey) cache[siteKey] = { url, ts: Date.now() };
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
  for (const key of Object.keys(cache)) {
    if (cache[key]) {
      const raw = key.startsWith("site:") ? `https://${key.slice(5)}` : key;
      cache[key] = { url: buildFaviconUrl(raw), ts: Date.now() };
      changed = true;
    }
  }
  if (changed) await saveIconCache(cache);
}
