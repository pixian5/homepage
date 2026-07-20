import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

const { stripImports, stripExports, bundle, patchHtml } = await import("../scripts/bundle-firefox.mjs");

let workdir = "";

beforeEach(async () => {
  workdir = await mkdtemp(path.join(tmpdir(), "homepage-firefox-"));
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

describe("bundle-firefox", () => {
  it("stripImports removes top-level import statements", () => {
    const code = `import { a } from "./a.js";\nimport b from "./b.js";\nconst x = 1;`;
    const result = stripImports(code);
    assert.ok(!result.includes("import"));
    assert.ok(result.includes("const x = 1;"));
  });

  it("stripExports removes export keyword but keeps declaration", () => {
    const code = `export function foo() {}\nexport const bar = 1;`;
    const result = stripExports(code);
    assert.ok(!result.match(/\bexport\s+(?=function|const)/));
    assert.ok(result.includes("function foo"));
    assert.ok(result.includes("const bar"));
  });

  it("stripExports removes re-export and export default forms", () => {
    const code = `export { a, b };\nexport { c } from "./c.js";\nexport * from "./d.js";\nexport default function x() {}`;
    const result = stripExports(code);
    assert.ok(!/\bexport\b/.test(result));
    assert.ok(result.includes("function x()"));
  });

  it("bundle writes combined file without imports/exports", async () => {
    const srcDir = path.join(workdir, "src");
    const outDir = path.join(workdir, "out");
    await mkdir(srcDir, { recursive: true });
    await mkdir(outDir, { recursive: true });
    await writeFile(
      path.join(srcDir, "a.js"),
      `import { x } from "./x.js";\nexport function a() { return x; }\nexport { a as b };\n`,
      "utf8",
    );
    await writeFile(path.join(srcDir, "b.js"), `export const b = 2;\nexport default b;\n`, "utf8");
    const target = path.join(outDir, "app.ff.js");
    await bundle({
      src: srcDir,
      out: outDir,
      target,
      list: ["a.js", "b.js"],
      validate: true,
    });
    const output = await readFile(target, "utf8");
    assert.ok(output.includes("/* Firefox bundle (no ESM imports) */"));
    assert.ok(output.includes("function a"));
    assert.ok(output.includes("const b = 2"));
    assert.ok(!output.match(/^\s*import\s+/m));
    assert.ok(!/\bexport\b/.test(output));
  });

  it("real src modules bundle is classic-script parseable", async () => {
    const vm = await import("node:vm");
    const { assertClassicScript } = await import("../scripts/bundle-firefox.mjs");
    const outDir = path.join(workdir, "real-out");
    const target = path.join(outDir, "app.ff.js");
    const srcDir = path.join(process.cwd(), "src", "js");
    const output = await bundle({
      src: srcDir,
      out: outDir,
      target,
      list: [
        "shared-utils.js",
        "data-utils.js",
        "storage.js",
        "icons.js",
        "bing-wallpaper.js",
        "visit-history.js",
        "sync_policy.js",
        "sync_ids.js",
        "sync_projection.js",
        "sync_merge.js",
        "sync_bundle.js",
        "sync_pack.js",
        "sync_outbox.js",
        "sync_http_transport.js",
        "sync_engine.js",
        "app.js",
      ],
      validate: true,
    });
    assertClassicScript(output, vm);
    assert.ok(!/^\s*export\b/m.test(output));
    assert.ok(!/^\s*import\b/m.test(output));
  });

  it("patchHtml replaces ESM module script with external bundle script", async () => {
    const htmlPath = path.join(workdir, "newtab.html");
    await writeFile(
      htmlPath,
      `<!DOCTYPE html><html><head><script type="module" src="js/app.js"></script></head><body></body></html>`,
      "utf8",
    );
    await patchHtml(htmlPath);
    const updated = await readFile(htmlPath, "utf8");
    assert.ok(updated.includes('<script src="js/app.ff.js"></script>'));
    assert.ok(!updated.includes('type="module"'));
  });

  it("patchHtml is idempotent when already patched", async () => {
    const htmlPath = path.join(workdir, "newtab.html");
    const already = `<!DOCTYPE html><html><head><script src="js/app.ff.js"></script></head><body></body></html>`;
    await writeFile(htmlPath, already, "utf8");
    await patchHtml(htmlPath);
    const updated = await readFile(htmlPath, "utf8");
    assert.equal(updated, already);
  });

  it("real bundle does not reference missing import aliases", async () => {
    const outDir = path.join(workdir, "alias-out");
    const target = path.join(outDir, "app.ff.js");
    const srcDir = path.join(process.cwd(), "src", "js");
    const output = await bundle({
      src: srcDir,
      out: outDir,
      target,
      list: [
        "shared-utils.js",
        "data-utils.js",
        "storage.js",
        "icons.js",
        "bing-wallpaper.js",
        "visit-history.js",
        "sync_policy.js",
        "sync_ids.js",
        "sync_projection.js",
        "sync_merge.js",
        "sync_bundle.js",
        "sync_pack.js",
        "sync_outbox.js",
        "sync_http_transport.js",
        "sync_engine.js",
        "app.js",
      ],
      validate: true,
    });
    assert.ok(!output.includes("sharedNormalizeUrl"), "import alias must not survive classic bundle");
    // normalizeUrl must exist as a function from shared-utils
    assert.match(output, /function normalizeUrl\s*\(/);
  });

  it("patchHtml throws when script tag missing", async () => {
    const htmlPath = path.join(workdir, "newtab.html");
    await writeFile(htmlPath, `<!DOCTYPE html><html><head></head><body></body></html>`, "utf8");
    await assert.rejects(() => patchHtml(htmlPath), /newtab\.html missing app script tag/);
  });
});
