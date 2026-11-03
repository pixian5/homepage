import assert from "node:assert/strict";
import test from "node:test";
import { containsAllChars, getPinyinInitials, isSubsequence, matchesSearchQuery } from "../src/js/pinyin-match.js";

test("getPinyinInitials extracts initials for Chinese characters accurately", () => {
  assert.equal(getPinyinInitials("百度"), "bd");
  assert.equal(getPinyinInitials("淘宝网"), "tbw");
  assert.equal(getPinyinInitials("哔哩哔哩"), "blbl");
  assert.equal(getPinyinInitials("微信网页版"), "wxwyb");
  assert.equal(getPinyinInitials("GitHub中文社区"), "githubzwsq");
  assert.equal(getPinyinInitials("Hello World 123"), "hello world 123");
});

test("matchesSearchQuery correctly matches polyphone Chinese words", () => {
  // 重庆：支持 cq 与 zq
  assert.ok(matchesSearchQuery("重庆招商网", "https://example.com", "cq"));
  assert.ok(matchesSearchQuery("重庆招商网", "https://example.com", "zq"));

  // 厦门：支持 xm 与 sm
  assert.ok(matchesSearchQuery("厦门大学", "https://xmu.edu.cn", "xm"));
  assert.ok(matchesSearchQuery("厦门大学", "https://xmu.edu.cn", "sm"));

  // 长沙：支持 cs 与 zs
  assert.ok(matchesSearchQuery("长沙晚报", "https://example.com", "cs"));
  assert.ok(matchesSearchQuery("长沙晚报", "https://example.com", "zs"));

  // 银行：支持 gsyh
  assert.ok(matchesSearchQuery("中国工商银行", "https://icbc.com.cn", "gsyh"));
});

test("isSubsequence and containsAllChars verify fuzzy pinyin acronyms", () => {
  assert.ok(isSubsequence("bldh", "blbldh")); // 有序子序列
  assert.ok(isSubsequence("tb", "tbw"));
  assert.ok(!isSubsequence("xyz", "abc"));

  assert.ok(containsAllChars("blhd", "blbldh")); // 字符覆盖
});

test("matchesSearchQuery supports exact text, url substring, and fuzzy pinyin", () => {
  // 原词匹配
  assert.ok(matchesSearchQuery("哔哩哔哩", "https://bilibili.com", "哔哩"));
  // 拼音首字母缩写匹配
  assert.ok(matchesSearchQuery("哔哩哔哩", "https://bilibili.com", "blbl"));
  assert.ok(matchesSearchQuery("淘宝", "https://taobao.com", "tb"));
  assert.ok(matchesSearchQuery("京东商城", "https://jd.com", "jd"));
  assert.ok(matchesSearchQuery("网易云音乐", "https://music.163.com", "wyy"));
  // 模糊子序列与字符覆盖匹配
  assert.ok(matchesSearchQuery("哔哩哔哩动画", "https://bilibili.com", "bldh"));
  assert.ok(matchesSearchQuery("哔哩哔哩动画", "https://bilibili.com", "blhd"));
  // 网址匹配
  assert.ok(matchesSearchQuery("谷歌搜索", "https://google.com", "google"));
  // 不匹配
  assert.ok(!matchesSearchQuery("哔哩哔哩", "https://bilibili.com", "tx"));
  // 空关键词全匹配
  assert.ok(matchesSearchQuery("百度", "https://baidu.com", ""));
});
