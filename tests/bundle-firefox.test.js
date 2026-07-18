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

  it("bundle writes combined file without imports/exports", async () => {
    const srcDir = path.join(workdir, "src");
    const outDir = path.join(workdir, "out");
    await mkdir(srcDir, { recursive: true });
    await mkdir(outDir, { recursive: true });
    await writeFile(
      path.join(srcDir, "a.js"),
      `import { x } from "./x.js";\nexport function a() { return x; }\n`,
      "utf8",
    );
    await writeFile(path.join(srcDir, "b.js"), `export const b = 2;\n`, "utf8");
    const target = path.join(outDir, "app.ff.js");
    await bundle({
      src: srcDir,
      out: outDir,
      target,
      list: ["a.js", "b.js"],
    });
    const output = await readFile(target, "utf8");
    assert.ok(output.includes("/* Firefox bundle (no ESM imports) */"));
    assert.ok(output.includes("function a"));
    assert.ok(output.includes("const b = 2"));
    assert.ok(!output.match(/^\s*import\s+/m));
    assert.ok(!output.match(/\bexport\s+(?=function|const|let|var|class)/));
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

  it("patchHtml throws when script tag missing", async () => {
    const htmlPath = path.join(workdir, "newtab.html");
    await writeFile(htmlPath, `<!DOCTYPE html><html><head></head><body></body></html>`, "utf8");
    await assert.rejects(() => patchHtml(htmlPath), /newtab\.html missing app script tag/);
  });
});
