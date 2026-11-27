/**
 * 轻量纯原生中文拼音首字母与全拼双模匹配模块
 * 结合 Intl / localeCompare('zh-CN')、高频多音字映射与常见高频汉字全拼字典，支持首字母缩写、全拼及子序列模糊匹配
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

// 常见书签、站点与界面高频汉字全拼字典（未命中字符自动回退到首字母）
const COMMON_CHAR_PINYIN_MAP = {
  // 多音与地名常用字
  重: ["chong", "zhong"],
  庆: ["qing"],
  长: ["chang", "zhang"],
  沙: ["sha"],
  春: ["chun"],
  江: ["jiang"],
  厦: ["xia", "sha"],
  门: ["men"],
  行: ["hang", "xing"],
  藏: ["cang", "zang"],
  乐: ["yue", "le"],
  朝: ["chao", "zhao"],
  阳: ["yang"],
  会: ["hui", "kuai"],
  省: ["sheng", "xing"],
  调: ["tiao", "diao"],
  传: ["chuan", "zhuan"],
  // 站点与品牌高频字
  百: ["bai"],
  度: ["du"],
  谷: ["gu"],
  歌: ["ge"],
  淘: ["tao"],
  宝: ["bao"],
  京: ["jing"],
  东: ["dong"],
  微: ["wei"],
  信: ["xin"],
  哔: ["bi"],
  哩: ["li"],
  网: ["wang"],
  易: ["yi"],
  云: ["yun"],
  音: ["yin"],
  知: ["zhi"],
  乎: ["hu"],
  豆: ["dou"],
  瓣: ["ban"],
  腾: ["teng"],
  讯: ["xun"],
  阿: ["a"],
  里: ["li"],
  支: ["zhi"],
  付: ["fu"],
  招: ["zhao"],
  商: ["shang"],
  工: ["gong"],
  银: ["yin"],
  中: ["zhong"],
  国: ["guo"],
  小: ["xiao"],
  红: ["hong"],
  // 书签与导航高频字
  冒: ["mao"],
  烟: ["yan"],
  书: ["shu"],
  签: ["qian"],
  地: ["di"],
  图: ["tu"],
  设: ["she"],
  置: ["zhi"],
  首: ["shou"],
  页: ["ye"],
  标: ["biao"],
  分: ["fen"],
  组: ["zu"],
  目: ["mu"],
  录: ["lu"],
  搜: ["sou"],
  索: ["suo"],
  收: ["shou"],
  夹: ["jia"],
  管: ["guan"],
  理: ["li"],
  编: ["bian"],
  辑: ["ji"],
  删: ["shan"],
  除: ["chu"],
  添: ["tian"],
  加: ["jia"],
  修: ["xiu"],
  改: ["gai"],
  查: ["cha"],
  看: ["kan"],
  下: ["xia"],
  载: ["zai"],
  上: ["shang"],
  快: ["kuai"],
  捷: ["jie"],
  方: ["fang"],
  式: ["shi"],
  壁: ["bi"],
  纸: ["zhi"],
  清: ["qing"],
  单: ["dan"],
  待: ["dai"],
  办: ["ban"],
  // 功能与分类高频字
  常: ["chang"],
  用: ["yong"],
  具: ["ju"],
  公: ["gong"],
  大: ["da"],
  学: ["xue"],
  习: ["xi"],
  开: ["kai"],
  发: ["fa"],
  技: ["ji"],
  术: ["shu"],
  文: ["wen"],
  档: ["dang"],
  代: ["dai"],
  码: ["ma"],
  仓: ["cang"],
  库: ["ku"],
  服: ["fu"],
  务: ["wu"],
  器: ["qi"],
  同: ["tong"],
  步: ["bu"],
  备: ["bei"],
  份: ["fen"],
  恢: ["hui"],
  复: ["fu"],
  导: ["dao"],
  入: ["ru"],
  出: ["chu"],
  隐: ["yin"],
  私: ["si"],
  安: ["an"],
  全: ["quan"],
  密: ["mi"],
  账: ["zhang"],
  号: ["hao"],
  登: ["deng"],
  新: ["xin"],
  闻: ["wen"],
  资: ["zi"],
  翻: ["fan"],
  译: ["yi"],
  天: ["tian"],
  气: ["qi"],
  财: ["cai"],
  经: ["jing"],
  股: ["gu"],
  票: ["piao"],
  购: ["gou"],
  物: ["wu"],
  生: ["sheng"],
  活: ["huo"],
  健: ["jian"],
  康: ["kang"],
  医: ["yi"],
  疗: ["liao"],
  政: ["zheng"],
  教: ["jiao"],
  育: ["yu"],
  科: ["ke"],
  研: ["yan"],
  计: ["ji"],
  素: ["su"],
  材: ["cai"],
  模: ["mo"],
  板: ["ban"],
  笔: ["bi"],
  记: ["ji"],
  博: ["bo"],
  客: ["ke"],
  社: ["she"],
  区: ["qu"],
  论: ["lun"],
  坛: ["tan"],
  视: ["shi"],
  频: ["pin"],
  影: ["ying"],
  游: ["you"],
  戏: ["xi"],
  动: ["dong"],
  画: ["hua"],
  漫: ["man"],
  直: ["zhi"],
  播: ["bo"],
  电: ["dian"],
  台: ["tai"],
  邮: ["you"],
  箱: ["xiang"],
  盘: ["pan"],
  时: ["shi"],
  间: ["jian"],
  日: ["ri"],
  历: ["li"],
  晚: ["wan"],
  报: ["bao"],
  城: ["cheng"],
  主: ["zhu"],
  站: ["zhan"],
  点: ["dian"],
  链: ["lian"],
  接: ["jie"],
  极: ["ji"],
  简: ["jian"],
  智: ["zhi"],
  能: ["neng"],
  助: ["zhu"],
  手: ["shou"],
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
 * 获取单个字符的全拼候选集合（未在字典收录的汉字回退到首字母）
 * @param {string} char
 * @returns {string[]}
 */
