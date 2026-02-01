import { loadIconCache, saveIconCache } from "./storage.js";

const FAVICON_API = "https://www.google.com/s2/favicons?domain_url=";

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

function blobToDataUrl(blob) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.readAsDataURL(blob);
  });
}

async function fetchFavicon(url) {
  const apiUrl = `${FAVICON_API}${encodeURIComponent(url)}&sz=128`;
  const res = await fetch(apiUrl, { cache: "no-store" });
  if (!res.ok) throw new Error("favicon fetch failed");
  const blob = await res.blob();
  return blobToDataUrl(blob);
}

export async function resolveIcon(node, settings) {
  if (node.iconType === "upload" && node.iconData) return node.iconData;
  if (node.iconType === "remote" && node.iconData) return node.iconData;

  const cache = await loadIconCache();
  const cacheKey = node.url || node.id;
  if (cache[cacheKey]?.dataUrl) return cache[cacheKey].dataUrl;

  if (settings.iconFetch && node.url) {
    try {
      const dataUrl = await fetchFavicon(node.url);
      cache[cacheKey] = { dataUrl, ts: Date.now() };
      await saveIconCache(cache);
      return dataUrl;
    } catch (err) {
      cache[cacheKey] = { dataUrl: "", ts: Date.now(), failed: true };
      await saveIconCache(cache);
    }
  }

  const base = node.title || node.url || "?";
  return avatarDataUrl(base, node.color || hashColor(base));
}

export async function refreshAllIcons(nodes) {
  const cache = await loadIconCache();
  for (const node of nodes) {
    if (!node.url) continue;
    try {
      const dataUrl = await fetchFavicon(node.url);
      cache[node.url] = { dataUrl, ts: Date.now() };
    } catch (err) {
      cache[node.url] = { dataUrl: "", ts: Date.now(), failed: true };
    }
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
    if (cache[key]?.failed) {
      try {
        const dataUrl = await fetchFavicon(key);
        cache[key] = { dataUrl, ts: Date.now() };
        changed = true;
      } catch (err) {
        cache[key] = { ...cache[key], ts: Date.now(), failed: true };
        changed = true;
      }
    }
  }
  if (changed) await saveIconCache(cache);
}
