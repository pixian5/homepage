const SAFARI_APP_ID = "com.aeroluna.homepage.safari";
const READ_TYPE = "homepage.storage.read";
const WRITE_TYPE = "homepage.storage.write";
const CLEAR_TYPE = "homepage.storage.clear";

export function isSafariWebExtension(api = globalThis.chrome) {
  try {
    return String(api?.runtime?.getURL?.("") || "").startsWith("safari-web-extension://");
  } catch {
    return false;
  }
}

function sendNativeMessage(message, api = globalThis.chrome) {
  if (!isSafariWebExtension(api) || typeof api?.runtime?.sendNativeMessage !== "function") return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      api.runtime.sendNativeMessage(SAFARI_APP_ID, message, (response) => {
        if (api.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve(response || null);
      });
    } catch {
      resolve(null);
    }
  });
}

export async function readSafariStableHomepage(api = globalThis.chrome) {
  const response = await sendNativeMessage({ type: READ_TYPE }, api);
  return response?.ok && response.data && typeof response.data === "object" ? response.data : null;
}

export async function writeSafariStableHomepage(data, api = globalThis.chrome) {
  if (!data || typeof data !== "object") return false;
  const response = await sendNativeMessage({ type: WRITE_TYPE, data }, api);
  return response?.ok === true;
}

export async function clearSafariStableHomepage(api = globalThis.chrome) {
  const response = await sendNativeMessage({ type: CLEAR_TYPE }, api);
  return response?.ok === true;
}

function isDefaultLikeHomepage(data, fallback) {
  if (!data || typeof data !== "object" || !fallback || typeof fallback !== "object") return false;
  const nodes = data.nodes && typeof data.nodes === "object" ? Object.keys(data.nodes) : [];
  const backups = Array.isArray(data.backups) ? data.backups : [];
  const groups = Array.isArray(data.groups) ? data.groups : [];
  const onlySystemRoot =
    groups.length === 1 &&
    (groups[0]?.systemAllGroup === true || groups[0]?.id === "grp_all") &&
    (!Array.isArray(groups[0]?.nodes) || groups[0].nodes.length === 0);
  const settings = data.settings && typeof data.settings === "object" ? data.settings : {};
  const fallbackSettings = fallback.settings && typeof fallback.settings === "object" ? fallback.settings : {};
  const settingsMatch = Object.keys(fallbackSettings).every((key) => settings[key] === fallbackSettings[key]);
  return nodes.length === 0 && backups.length === 0 && onlySystemRoot && settingsMatch;
}

export function shouldRestoreSafariStableHomepage(local, stable, fallback = null) {
  if (!stable || typeof stable !== "object") return false;
  if (!local || typeof local !== "object") return true;
  const localNodes = local.nodes && typeof local.nodes === "object" ? Object.keys(local.nodes).length : 0;
  const stableNodes = stable.nodes && typeof stable.nodes === "object" ? Object.keys(stable.nodes).length : 0;
  if (localNodes === 0 && stableNodes > 0) return true;
  const localBackups = Array.isArray(local.backups) ? local.backups.length : 0;
  const stableBackups = Array.isArray(stable.backups) ? stable.backups.length : 0;
  if (localNodes === 0 && stableNodes === 0 && localBackups === 0 && stableBackups > 0) return true;
  return isDefaultLikeHomepage(local, fallback) && !isDefaultLikeHomepage(stable, fallback);
}