export function getCharPinyins(char) {
  if (/[a-zA-Z0-9]/.test(char)) return [char.toLowerCase()];
  if (COMMON_CHAR_PINYIN_MAP[char]) return COMMON_CHAR_PINYIN_MAP[char];
  return getCharInitials(char);
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
 * 通用多候选排列展开辅助函数
 * @param {string} text
 * @param {(char: string) => string[]} getCandidates
 * @param {number} maxVariants
 * @returns {string[]}
 */
function expandCharVariants(text, getCandidates, maxVariants = 8) {
  if (!text) return [""];
  let variants = [""];
  for (const char of text) {
    const candidates = getCandidates(char);
    const nextVariants = [];
    for (const v of variants) {
      for (const candidate of candidates) {
        nextVariants.push(v + candidate);
      }
    }
    variants = nextVariants.slice(0, maxVariants);
  }
  return variants;
}

/**
 * 获取文本所有多音字首字母组合的前 N 种排列变体
 * @param {string} text
 * @param {number} maxVariants
 * @returns {string[]}
 */
export function getPinyinInitialVariants(text, maxVariants = 8) {
  return expandCharVariants(text, getCharInitials, maxVariants);
}

/**
 * 获取文本所有全拼组合的前 N 种排列变体
 * @param {string} text
 * @param {number} maxVariants
 * @returns {string[]}
 */
export function getPinyinFullVariants(text, maxVariants = 8) {
  return expandCharVariants(text, getCharPinyins, maxVariants);
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
  const initialVariants = getPinyinInitialVariants(title);
  for (const variant of initialVariants) {
    if (variant.includes(q) || isSubsequence(q, variant) || (q.length >= 3 && containsAllChars(q, variant))) {
      return true;
    }
  }

  // 3. 常见汉字全拼变体匹配（连续子串与有序子序列，避免跨音节无序误匹配）
  const fullVariants = getPinyinFullVariants(title);
  for (const variant of fullVariants) {
    if (variant.includes(q) || isSubsequence(q, variant)) {
      return true;
    }
  }

  return false;
}
