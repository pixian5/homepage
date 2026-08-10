import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { safariBuildNumber, syncSafariVersionText } from "../scripts/sync-safari-version.mjs";

describe("Safari version synchronization", () => {
  it("converts the extension version into a monotonic numeric build", () => {
    assert.equal(safariBuildNumber("24.0"), 2400);
    assert.equal(safariBuildNumber("24.1"), 2401);
    assert.equal(safariBuildNumber("1.2.3"), 10203);
  });

  it("updates every host and extension configuration", () => {
    const source = `
      CURRENT_PROJECT_VERSION = 1;
      MARKETING_VERSION = 1.0;
      CURRENT_PROJECT_VERSION = 7;
      MARKETING_VERSION = 2.0;
    `;
    const updated = syncSafariVersionText(source, "24.0");
    assert.equal((updated.match(/CURRENT_PROJECT_VERSION = 2400;/g) || []).length, 2);
    assert.equal((updated.match(/MARKETING_VERSION = 24.0;/g) || []).length, 2);
  });

  it("rejects projects without version settings", () => {
    assert.throws(() => syncSafariVersionText("// empty project", "24.0"), /no version build settings/);
  });
});
