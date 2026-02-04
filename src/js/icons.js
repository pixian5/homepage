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
  } catch {
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
  } catch {
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
    return [
      `${u.origin}/favicon.ico`,
      `${FAVICON_API}${encodeURIComponent(host)}&sz=128`,
      `https://icons.duckduckgo.com/ip3/${host}.ico`,
    ];
  } catch {
    return [];
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
    if (siteKey && !cache[siteKey]) {
      cache[siteKey] = { url: node.iconData, ts: Date.now() };
      await saveIconCache(cache);
    }
    return node.iconData;
  }

  if (node.iconType === "color") {
    const dataUrl = avatarDataUrl(base, node.color || hashColor(base));
    if (siteKey && !cache[siteKey]) {
      cache[siteKey] = { dataUrl, ts: Date.now() };
      await saveIconCache(cache);
    }
    return dataUrl;
  }

  if (siteKey && cache[siteKey]) {
    return cache[siteKey].url || cache[siteKey].dataUrl;
  }

  if (cache[cacheKey]?.url) return cache[cacheKey].url;
  if (cache[cacheKey]?.dataUrl) return cache[cacheKey].dataUrl;

  if (node.iconType === "letter") {
    const dataUrl = avatarDataUrl(base, node.color || hashColor(base));
    if (siteKey && !cache[siteKey]) {
      cache[siteKey] = { dataUrl, ts: Date.now() };
      await saveIconCache(cache);
    }
    return dataUrl;
  }

  if (settings.iconFetch && node.url) {
    const url = buildFaviconUrl(node.url);
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
  for (const node of nodes) {
    if (!node.url) continue;
    const url = buildFaviconUrl(node.url);
    cache[node.url] = { url, ts: Date.now() };
    const siteKey = getSiteKey(node.url);
    if (siteKey) cache[siteKey] = { url, ts: Date.now() };
  }
  await saveIconCache(cache);
}

export async function retryFailedIconsIfDue(settings) {
  if (!settings.iconRetryAtSix) return;
  const now = new Date();
  if (now.getHours() !== 18) return;
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
