import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { stopSyncServer } from "./sync-server.js";

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
