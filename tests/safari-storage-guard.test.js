import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const helper = path.resolve("scripts/safari-storage-guard.py");
const bundleDirectory = "com.aeroluna.homepage.safari.extension (WY97WQFBKC)";

async function python(code, env) {
  return execFileAsync("python3", ["-c", code], { env: { ...process.env, ...env } });
}

describe("Safari storage update guard", () => {
  it("restores a non-empty snapshot when an update replaces it with empty data", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "safari-storage-guard-"));
    const root = path.join(temp, "WebExtensions");
    const database = path.join(root, "Default", bundleDirectory, "LocalStorage.db");
    const backupRoot = path.join(temp, "backups");
    const env = { SAFARI_WEB_EXTENSIONS_ROOT: root };
    const full = JSON.stringify({ groups: [{ id: "all" }], nodes: { a: {}, b: {} }, backups: [] });
    const empty = JSON.stringify({ groups: [{ id: "all" }], nodes: {}, backups: [] });
    const writeDatabase = `
import sqlite3
from pathlib import Path
p=Path(${JSON.stringify(database)})
p.parent.mkdir(parents=True, exist_ok=True)
c=sqlite3.connect(p)
c.execute("CREATE TABLE IF NOT EXISTS extension_storage (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)")
c.execute("INSERT OR REPLACE INTO extension_storage VALUES (?, ?)", ("homepage_data", ${JSON.stringify(full)}))
c.commit(); c.close()`;

    try {
      await python(writeDatabase, env);
      const { stdout } = await execFileAsync("python3", [helper, "snapshot", "--output-root", backupRoot], {
        env: { ...process.env, ...env },
      });
      const snapshot = JSON.parse(stdout).snapshot;
      await python(
        `import sqlite3; c=sqlite3.connect(${JSON.stringify(database)}); c.execute("UPDATE extension_storage SET value=? WHERE key='homepage_data'", (${JSON.stringify(empty)},)); c.commit(); c.close()`,
        env,
      );

      await assert.rejects(
        execFileAsync("python3", [helper, "verify", "--snapshot", snapshot, "--restore-on-regression"], {
          env: { ...process.env, ...env },
        }),
      );
      const { stdout: restored } = await python(
        `import sqlite3; c=sqlite3.connect(${JSON.stringify(database)}); print(c.execute("SELECT value FROM extension_storage WHERE key='homepage_data'").fetchone()[0]); c.close()`,
        env,
      );
      assert.equal(JSON.parse(restored).nodes && Object.keys(JSON.parse(restored).nodes).length, 2);
      assert.equal(JSON.parse(await readFile(path.join(snapshot, "manifest.json"), "utf8")).metrics.nodeCount, 2);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it("restores settings-only data when both versions contain zero nodes", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "safari-storage-settings-"));
    const root = path.join(temp, "WebExtensions");
    const database = path.join(root, "Default", bundleDirectory, "LocalStorage.db");
    const backupRoot = path.join(temp, "backups");
    const env = { SAFARI_WEB_EXTENSIONS_ROOT: root };
    const original = JSON.stringify({
      groups: [{ id: "grp_all", nodes: [] }],
      nodes: {},
      backups: [{ id: "saved" }],
      settings: { theme: "dark" },
    });
    const replacement = JSON.stringify({
      groups: [{ id: "grp_all", nodes: [] }],
      nodes: {},
      backups: [],
      settings: { theme: "system", padding: "larger-default-payload" },
    });
    const createDatabase = `
import sqlite3
from pathlib import Path
p=Path(${JSON.stringify(database)})
p.parent.mkdir(parents=True, exist_ok=True)
c=sqlite3.connect(p)
c.execute("CREATE TABLE extension_storage (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)")
c.execute("INSERT INTO extension_storage VALUES (?, ?)", ("homepage_data", ${JSON.stringify(original)}))
c.commit(); c.close()`;

    try {
      await python(createDatabase, env);
      const { stdout } = await execFileAsync("python3", [helper, "snapshot", "--output-root", backupRoot], {
        env: { ...process.env, ...env },
      });
      const snapshot = JSON.parse(stdout).snapshot;
      await python(
        `import sqlite3; c=sqlite3.connect(${JSON.stringify(database)}); c.execute("UPDATE extension_storage SET value=? WHERE key='homepage_data'", (${JSON.stringify(replacement)},)); c.commit(); c.close()`,
        env,
      );
      await assert.rejects(
        execFileAsync("python3", [helper, "verify", "--snapshot", snapshot, "--restore-on-regression"], {
          env: { ...process.env, ...env },
        }),
      );
      const { stdout: restored } = await python(
        `import sqlite3; c=sqlite3.connect(${JSON.stringify(database)}); print(c.execute("SELECT value FROM extension_storage WHERE key='homepage_data'").fetchone()[0]); c.close()`,
        env,
      );
      assert.deepEqual(JSON.parse(restored), JSON.parse(original));
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
});
