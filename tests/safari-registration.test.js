import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { cleanFiles, currentRegistrationKey, staleKeys } from "../scripts/clean-safari-homepage-registrations.mjs";

describe("Safari homepage registrations", () => {
  it("keeps the current signed extension and selects only known historical identities", () => {
    const keys = [
      "com.aeroluna.homepage.safari.extension (WY97WQFBKC)",
      "com.aeroluna.homepage.safari.extension (PSTNW3UN4R)",
      "com.aeroluna.homepage.safari.extension (UNSIGNED)",
      "com.pass.safari.Extension (PSTNW3UN4R)",
    ];
    assert.deepEqual(staleKeys(keys), [
      "com.aeroluna.homepage.safari.extension (PSTNW3UN4R)",
      "com.aeroluna.homepage.safari.extension (UNSIGNED)",
    ]);
  });

  it("backs up the plist and removes only exact stale top-level registrations", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "safari-registration-"));
    const plist = path.join(dir, "Extensions.plist");
    const nestedKey = "com.aeroluna.homepage.safari.extension (UNSIGNED)";
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>${currentRegistrationKey}</key><dict><key>Enabled</key><true/></dict>
  <key>${nestedKey}</key><dict><key>Nested</key><dict><key>${nestedKey}</key><string>keep parent payload isolated</string></dict></dict>
  <key>com.pass.safari.Extension (PSTNW3UN4R)</key><dict><key>Enabled</key><true/></dict>
</dict></plist>`;
    await writeFile(plist, xml);

    try {
      const [result] = await cleanFiles([plist]);
      assert.deepEqual(result.removed, [nestedKey]);
      assert.ok(result.backup);
      assert.equal(await readFile(result.backup, "utf8"), xml);

      const remaining = await cleanFiles([plist]);
      assert.deepEqual(remaining[0].removed, []);
      const binary = await readFile(plist);
      assert.ok(binary.subarray(0, 8).equals(Buffer.from("bplist00")));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
