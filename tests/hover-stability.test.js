import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 提取 CSS 顶层与嵌套规则中所有含 `:hover` 选择器的声明块，
 * 校验 `:hover` 不会改变命中的元素位置或几何盒尺寸（防止边缘悬停反复进出造成抖动）。
 */
function extractHoverRuleBodies(cssText) {
  const clean = cssText.replace(/\/\*[\s\S]*?\*\//g, "");
  const results = [];
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  let match;
  while ((match = ruleRe.exec(clean)) !== null) {
    const selector = match[1].trim();
    const body = match[2].trim();
    if (selector.includes(":hover")) {
      results.push({ selector, body });
    }
  }
  return results;
}

describe("hover hit-target stability", () => {
  it("never shifts transform or box geometry inside :hover rules in styles.css and popup.css", () => {
    const files = ["src/styles.css", "src/popup.css"];
    for (const rel of files) {
      const css = fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
      const hoverRules = extractHoverRuleBodies(css);
      assert.ok(hoverRules.length > 0, `${rel} 应包含 :hover 样式规则`);
      for (const { selector, body } of hoverRules) {
        assert.doesNotMatch(
          body,
          /\b(?:transform|translate|scale|rotate|margin|padding|width|height|top|left|right|bottom)\s*:/i,
          `${rel} 中 "${selector}" 的 :hover 不应改变几何位置或尺寸，否则边缘悬停会引发抖动`,
        );
      }
    }
  });

  it("keeps .tile:hover and .icon-btn:hover stationary with elevation shadow and motion-safe :active feedback", () => {
    const css = fs.readFileSync(path.join(REPO_ROOT, "src/styles.css"), "utf8");
    assert.match(css, /\.icon-btn:hover\s*\{[^}]*box-shadow:/);
    assert.match(css, /\.tile:hover\s*\{[^}]*box-shadow:/);
    assert.match(
      css,
      /@media\s*\(prefers-reduced-motion:\s*no-preference\)\s*\{[^}]*\.icon-btn:active\s*\{[^}]*scale:\s*0\.97;/,
    );
    assert.match(
      css,
      /@media\s*\(prefers-reduced-motion:\s*no-preference\)\s*\{[^}]*\.tile:not\(\.touch-dragging\):active\s*\{[^}]*scale:\s*0\.97;/,
    );
  });
});
