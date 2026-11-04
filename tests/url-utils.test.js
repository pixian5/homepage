import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { normalizeUrl, normalizeUrlWithScheme } from "../src/js/shared-utils.js";

describe("url utils in shared-utils", () => {
  describe("normalizeUrl", () => {
    test("prepends https when protocol is missing", () => {
      assert.equal(normalizeUrl("example.com"), "https://example.com/");
      assert.equal(normalizeUrl("sub.example.com/path?a=1"), "https://sub.example.com/path?a=1");
    });

    test("keeps safe protocols intact", () => {
      assert.equal(normalizeUrl("http://example.com/"), "http://example.com/");
      assert.equal(normalizeUrl("https://example.com/"), "https://example.com/");
      assert.equal(normalizeUrl("ftp://ftp.example.com/"), "ftp://ftp.example.com/");
    });

    test("drops dangerous schemes", () => {
      assert.equal(normalizeUrl("javascript:alert(1)"), "");
      assert.equal(normalizeUrl("data:text/html,bad"), "");
      assert.equal(normalizeUrl("vbscript:bad"), "");
      assert.equal(normalizeUrl("file:///etc/passwd"), "");
    });

    test("handles empty and malformed input safely", () => {
      assert.equal(normalizeUrl(""), "");
      assert.equal(normalizeUrl("   "), "");
      assert.equal(normalizeUrl(null), "");
      assert.equal(normalizeUrl(undefined), "");
    });
  });

  describe("normalizeUrlWithScheme", () => {
    test("uses provided fallback scheme when missing", () => {
      assert.equal(normalizeUrlWithScheme("example.com", "http"), "http://example.com/");
      assert.equal(normalizeUrlWithScheme("example.com", "https"), "https://example.com/");
    });

    test("defaults fallback scheme to https if omitted or empty", () => {
      assert.equal(normalizeUrlWithScheme("example.com"), "https://example.com/");
      assert.equal(normalizeUrlWithScheme("example.com", ""), "https://example.com/");
    });

    test("strips leading slashes and handles schemes with trailing slashes", () => {
      assert.equal(normalizeUrlWithScheme("//example.com/test", "https"), "https://example.com/test");
    });

    test("preserves existing protocol on input", () => {
      assert.equal(normalizeUrlWithScheme("http://example.com", "https"), "http://example.com/");
      assert.equal(normalizeUrlWithScheme("https://example.com", "http"), "https://example.com/");
    });

    test("rejects unsafe schemes regardless of fallback", () => {
      assert.equal(normalizeUrlWithScheme("javascript:evil()", "https"), "");
      assert.equal(normalizeUrlWithScheme("data:text/plain,bad", "http"), "");
    });

    test("handles empty input safely", () => {
      assert.equal(normalizeUrlWithScheme(""), "");
      assert.equal(normalizeUrlWithScheme("   "), "");
      assert.equal(normalizeUrlWithScheme(null), "");
    });
  });
});
