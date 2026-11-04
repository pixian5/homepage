import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { stopSyncServer } from "./sync-server.js";

/** 已登记待守护的子进程：收到终止信号时逐个强制收尾，防止孤儿泄漏。 */
const guardedChildren = new Set();
let signalGuardInstalled = false;
let signalCleanupInProgress = false;

/**
 * 收到终止信号（Ctrl+C / CI 超时强停等）时，finally 不会执行，
 * detached 启动的浏览器会变成孤儿进程常驻——
 * 2026-11-04 事故：7 个无头 Chromium 孤儿在 macOS 菜单栏堆积放大镜图标。
 * 这里保证：先结束所有已登记的子进程组，再按原信号退出进程。
 */
async function cleanupOnSignal(signal) {
  if (signalCleanupInProgress) {
    // 已在清理中又收到信号：不再等待，立即恢复默认终止行为。
    process.kill(process.pid, signal);
    return;
  }
  signalCleanupInProgress = true;
  const children = [...guardedChildren];
  guardedChildren.clear();
  // stopBrowser 内部自带超时兜底；这里再兜一层，保证信号清理不会永久挂死。
  await Promise.all(children.map((child) => stopBrowser(child).catch(() => {})));
  // 重放信号恢复默认终止（once 处理器已消费，不会再进入本函数），保留 CI 对退出码的判断。
  process.kill(process.pid, signal);
}

/**
 * 登记子进程并安装进程级终止信号守护（幂等，可重复调用）。
 * 子进程正常退出后自动注销；Windows 上信号语义不同，保持 no-op。
 */
export function trackChildShutdown(child) {
  if (!child || process.platform === "win32") return child;
  guardedChildren.add(child);
  child.once("exit", () => guardedChildren.delete(child));
  if (!signalGuardInstalled) {
    signalGuardInstalled = true;
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
      process.once(signal, () => {
        cleanupOnSignal(signal);
      });
    }
  }
  return child;
}

/**
 * 列出属于指定进程组的 PID。
 * 对整组发信号偶尔返回 EPERM（组里混入不可信号的进程），
 * 这时逐个结束组内成员比直接放弃更可靠。
 */
function pidsInGroup(pgid) {
  try {
    const output = execFileSync("/bin/ps", ["-axo", "pid=,pgid="], { encoding: "utf8" });
    return output
      .split("\n")
      .map((line) => line.trim().split(/\s+/))
      .filter((parts) => parts.length === 2 && Number(parts[1]) === pgid)
      .map((parts) => Number(parts[0]))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch {
    return [];
  }
}

/** 配合独立进程组启动浏览器，父进程重启退出后仍要清理整组，再删除临时配置。 */
export async function stopBrowser(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") return stopSyncServer(child);

  const signalGroup = (signal) => {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch (error) {
      // ESRCH：进程组已经不在了。
      // EPERM：组里混进了当前用户无权发送信号的进程（浏览器重启后可能换组），
      // 这时不能把测试判失败，退回只处理直接子进程即可。
      if (error.code === "ESRCH" || error.code === "EPERM") return false;
      throw error;
    }
  };
  // 注意：父进程已退出不代表进程组已清空（浏览器更新重启会把子进程留在同一组），
  // 因此即使 child.exitCode 非空也要继续向进程组发信号。
  if (!signalGroup("SIGTERM")) {
    // 整组信号不可用（EPERM/ESRCH）：退回逐个结束组内成员，
    // 否则浏览器更新重启后留在组里的子进程会变成孤儿。
    const members = pidsInGroup(child.pid);
    for (const pid of members) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // 已退出或无权，忽略
      }
    }
    const deadline = Date.now() + 2000;
    while (pidsInGroup(child.pid).length && Date.now() < deadline) await delay(25);
    for (const pid of pidsInGroup(child.pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // 忽略
      }
    }
    try {
      child.kill("SIGTERM");
    } catch {
      // 已经退出
    }
    return;
  }
  const gracefulDeadline = Date.now() + 1000;
  while (signalGroup(0) && Date.now() < gracefulDeadline) await delay(25);
  if (signalGroup(0)) signalGroup("SIGKILL");

  const exitDeadline = Date.now() + 5000;
  while (signalGroup(0)) {
    if (Date.now() >= exitDeadline) throw new Error("测试浏览器进程组未能退出，保留临时配置供排查");
    await delay(25);
  }
}
