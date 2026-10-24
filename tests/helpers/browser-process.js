import { setTimeout as delay } from "node:timers/promises";
import { stopSyncServer } from "./sync-server.js";

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
