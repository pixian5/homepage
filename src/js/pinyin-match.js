/**
 * 轻量纯原生中文拼音首字母匹配模块
 * 利用现代 JS 引擎内置的 Intl / localeCompare('zh-CN') 实现零依赖汉字拼音首字母提取
 */

const PINYIN_BOUNDARIES = [
  ["啊", "a"],
  ["八", "b"],
  ["嚓", "c"],
  ["哒", "d"],
  ["妸", "e"],
  ["发", "f"],
  ["旮", "g"],
  ["哈", "h"],
  ["讥", "j"],
  ["咔", "k"],
  ["垃", "l"],
  ["妈", "m"],
  ["拏", "n"],
  ["噢", "o"],
  ["妑", "p"],
  ["七", "q"],
  ["呥", "r"],
  ["扨", "s"],
  ["它", "t"],
  ["穵", "w"],
  ["夕", "x"],
  ["丫", "y"],
  ["帀", "z"],
];

/**
 * 提取文本的拼音首字母缩写
 * @param {string} text
 * @returns {string}
 */
export function getPinyinInitials(text) {
  if (!text) return "";
  let result = "";
  for (const char of text) {
    if (/[a-zA-Z0-9]/.test(char)) {
      result += char.toLowerCase();
    } else if (/[\u4e00-\u9fa5]/.test(char)) {
      let matched = "";
      for (let i = PINYIN_BOUNDARIES.length - 1; i >= 0; i--) {
        if (char.localeCompare(PINYIN_BOUNDARIES[i][0], "zh-CN") >= 0) {
          matched = PINYIN_BOUNDARIES[i][1];
          break;
        }
      }
      result += matched || char;
    } else {
      result += char;
    }
  }
  return result;
}

/**
 * 判断标题或网址是否匹配搜索关键词（支持原词、网址及拼音首字母检索）
 * @param {string} title
 * @param {string} url
 * @param {string} query
 * @returns {boolean}
 */
export function matchesSearchQuery(title = "", url = "", query = "") {
  const q = String(query).trim().toLowerCase();
  if (!q) return true;

  const rawTitle = String(title).toLowerCase();
  const rawUrl = String(url).toLowerCase();

  // 1. 直接子串匹配
  if (rawTitle.includes(q) || rawUrl.includes(q)) {
    return true;
  }

  // 2. 中文拼音首字母匹配
  const initials = getPinyinInitials(title);
  if (initials.includes(q)) {
    return true;
  }

  return false;
}
