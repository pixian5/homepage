import assert from "node:assert/strict";
import test from "node:test";
import { getPinyinInitials, matchesSearchQuery } from "../src/js/pinyin-match.js";

test("getPinyinInitials extracts initials for Chinese characters accurately", () => {
  assert.equal(getPinyinInitials("百度"), "bd");
  assert.equal(getPinyinInitials("淘宝网"), "tbw");
  assert.equal(getPinyinInitials("哔哩哔哩"), "blbl");
  assert.equal(getPinyinInitials("微信网页版"), "wxwyb");
  assert.equal(getPinyinInitials("GitHub中文社区"), "githubzwsq");
  assert.equal(getPinyinInitials("Hello World 123"), "hello world 123");
});

test("matchesSearchQuery supports exact text, url substring, and pinyin initials", () => {
  // 原词匹配
  assert.ok(matchesSearchQuery("哔哩哔哩", "https://bilibili.com", "哔哩"));
  // 拼音首字母缩写匹配
  assert.ok(matchesSearchQuery("哔哩哔哩", "https://bilibili.com", "blbl"));
  assert.ok(matchesSearchQuery("淘宝", "https://taobao.com", "tb"));
  assert.ok(matchesSearchQuery("京东商城", "https://jd.com", "jd"));
  assert.ok(matchesSearchQuery("网易云音乐", "https://music.163.com", "wyy"));
  // 网址匹配
  assert.ok(matchesSearchQuery("谷歌搜索", "https://google.com", "google"));
  // 不匹配
  assert.ok(!matchesSearchQuery("哔哩哔哩", "https://bilibili.com", "tx"));
  // 空关键词全匹配
  assert.ok(matchesSearchQuery("百度", "https://baidu.com", ""));
});
