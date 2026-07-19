/**
 * 扩展后台：记录最近访问（Safari 无 history API 时的回退数据源）
 * Chrome/Firefox 也加载，作为 history 的补充无害。
 */
import { initVisitTrackingInBackground } from "./visit-history.js";

try {
  initVisitTrackingInBackground();
} catch (e) {
  console.warn("background init failed", e);
}
