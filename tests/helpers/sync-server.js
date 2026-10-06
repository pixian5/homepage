import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { httpHealth } from "../../src/js/sync_http_transport.js";

const serverScript = fileURLToPath(new URL("../../scripts/sync-server.mjs", import.meta.url));

/** 等待退出后才能删除数据目录，超时则强制结束本测试创建的子进程。 */
export async function stopSyncServer(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode) return;
  await new Promise((resolve, reject) => {
    const force = setTimeout(() => child.kill("SIGKILL"), 1000);
    const deadline = setTimeout(() => reject(new Error("测试服务未能退出")), 5000);
    child.once("exit", () => {
      clearTimeout(force);
      clearTimeout(deadline);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

/** 私有数据文件、动态端口和 IPC 就绪握手共同隔离测试服务。 */
export async function startSyncServer({ dataFile, token = "test-token", port = 0 }) {
  const child = spawn(process.execPath, [serverScript], {
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", TOKEN: token, DATA_FILE: dataFile },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let output = "";
  const capture = (chunk) => {
    // 只保留启动诊断末尾，避免失败时无限积累日志。
    output = (output + chunk).slice(-4000);
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  try {
    const actualPort = await new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        child.off("error", onError);
        child.off("exit", onExit);
        child.off("message", onMessage);
      };
      const fail = (error) => {
        cleanup();
        reject(error);
      };
      const onError = (error) => fail(error);
      const onExit = (code, signal) => fail(new Error(`测试服务提前退出 (${code ?? signal})：${output}`));
      const onMessage = (message) => {
        if (message?.type !== "sync-server-ready" || message.pid !== child.pid) return;
        if (!Number.isInteger(message.port) || message.port <= 0) return;
        cleanup();
        resolve(message.port);
      };
      const timer = setTimeout(() => fail(new Error(`测试服务启动超时：${output}`)), 5000);
      child.once("error", onError);
      child.once("exit", onExit);
      child.on("message", onMessage);
    });
    const baseUrl = `http://127.0.0.1:${actualPort}`;
    const health = await httpHealth({ baseUrl, token, timeoutMs: 2000 });
    if (!health.ok || child.exitCode !== null || child.signalCode) {
      throw new Error(`测试服务健康检查失败：${output}`);
    }
    return { child, baseUrl, port: actualPort };
  } catch (error) {
    await stopSyncServer(child);
    throw error;
  }
}
