import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const script = path.join(root, "scripts", "restore-sync-state.sh");

function hashSyncDocument(doc) {
  const clone = { ...doc, contentHash: "" };
  const text = JSON.stringify(clone);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

async function createArchive(rootDir, state) {
  const source = path.join(rootDir, "source");
  await mkdir(source);
  await writeFile(path.join(source, "homepage-sync-state.json"), JSON.stringify(state));
  const archive = path.join(rootDir, "state.tar.gz");
  await new Promise((resolve, reject) => {
    const child = spawn("tar", ["-czf", archive, "-C", source, "."], { stdio: "ignore" });
    child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`tar exit ${code}`))));
    child.once("error", reject);
  });
  return archive;
}

function runDryRun(archive, dataDir) {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [script, "--archive", archive, "--data-dir", dataDir, "--dry-run"], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

function makeState() {
  const doc = {
    schema: "homepage.sync.doc.v1",
    schemaVersion: 1,
    docId: "doc_restore_test",
    revision: 7,
    deviceId: "device_restore_test",
    writtenAt: 1,
    settings: {},
    groups: [],
    nodes: [],
    placements: [],
    contentHash: "",
  };
  doc.contentHash = hashSyncDocument(doc);
  return { revision: doc.revision, etag: "ignored", updatedAt: 1, epoch: 2, devices: {}, deletions: {}, doc };
}

describe("restore-sync-state", () => {
  it("validates a complete state archive without touching the target", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "homepage-restore-test."));
    try {
      const archive = await createArchive(tempDir, makeState());
      const dataDir = path.join(tempDir, "data");
      const result = await runDryRun(archive, dataDir);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /revision = 7/);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects a state whose content hash was changed", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "homepage-restore-invalid."));
    try {
      const state = makeState();
      state.doc.settings.changed = true;
      const archive = await createArchive(tempDir, state);
      const result = await runDryRun(archive, path.join(tempDir, "data"));
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /状态无效/);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
