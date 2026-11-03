/**
 * 轻量纯原生中文拼音首字母匹配模块
 * 结合 Intl / localeCompare('zh-CN') 与高频多音字候选映射，支持多音字双向收敛与子序列模糊匹配
 */

const POLYPHONE_CHAR_MAP = {
  重: ["c", "z"], // 重庆/重重(c), 重点(z)
  长: ["c", "z"], // 长沙/长春/长江(c), 长大(z)
  厦: ["x", "s"], // 厦门(x), 大厦(s)
  行: ["h", "x"], // 银行/行业/行情(h), 行走(x)
  藏: ["z", "c"], // 西藏/宝藏(z), 隐藏(c)
  乐: ["y", "l"], // 音乐(y), 快乐(l)
  朝: ["c", "z"], // 朝鲜/朝阳(c), 朝代(z)
  会: ["h", "k"], // 会议(h), 会计(k)
  数: ["s"], // 数学(s)
  省: ["s", "x"], // 省份(s), 反省(x)
};

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
 * 获取单个字符的首字母候选集合
 * @param {string} char
 * @returns {string[]}
 */
export function getCharInitials(char) {
  if (/[a-zA-Z0-9]/.test(char)) return [char.toLowerCase()];
  if (POLYPHONE_CHAR_MAP[char]) return POLYPHONE_CHAR_MAP[char];
  if (!/[\u4e00-\u9fa5]/.test(char)) return [char];
  for (let i = PINYIN_BOUNDARIES.length - 1; i >= 0; i--) {
    if (char.localeCompare(PINYIN_BOUNDARIES[i][0], "zh-CN") >= 0) {
      return [PINYIN_BOUNDARIES[i][1]];
    }
  }
  return [char];
}

/**
 * 提取文本的拼音首字母缩写（主音主序列）
 * @param {string} text
 * @returns {string}
 */
export function getPinyinInitials(text) {
  if (!text) return "";
  let result = "";
  for (const char of text) {
    const inits = getCharInitials(char);
    result += inits[0] || char;
  }
  return result;
}

/**
 * 获取文本所有多音字组合的前 N 种排列变体
 * @param {string} text
 * @param {number} maxVariants
 * @returns {string[]}
 */
export function getPinyinInitialVariants(text, maxVariants = 8) {
  if (!text) return [""];
  let variants = [""];
  for (const char of text) {
    const initials = getCharInitials(char);
    const nextVariants = [];
    for (const v of variants) {
      for (const init of initials) {
        nextVariants.push(v + init);
      }
    }
    variants = nextVariants.slice(0, maxVariants);
  }
  return variants;
}

/**
 * 判断 sub 是否是 target 的有序子序列 (例如 "bldh" 是 "blbldh" 的子序列)
 * @param {string} sub
 * @param {string} target
 * @returns {boolean}
 */
export function isSubsequence(sub, target) {
  if (!sub) return true;
  if (!target || sub.length > target.length) return false;
  let subIndex = 0;
  for (let i = 0; i < target.length && subIndex < sub.length; i++) {
    if (target[i] === sub[subIndex]) {
      subIndex++;
    }
  }
  return subIndex === sub.length;
}

/**
 * 判断 sub 中的字符是否全部被 target 包含 (支持跳字乱序)
 * @param {string} sub
 * @param {string} target
 * @returns {boolean}
 */
export function containsAllChars(sub, target) {
  if (!sub) return true;
  if (!target || sub.length > target.length) return false;
  const targetChars = target.split("");
  for (const char of sub) {
    const idx = targetChars.indexOf(char);
    if (idx === -1) return false;
    targetChars.splice(idx, 1);
  }
  return true;
}

/**
 * 判断标题或网址是否匹配搜索关键词（支持原词、网址、多音字拼音及模糊子序列检索）
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

  // 2. 拼音首字母变体匹配（连续子串、有序子序列与模糊覆盖）
  const variants = getPinyinInitialVariants(title);
  for (const variant of variants) {
    if (variant.includes(q) || isSubsequence(q, variant) || (q.length >= 3 && containsAllChars(q, variant))) {
      return true;
    }
  }

  return false;
}
