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

export function shouldRestoreSafariStableHomepage(local, stable) {
  if (!stable || typeof stable !== "object") return false;
  if (!local || typeof local !== "object") return true;
  const localNodes = local.nodes && typeof local.nodes === "object" ? Object.keys(local.nodes).length : 0;
  const stableNodes = stable.nodes && typeof stable.nodes === "object" ? Object.keys(stable.nodes).length : 0;
  return localNodes === 0 && stableNodes > 0;
}
