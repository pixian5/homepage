/**
 * 客户端端到端加密（E2EE）单元与真实同步服务端集成测试：
 * 1. PBKDF2-SHA256 + AES-256-GCM 往返加解密、随机 Salt/IV、错误口令/空口令/篡改阻断；
 * 2. syncE2eePassphrase 绝对不进入 toSyncDocument 同步投影；
 * 3. sync_engine 对接真实 scripts/sync-server.mjs：服务器磁盘仅存密文信封（零明文书签/URL），
 *    另一端错误口令拒绝解密、正确口令可完整拉取解密并协同推送。
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { defaultData } from "../src/js/storage.js";
import { decryptSyncDocument, encryptSyncDocument, isEncryptedSyncEnvelope } from "../src/js/sync_crypto.js";
import { initSyncEngine, pullNow, pushNow, rotateE2eePassphrase } from "../src/js/sync_engine.js";
import { hashSyncDocument, toSyncDocument } from "../src/js/sync_projection.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const realChrome = globalThis.chrome;

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function stopServer(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 1000)),
  ]);
  if (child.exitCode === null && !child.signalCode) child.kill("SIGKILL");
}

function makeMemoryStorage() {
  const store = new Map();
  const area = {
    get(keys, cb) {
      const out = {};
      if (typeof keys === "string") {
        if (store.has(keys)) out[keys] = structuredClone(store.get(keys));
      } else if (Array.isArray(keys)) {
        for (const k of keys) if (store.has(k)) out[k] = structuredClone(store.get(k));
      }
      cb?.(out);
      return Promise.resolve(out);
    },
    set(obj, cb) {
      for (const [k, v] of Object.entries(obj)) store.set(k, structuredClone(v));
      cb?.();
      return Promise.resolve();
    },
    remove(keys, cb) {
      for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
      cb?.();
      return Promise.resolve();
    },
  };
  return { area, store };
}

describe("sync_crypto & end-to-end encrypted sync", () => {
  const cleanups = [];

  afterEach(async () => {
    globalThis.chrome = realChrome;
    while (cleanups.length) {
      const { child, tmpDir } = cleanups.pop();
      await stopServer(child);
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("encrypts and decrypts SyncDocument with AES-256-GCM and rejects wrong or missing passphrases", async () => {
    const data = defaultData();
    data.settings.syncE2eeEnabled = true;
    data.settings.syncE2eePassphrase = "MyTopSecretPassphrase!2026";
    data.nodes.itm_secret = {
      id: "itm_secret",
      type: "item",
      title: "绝密内网系统",
      url: "https://internal-secret.corp/admin",
      updatedAt: 1000,
      updatedBy: "dev_a",
    };
    data.groups[0].nodes.push("itm_secret");

    const plainDoc = toSyncDocument(data, { deviceId: "dev_a", docId: "doc_e2ee", revision: 1, writtenAt: 1000 });
    plainDoc.contentHash = hashSyncDocument(plainDoc);

    // 口令绝对不得随投影同步到云端
    assert.equal(plainDoc.settings.syncE2eePassphrase, undefined);

    const env1 = await encryptSyncDocument(plainDoc, data.settings.syncE2eePassphrase);
    const env2 = await encryptSyncDocument(plainDoc, data.settings.syncE2eePassphrase);
    assert.equal(isEncryptedSyncEnvelope(env1), true);
    assert.notEqual(env1.salt, env2.salt);
    assert.notEqual(env1.iv, env2.iv);

    const serialized = JSON.stringify(env1);
    assert.equal(serialized.includes("绝密内网系统"), false);
    assert.equal(serialized.includes("internal-secret.corp"), false);

    // 模拟服务端递增 revision 后解密
    env1.revision = 4;
    const restored = await decryptSyncDocument(env1, "MyTopSecretPassphrase!2026");
    assert.equal(restored.revision, 4);
    assert.equal(restored.nodes[0].title, "绝密内网系统");

    await assert.rejects(
      () => decryptSyncDocument(env1, ""),
      (e) => e.code === "e2ee_passphrase_required",
    );
    await assert.rejects(
      () => decryptSyncDocument(env1, "wrong-pass"),
      (e) => e.code === "e2ee_decrypt_failed",
    );

    const tampered = { ...env1, ciphertext: `${env1.ciphertext.slice(0, -4)}AAAA` };
    await assert.rejects(
      () => decryptSyncDocument(tampered, "MyTopSecretPassphrase!2026"),
      (e) => e.code === "e2ee_decrypt_failed",
    );
  });

  it("syncs encrypted envelopes through real sync-server without leaking plaintext on disk", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "homepage-sync-e2ee-"));
    const port = await freePort();
    const dataFile = path.join(tmpDir, "state.json");
    const token = "e2ee-server-token";
    const child = spawn(process.execPath, [path.join(root, "scripts/sync-server.mjs")], {
      env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", TOKEN: token, DATA_FILE: dataFile },
      stdio: ["ignore", "pipe", "pipe"],
    });
    cleanups.push({ child, tmpDir });
    const baseUrl = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        if ((await fetch(`${baseUrl}/health`)).ok) break;
      } catch {
        // retry
      }
      await new Promise((r) => setTimeout(r, 40));
    }

    // 设备 A：写入加密数据
    const storA = makeMemoryStorage();
    globalThis.chrome = { runtime: { lastError: null }, storage: { local: storA.area } };
    let dataA = defaultData();
    Object.assign(dataA.settings, {
      syncEnabled: true,
      syncServerUrl: baseUrl,
      syncServerToken: token,
      syncE2eeEnabled: true,
      syncE2eePassphrase: "SharedSecret!Key#2026",
    });
    dataA.nodes.itm_a = {
      id: "itm_a",
      type: "item",
      title: "隐秘资产",
      url: "https://vault.private.invalid/vault",
      updatedAt: Date.now(),
      updatedBy: "",
    };
    dataA.groups[0].nodes.push("itm_a");

    initSyncEngine({
      getData: () => dataA,
      setData: (next) => {
        dataA = next;
      },
      saveLocal: async () => null,
    });
    const pushedA = await pushNow("manual");
    assert.equal(pushedA.ok, true);

    // 核查服务端磁盘文件绝对不包含任何明文书签内容或口令
    const diskRaw = await readFile(dataFile, "utf8");
    assert.equal(diskRaw.includes("homepage.sync.e2ee.v1"), true);
    assert.equal(diskRaw.includes("隐秘资产"), false);
    assert.equal(diskRaw.includes("vault.private.invalid"), false);
    assert.equal(diskRaw.includes("SharedSecret!Key#2026"), false);

    // 设备 B：先用空口令与错误口令拉取，均必须干净拒绝且不破坏本地
    const storB = makeMemoryStorage();
    globalThis.chrome = { runtime: { lastError: null }, storage: { local: storB.area } };
    let dataB = defaultData();
    Object.assign(dataB.settings, {
      syncEnabled: true,
      syncServerUrl: baseUrl,
      syncServerToken: token,
      syncE2eeEnabled: true,
      syncE2eePassphrase: "",
    });
    initSyncEngine({
      getData: () => dataB,
      setData: (next) => {
        dataB = next;
      },
      saveLocal: async () => null,
    });
    const noPassPull = await pullNow("manual");
    assert.equal(noPassPull.ok, false);
    assert.equal(noPassPull.reason, "e2ee_passphrase_required");
    assert.equal(dataB.nodes.itm_a, undefined);

    dataB.settings.syncE2eePassphrase = "WrongPassphrase";
    const wrongPassPull = await pullNow("manual");
    assert.equal(wrongPassPull.ok, false);
    assert.equal(wrongPassPull.reason, "e2ee_decrypt_failed");

    // 填入正确口令后成功解密合并
    dataB.settings.syncE2eePassphrase = "SharedSecret!Key#2026";
    const okPull = await pullNow("manual");
    assert.equal(okPull.ok, true);
    assert.equal(dataB.nodes.itm_a?.title, "隐秘资产");
    assert.equal(dataB.nodes.itm_a?.url, "https://vault.private.invalid/vault");
  });

  it("migrates remote envelope plaintext <-> e2ee cleanly and blocks unauthorized overwrite on pushNow", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "homepage-sync-e2ee-mig-"));
    const port = await freePort();
    const dataFile = path.join(tmpDir, "state.json");
    const token = "e2ee-mig-token";
    const child = spawn(process.execPath, [path.join(root, "scripts/sync-server.mjs")], {
      env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", TOKEN: token, DATA_FILE: dataFile },
      stdio: ["ignore", "pipe", "pipe"],
    });
    cleanups.push({ child, tmpDir });
    const baseUrl = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        if ((await fetch(`${baseUrl}/health`)).ok) break;
      } catch {
        // retry
      }
      await new Promise((r) => setTimeout(r, 40));
    }

    // 1. 先明文同步书签
    const storA = makeMemoryStorage();
    globalThis.chrome = { runtime: { lastError: null }, storage: { local: storA.area } };
    let dataA = defaultData();
    Object.assign(dataA.settings, {
      syncEnabled: true,
      syncServerUrl: baseUrl,
      syncServerToken: token,
      syncE2eeEnabled: false,
      syncE2eePassphrase: "",
    });
    dataA.nodes.itm_mig = {
      id: "itm_mig",
      type: "item",
      title: "迁移书签",
      url: "https://migrate.private.invalid/",
      updatedAt: Date.now(),
      updatedBy: "",
    };
    dataA.groups[0].nodes.push("itm_mig");

    initSyncEngine({
      getData: () => dataA,
      setData: (next) => {
        dataA = next;
      },
      saveLocal: async () => null,
    });
    assert.equal((await pushNow("manual")).ok, true);
    assert.equal((await readFile(dataFile, "utf8")).includes("迁移书签"), true);

    // 2. 开启 E2EE 后书签内容未变：pullNow 不应短路而是提示 needPush，pushNow 后磁盘转成密文
    dataA.settings.syncE2eeEnabled = true;
    dataA.settings.syncE2eePassphrase = "MigPassphrase#2026";
    const enablePull = await pullNow("enable");
    assert.equal(enablePull.ok, true);
    assert.equal(enablePull.unchanged, false);
    assert.equal(enablePull.needPush, true);
    assert.equal((await pushNow("enable")).ok, true);

    const encryptedDiskRaw = await readFile(dataFile, "utf8");
    assert.equal(encryptedDiskRaw.includes("homepage.sync.e2ee.v1"), true);
    assert.equal(encryptedDiskRaw.includes("迁移书签"), false);

    // 3. 关闭 E2EE 后书签内容未变：pullNow 同样返回 needPush，pushNow 后恢复明文
    dataA.settings.syncE2eeEnabled = false;
    const disablePull = await pullNow("enable");
    assert.equal(disablePull.ok, true);
    assert.equal(disablePull.needPush, true);
    assert.equal((await pushNow("enable")).ok, true);
    const plainAgainRaw = await readFile(dataFile, "utf8");
    assert.equal(plainAgainRaw.includes("homepage.sync.e2ee.v1"), false);
    assert.equal(plainAgainRaw.includes("迁移书签"), true);

    // 4. 切回 E2EE 推送密文后，用无口令/错口令的新设备直接调用 pushNow 必须被预拉取安全阻断且不覆写远端密文
    dataA.settings.syncE2eeEnabled = true;
    assert.equal((await pullNow("enable")).needPush, true);
    assert.equal((await pushNow("enable")).ok, true);
    const sealedDiskRaw = await readFile(dataFile, "utf8");
    assert.equal(sealedDiskRaw.includes("homepage.sync.e2ee.v1"), true);

    const storC = makeMemoryStorage();
    globalThis.chrome = { runtime: { lastError: null }, storage: { local: storC.area } };
    let dataC = defaultData();
    Object.assign(dataC.settings, {
      syncEnabled: true,
      syncServerUrl: baseUrl,
      syncServerToken: token,
      syncE2eeEnabled: false,
      syncE2eePassphrase: "",
    });
    initSyncEngine({
      getData: () => dataC,
      setData: (next) => {
        dataC = next;
      },
      saveLocal: async () => null,
    });
    const noPassPush = await pushNow("manual");
    assert.equal(noPassPush.ok, false);
    assert.equal(noPassPush.reason, "e2ee_passphrase_required");

    dataC.settings.syncE2eePassphrase = "WrongSecret";
    const wrongPassPush = await pushNow("manual");
    assert.equal(wrongPassPush.ok, false);
    assert.equal(wrongPassPush.reason, "e2ee_decrypt_failed");

    const afterState = JSON.parse(await readFile(dataFile, "utf8"));
    const sealedState = JSON.parse(sealedDiskRaw);
    assert.equal(afterState.revision, sealedState.revision);
    assert.equal(afterState.doc?.schema, "homepage.sync.e2ee.v1");
    assert.equal(afterState.doc?.contentHash, sealedState.doc?.contentHash);
    assert.equal(afterState.doc?.ciphertext, sealedState.doc?.ciphertext);
  });

  it("rotates E2EE passphrase safely without corrupting local state or remote ciphertext on bad old passphrase", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "homepage-sync-e2ee-rot-"));
    const port = await freePort();
    const dataFile = path.join(tmpDir, "state.json");
    const token = "e2ee-rot-token";
    const child = spawn(process.execPath, [path.join(root, "scripts/sync-server.mjs")], {
      env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", TOKEN: token, DATA_FILE: dataFile },
      stdio: ["ignore", "pipe", "pipe"],
    });
    cleanups.push({ child, tmpDir });
    const baseUrl = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        if ((await fetch(`${baseUrl}/health`)).ok) break;
      } catch {
        // retry
      }
      await new Promise((r) => setTimeout(r, 40));
    }

    const stor = makeMemoryStorage();
    globalThis.chrome = { runtime: { lastError: null }, storage: { local: stor.area } };
    let data = defaultData();
    Object.assign(data.settings, {
      syncEnabled: true,
      syncServerUrl: baseUrl,
      syncServerToken: token,
      syncE2eeEnabled: true,
      syncE2eePassphrase: "OldPassphrase#1",
    });
    data.nodes.itm_rot = {
      id: "itm_rot",
      type: "item",
      title: "口令轮换书签",
      url: "https://rotate.example/",
      updatedAt: Date.now(),
      updatedBy: "",
    };
    data.groups[0].nodes.push("itm_rot");

    initSyncEngine({
      getData: () => data,
      setData: (next) => {
        data = next;
      },
      saveLocal: async () => null,
    });
    assert.equal((await pushNow("manual")).ok, true);

    // 错旧口令被拒绝，不改动本地口令
    const badRotate = await rotateE2eePassphrase({ oldPassphrase: "WrongOldPass", newPassphrase: "NewPassphrase#2" });
    assert.equal(badRotate.ok, false);
    assert.equal(badRotate.reason, "e2ee_decrypt_failed");
    assert.equal(data.settings.syncE2eePassphrase, "OldPassphrase#1");

    // 正确旧口令轮换成功
    const okRotate = await rotateE2eePassphrase({ oldPassphrase: "OldPassphrase#1", newPassphrase: "NewPassphrase#2" });
    assert.equal(okRotate.ok, true);
    assert.equal(data.settings.syncE2eePassphrase, "NewPassphrase#2");

    // 服务端新密文无法再用旧口令解开，可用新口令正常解密
    const onDisk = JSON.parse(await readFile(dataFile, "utf8"));
    await assert.rejects(() => decryptSyncDocument(onDisk.doc, "OldPassphrase#1"));
    const restored = await decryptSyncDocument(onDisk.doc, "NewPassphrase#2");
    assert.equal(restored.nodes[0].title, "口令轮换书签");
  });
});
