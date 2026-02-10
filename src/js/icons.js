import { loadIconCache, saveIconCache } from "./storage.js";

const FAVICON_API = "https://www.google.com/s2/favicons?domain=";
const MULTI_PART_TLDS = new Set([
  "co.uk",
  "org.uk",
  "ac.uk",
  "gov.uk",
  "co.jp",
  "ne.jp",
  "or.jp",
  "com.cn",
  "net.cn",
  "org.cn",
  "gov.cn",
  "edu.cn",
  "com.au",
  "net.au",
  "org.au",
  "com.br",
  "com.tw",
  "com.hk",
]);
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
const ROOT_REUSE_BLOCKLIST = new Set(["google.com"]);
const FIREFOX_EXTENSION_CORP_BLOCKLIST = new Set([
  "mail.google.com",
  "chatgpt.com",
  "openai.com",
]);
const FINAL_URL_CACHE = new Map();

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

function getRootDomain(host) {
  if (!host) return "";
  const parts = host.split(".").filter(Boolean);
  if (parts.length <= 2) return host;
  const lastTwo = parts.slice(-2).join(".");
  const lastThree = parts.slice(-3).join(".");
  if (MULTI_PART_TLDS.has(lastTwo)) return lastThree;
  if (parts[parts.length - 1].length <= 2) return lastThree;
  return lastTwo;
}

export function getSiteKey(pageUrl) {
  try {
    if (!isHttpUrl(pageUrl)) return "";
    const host = new URL(pageUrl).hostname;
    if (!host.includes(".")) return "";
    if (host === "localhost" || host.endsWith(".local")) return "";
    const root = getRootDomain(host);
    return root ? `site:${root}` : "";
  } catch (e) {
    // URL 解析失败是预期行为
    return "";
  }
}

export function getFaviconCandidates(pageUrl) {
  try {
    if (!isHttpUrl(pageUrl)) return [];
    const u = new URL(pageUrl);
    const host = u.hostname;
    if (!host.includes(".")) return [];
    if (host === "localhost" || host.endsWith(".local")) return [];
    const special = SPECIAL_FAVICONS[host] || [];
    const root = getRootDomain(host);
    const rootHost = root && root !== host && !ROOT_REUSE_BLOCKLIST.has(root) ? root : "";
    const rawCandidates = [
      ...special,
      `${u.origin}/favicon.ico`,
      rootHost ? `${FAVICON_API}${encodeURIComponent(rootHost)}&sz=128` : "",
      `${FAVICON_API}${encodeURIComponent(host)}&sz=128`,
      rootHost ? `https://icons.duckduckgo.com/ip3/${rootHost}.ico` : "",
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
