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
      if (error.code === "ESRCH") return false;
      throw error;
    }
  };
  if (!signalGroup("SIGTERM")) return;
  const gracefulDeadline = Date.now() + 1000;
  while (signalGroup(0) && Date.now() < gracefulDeadline) await delay(25);
  if (signalGroup(0)) signalGroup("SIGKILL");

  const exitDeadline = Date.now() + 5000;
  while (signalGroup(0)) {
    if (Date.now() >= exitDeadline) throw new Error("测试浏览器进程组未能退出，保留临时配置供排查");
    await delay(25);
  }
}
