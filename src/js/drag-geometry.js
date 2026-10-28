/**
 * 拖拽几何计算（纯函数）
 * @module drag-geometry
 *
 * 从 app.js 抽出，便于单独测试。这里不接触 DOM，只接收矩形与坐标，
 * 这样「拖到卡片左半边 → 插到它前面」这类规则能用单元测试锁住，
 * 重构 DOM 结构或改渲染逻辑时不会悄悄改变拖放行为。
 */

/**
 * 在若干矩形中找距离 (x, y) 最近的一个
 * @param {Array<{left:number,top:number,right:number,bottom:number}>} rects
 * @param {number} x
 * @param {number} y
 * @returns {{index: number, distance: number}}
 */
export function findNearestRect(rects, x, y) {
  if (!Array.isArray(rects) || rects.length === 0) return { index: 0, distance: Number.POSITIVE_INFINITY };
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < rects.length; i++) {
    const rect = rects[i];
    if (!rect) continue;
    // 点到矩形的距离：落在内部为 0，否则取最近边的水平/垂直差值之和
    const dx = x < rect.left ? rect.left - x : x > rect.right ? x - rect.right : 0;
    const dy = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0;
    const distance = dx + dy;
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = i;
    }
  }
  return { index: bestIndex, distance: bestDistance };
}

/**
 * 判断落点应插在目标矩形的「前」还是「后」
 *
 * 规则（与原有实现一致）：
 *  - 落在矩形左侧 → 前；右侧 → 后
 *  - 落在上方 → 前；下方 → 后
 *  - 落在内部：靠近纵向中心线（±35% 高度）时按左右半区判断，
 *    否则按上下半区判断。这样同一行内横移按卡片前后、跨行移动按行间顺序。
 *
 * @param {{left:number,top:number,right:number,bottom:number}} rect
 * @param {number} x
 * @param {number} y
 * @returns {boolean} true = 插到目标之后
 */
export function shouldInsertAfter(rect, x, y) {
  if (!rect) return false;
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  if (x < rect.left) return false;
  if (x > rect.right) return true;
  if (y < rect.top) return false;
  if (y > rect.bottom) return true;
  const nearRowCenter = Math.abs(y - centerY) <= rect.height * 0.35;
  return nearRowCenter ? x >= centerX : y >= centerY;
}

/**
 * 根据目标列表与落点计算插入索引
 * @param {string[]} list 当前顺序的节点 id 列表
 * @param {string} targetId 拖放目标 id
 * @param {{left:number,top:number,right:number,bottom:number}|null} targetRect 目标元素矩形
 * @param {number} x
 * @param {number} y
 * @returns {number}
 */
export function computeInsertIndex(list, targetId, targetRect, x, y) {
  const targetIndex = Array.isArray(list) ? list.indexOf(targetId) : -1;
  if (targetIndex < 0) return Array.isArray(list) ? list.length : 0;
  if (!targetRect) return targetIndex;
  const insertAfter = shouldInsertAfter(targetRect, x, y);
  const insertIndex = targetIndex + (insertAfter ? 1 : 0);
  return Math.max(0, Math.min(insertIndex, list.length));
}

/**
 * 判断坐标是否落在矩形内
 * @param {{left:number,top:number,right:number,bottom:number}|null} rect
 * @param {number} x
 * @param {number} y
 * @returns {boolean}
 */
export function isPointInsideRect(rect, x, y) {
  if (!rect) return false;
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

/**
 * 把 DOMRect 转成纯数据对象（测试与纯函数都只接受这种形式）
 * @param {{left:number,top:number,width:number,height:number}} rect
 * @returns {{left:number,top:number,right:number,bottom:number,width:number,height:number}}
 */
export function toPlainRect(rect) {
  return {
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height,
  };
}
