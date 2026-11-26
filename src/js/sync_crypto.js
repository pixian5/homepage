/**
 * 可选客户端端到端加密（E2EE）模块。
 *
 * 算法：Web Crypto API —— PBKDF2-SHA256 (150,000 次迭代派生 256-bit AES-GCM 密钥) + 12 字节随机 IV。
 * 口令仅保存在本地设备，绝不随 sync_settings 白名单同步，服务端仅见密文与最小路由元数据。
 *
 * 用 IIFE 包裹：兼容 Firefox 经典脚本合并拓扑。
 */

import { hashSyncDocument } from "./sync_projection.js";

var HomepageSyncCrypto = (() => {
  const E2EE_SCHEMA = "homepage.sync.e2ee.v1";
  const E2EE_ALG = "PBKDF2-SHA256+AES-256-GCM";
  const DEFAULT_ITERATIONS = 150_000;

  function bytesToBase64(bytes) {
    let bin = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }

  function base64ToBytes(b64) {
    const bin = atob(String(b64 || "").trim());
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) {
      out[i] = bin.charCodeAt(i);
    }
    return out;
  }

  function getSubtleCrypto() {
    const cryptoApi = globalThis.crypto;
    if (!cryptoApi?.subtle || typeof cryptoApi.getRandomValues !== "function") {
      const err = new Error("webcrypto_unavailable");
      err.code = "webcrypto_unavailable";
      throw err;
    }
    return { cryptoApi, subtle: cryptoApi.subtle };
  }

  /**
   * 判断文档是否为加密信封。
   * @param {unknown} doc
   * @returns {boolean}
   */
  function isEncryptedSyncEnvelope(doc) {
    return !!doc && typeof doc === "object" && doc.schema === E2EE_SCHEMA && doc.schemaVersion === 1;
  }

  async function deriveAesKey(passphrase, saltBytes, iterations = DEFAULT_ITERATIONS) {
    const { subtle } = getSubtleCrypto();
    const enc = new TextEncoder();
    const keyMaterial = await subtle.importKey("raw", enc.encode(passphrase), { name: "PBKDF2" }, false, ["deriveKey"]);
    return subtle.deriveKey(
      { name: "PBKDF2", salt: saltBytes, iterations, hash: "SHA-256" },
      keyMaterial,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  }

  /**
   * 加密 SyncDocument 为可由服务端校验路由并保存的 E2EE 信封。
   * @param {object} plainDoc
   * @param {string} passphrase
   * @returns {Promise<object>}
   */
  async function encryptSyncDocument(plainDoc, passphrase) {
    const secret = String(passphrase || "");
    if (!secret) {
      const err = new Error("e2ee_passphrase_required");
      err.code = "e2ee_passphrase_required";
      throw err;
    }
    const { cryptoApi, subtle } = getSubtleCrypto();
    const salt = new Uint8Array(16);
    const iv = new Uint8Array(12);
    cryptoApi.getRandomValues(salt);
    cryptoApi.getRandomValues(iv);

    const key = await deriveAesKey(secret, salt, DEFAULT_ITERATIONS);
    const plaintext = new TextEncoder().encode(JSON.stringify(plainDoc));
    const cipherBuffer = await subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);

    const envelope = {
      schema: E2EE_SCHEMA,
      schemaVersion: 1,
      alg: E2EE_ALG,
      iterations: DEFAULT_ITERATIONS,
      docId: String(plainDoc?.docId || ""),
      revision: Number(plainDoc?.revision) || 1,
      deviceId: String(plainDoc?.deviceId || ""),
      writtenAt: Number(plainDoc?.writtenAt) || Date.now(),
      salt: bytesToBase64(salt),
      iv: bytesToBase64(iv),
      ciphertext: bytesToBase64(new Uint8Array(cipherBuffer)),
      contentHash: "",
    };
    envelope.contentHash = hashSyncDocument(envelope);
    return envelope;
  }

  /**
   * 解密 E2EE 信封，并将外层服务端递增的 authoritative revision 写回内部文档。
   * @param {object} envelope
   * @param {string} passphrase
   * @returns {Promise<object>}
   */
  async function decryptSyncDocument(envelope, passphrase) {
    if (!isEncryptedSyncEnvelope(envelope)) return envelope;
    const secret = String(passphrase || "");
    if (!secret) {
      const err = new Error("e2ee_passphrase_required");
      err.code = "e2ee_passphrase_required";
      throw err;
    }
    if (envelope.alg && envelope.alg !== E2EE_ALG) {
      const err = new Error("e2ee_unsupported_alg");
      err.code = "e2ee_decrypt_failed";
      throw err;
    }
    const iterations =
      Number.isSafeInteger(envelope.iterations) && envelope.iterations >= 10000
        ? envelope.iterations
        : DEFAULT_ITERATIONS;
    try {
      const { subtle } = getSubtleCrypto();
      const salt = base64ToBytes(envelope.salt);
      const iv = base64ToBytes(envelope.iv);
      const ciphertext = base64ToBytes(envelope.ciphertext);
      const key = await deriveAesKey(secret, salt, iterations);
      const plainBuffer = await subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
      const doc = JSON.parse(new TextDecoder().decode(plainBuffer));
      if (!doc || typeof doc !== "object") {
        const err = new Error("e2ee_invalid_plaintext");
        err.code = "e2ee_decrypt_failed";
        throw err;
      }
      if (Number.isSafeInteger(envelope.revision)) {
        doc.revision = envelope.revision;
      }
      return doc;
    } catch (error) {
      if (error?.code === "e2ee_passphrase_required" || error?.code === "webcrypto_unavailable") throw error;
      const wrapped = new Error("e2ee_decrypt_failed");
      wrapped.code = "e2ee_decrypt_failed";
      throw wrapped;
    }
  }

  return {
    E2EE_SCHEMA,
    E2EE_ALG,
    isEncryptedSyncEnvelope,
    encryptSyncDocument,
    decryptSyncDocument,
  };
})();

export const E2EE_SCHEMA = HomepageSyncCrypto.E2EE_SCHEMA;
export const E2EE_ALG = HomepageSyncCrypto.E2EE_ALG;
export const isEncryptedSyncEnvelope = HomepageSyncCrypto.isEncryptedSyncEnvelope;
export const encryptSyncDocument = HomepageSyncCrypto.encryptSyncDocument;
export const decryptSyncDocument = HomepageSyncCrypto.decryptSyncDocument;
