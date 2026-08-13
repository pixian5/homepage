import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const helper = path.resolve("scripts/safari-newtab-selection.py");
const identity = "com.aeroluna.homepage.safari.extension (TESTTEAM01)";

async function withPreferences(preferences, callback) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "safari-newtab-selection-"));
  const plist = path.join(directory, "Safari.plist");
  await writeFile(
    plist,
    `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>${preferences}</dict></plist>`,
  );
  try {
    await callback(plist);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("Safari new-tab selection", () => {
  it("accepts a profile that selects the current signed extension for both entry points", async () => {
    const selection = `<key>DefaultProfile</key><string>${identity}</string>`;
    await withPreferences(
      `<key>IdentifierOfExtensionWithOverridePageForNewTabs</key><dict>${selection}</dict><key>IdentifierOfExtensionWithOverridePageForNewWindows</key><dict>${selection}</dict>`,
      async (plist) => {
        const { stdout } = await execFileAsync("python3", [
          helper,
          "verify",
          "--team-id",
          "TESTTEAM01",
          "--defaults-plist",
          plist,
        ]);
        const result = JSON.parse(stdout);
        assert.deepEqual(result.selected, {
          IdentifierOfExtensionWithOverridePageForNewTabs: true,
          IdentifierOfExtensionWithOverridePageForNewWindows: true,
        });
      },
    );
  });

  it("rejects a selection that is missing the new-window override", async () => {
    await withPreferences(
      `<key>IdentifierOfExtensionWithOverridePageForNewTabs</key><dict><key>DefaultProfile</key><string>${identity}</string></dict>`,
      async (plist) => {
        await assert.rejects(
          execFileAsync("python3", [helper, "verify", "--team-id", "TESTTEAM01", "--defaults-plist", plist]),
          /NewWindows/,
        );
      },
    );
  });
});
