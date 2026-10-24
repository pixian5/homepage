// Firefox 同步异常分支运行器：通过故障注入代理切换 401 / 500 / reset / timeout，
// 并验证恢复后 outbox 自动补发、以及同步包文件入口。
(async () => {
  const config = globalThis.HOMEPAGE_SYNC_ERRORS;
  const api = globalThis.browser || globalThis.chrome;
  const report = { checks: [] };
  const errors = [];
  window.addEventListener("error", (event) => errors.push(event.message));
  window.addEventListener("unhandledrejection", (event) => errors.push(String(event.reason)));

  const waitFor = async (predicate, label, timeout = 30000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    throw new Error(`等待失败：${label}；脚本错误：${errors.join("；")}`);
  };
  const click = (selector) => {
    const element = document.querySelector(selector);
    if (!element) throw new Error(`缺少元素：${selector}`);
    element.click();
  };
  const setField = (id, value) => {
    const element = document.getElementById(id);
    if (!element) throw new Error(`缺少字段：${id}`);
    element.value = value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const toasts = () => [...document.querySelectorAll("#toastContainer *")].map((n) => n.textContent || "").join(" ");
  const status = async () => (await api.storage.local.get("homepage_sync_state")).homepage_sync_state || {};
  const outbox = async () => {
    const got = await api.storage.local.get("homepage_sync_outbox");
    return Array.isArray(got.homepage_sync_outbox) ? got.homepage_sync_outbox : [];
  };
  const stored = async () => (await api.storage.local.get("homepage_data")).homepage_data;
  const setMode = async (mode) => {
    const response = await fetch(config.controlUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode }),
    });
    if (!response.ok) throw new Error(`切换故障模式失败：${mode}`);
    report.checks.push(`代理切到 ${mode}`);
  };
  // 同步过程中设置弹窗会被提交后重建，字段可能在两次调用之间消失。
  // 这里统一用“等到字段出现再写值”的方式，必要时重新打开设置面板。
  const ensureSettings = async () => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (document.getElementById("settingSyncServerToken")) {
        // 再等一帧，避开 saveSettings 触发的重建
        await new Promise((resolve) => setTimeout(resolve, 250));
        if (document.getElementById("settingSyncServerToken")) {
          if (config.proxyUrl) setField("settingSyncServerUrl", config.proxyUrl);
          return;
        }
      }
      if (!document.getElementById("settingSync")) click("#btnSettings");
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    throw new Error("设置面板在 15 秒内没有稳定出现");
  };
  const clearToasts = () => {
    const container = document.getElementById("toastContainer");
    if (container) container.replaceChildren();
  };
  // 同步包文件入口：拦下 <a download> 的点击，取出 Blob 文本；
  // 导入时把同一段文本塞进隐藏 file input 的 files。
  let exportedFileText = "";
  // 扩展页面的 CSP 里 connect-src 不含 blob:，直接 fetch(blob:) 会被拦。
  // 改为在 createObjectURL 时留下 Blob 引用，点击下载时再读文本。
  const blobByUrl = new Map();
  const originalCreateObjectURL = URL.createObjectURL.bind(URL);
  URL.createObjectURL = (blob) => {
    const url = originalCreateObjectURL(blob);
    blobByUrl.set(url, blob);
    return url;
  };
  const originalClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function patchedClick(...args) {
    if (this.download) {
      const blob = blobByUrl.get(this.href);
      if (blob) {
        blob
          .text()
          .then((text) => {
            exportedFileText = text;
          })
          .catch(() => {});
      }
      return originalClick.apply(this, args);
    }
    return originalClick.apply(this, args);
  };

  try {
    await new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "js/app.ff.js";
      script.onload = resolve;
      script.onerror = () => reject(new Error("主应用脚本加载失败"));
      document.body.appendChild(script);
    });
    await waitFor(() => document.documentElement.dataset.homepageReady === "true", "首页初始化");

    click("#btnAdd");
    await waitFor(() => document.getElementById("fieldUrl"), "新增面板");
    setField("fieldUrl", "https://example.invalid/sync-errors");
    setField("fieldTitle", "异常分支验证书签");
    click("#btnSave");
    await waitFor(
      async () => Object.values((await stored())?.nodes || {}).some((n) => n.title === "异常分支验证书签"),
      "书签落盘",
    );

    click("#btnSettings");
    await waitFor(() => document.getElementById("settingSync"), "设置面板");
    const syncBox = document.getElementById("settingSync");
    if (!syncBox.checked) {
      syncBox.checked = true;
      syncBox.dispatchEvent(new Event("change", { bubbles: true }));
    }
    setField("settingSyncServerUrl", config.proxyUrl);
    setField("settingSyncServerToken", config.token);

    // 1) 基线：正常同步
    await setMode("pass");
    clearToasts();
    click("#btnSyncNow");
    await waitFor(async () => {
      const st = await status();
      return st.status === "idle" && Number(st.lastPushAt) > 0;
    }, "基线同步成功");
    report.checks.push("基线同步成功");

    // 2) 错误 Token → 401
    await setMode("401");
    clearToasts();
    setField("settingSyncServerToken", "wrong-token");
    click("#btnSyncNow");
    await waitFor(async () => {
      const st = await status();
      return st.lastError === "unauthorized" || st.status === "error";
    }, "401 被识别为鉴权失败");
    await waitFor(() => /鉴权失败|TOKEN/i.test(toasts()), "401 提示可见", 15000);
    report.checks.push("401：状态为鉴权失败且有提示");
    await ensureSettings();
    setField("settingSyncServerToken", config.token);

    // 3) 服务端 500 → 错误 + outbox 入队
    await setMode("500");
    await ensureSettings();
    clearToasts();
    click("#btnSyncNow");
    await waitFor(async () => (await status()).status === "error", "500 后进入错误状态");
    await waitFor(async () => (await outbox()).length > 0, "500 后 outbox 入队", 20000);
    const errorRow = (await outbox())[0];
    if (!errorRow?.targetKey) throw new Error("outbox 项缺少 targetKey");
    report.checks.push(`500：错误状态且 outbox 入队（attempts=${errorRow.attempts}）`);

    // 4) 连接被重置 → network_error
    await setMode("reset");
    await ensureSettings();
    clearToasts();
    click("#btnSyncNow");
    await waitFor(() => /连接失败|network/i.test(toasts()), "reset 后出现网络错误提示", 25000);
    report.checks.push("连接重置：出现网络错误提示");

    // 5) 请求超时（客户端 10 秒）
    await setMode("timeout");
    await ensureSettings();
    clearToasts();
    const startedAt = Date.now();
    click("#btnSyncNow");
    await waitFor(() => /超时|timeout|连接失败/i.test(toasts()), "timeout 后出现提示", 40000);
    report.elapsedMs = Date.now() - startedAt;
    report.checks.push(`请求超时：10 秒后被客户端中止（实际 ${report.elapsedMs}ms）`);

    // 6) 恢复：等 outbox 退避到期后由 flushOutbox 自动补发。
    // 注意：立即同步走 pushNow，它不会绕过退避；退避基数是 5 秒，这里等 20 秒。
    await setMode("pass");
    clearToasts();
    const retryDeadline = Date.now() + 40000;
    const reloadAfter = Date.now() + 8000;
    let recovered = false;
    while (Date.now() < retryDeadline) {
      // 设置面板里的“立即同步”走 pushNow，不会绕过退避；能绕过的是首屏 init 里的
      // flushOutbox。这里重开一次新标签页（真实用户刷新页面的等价操作），
      // 让 init 重跑并补发。
      if ((await outbox()).length === 0) {
        recovered = true;
        break;
      }
      if (Date.now() > reloadAfter) {
        const tabs = await api.tabs.query({ url: api.runtime.getURL("newtab.html") });
        if (tabs.length) await api.tabs.reload(tabs[0].id);
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    if (!recovered) {
      const st = await status();
      throw new Error(`outbox 未在 40 秒内清空：status=${st.status} lastError=${st.lastError}`);
    }
    report.checks.push("恢复：服务端可用后 outbox 自动清空");

    // 7) 同步包文件入口：导出文件 → 删除书签 → 导入文件恢复
    click("#btnSyncExportFile");
    await waitFor(() => exportedFileText.includes("homepage.sync.bundle.v1"), "导出文件内容", 20000);
    report.exportedFileBytes = exportedFileText.length;
    report.checks.push(`导出文件（${report.exportedFileBytes} 字节）`);

    const beforeDelete = await stored();
    const targetId = Object.values(beforeDelete.nodes).find((n) => n.title === "异常分支验证书签")?.id;
    if (!targetId) throw new Error("找不到书签 id");
    beforeDelete.nodes[targetId].deletedAt = Date.now();
    await api.storage.local.set({ homepage_data: beforeDelete });
    await waitFor(
      async () =>
        !Object.values((await stored()).nodes || {}).some((n) => n.title === "异常分支验证书签" && !n.deletedAt),
      "书签已删除",
    );

    click("#btnSettings");
    await waitFor(() => document.getElementById("btnSyncImportFile"), "设置面板重新打开");
    const fileInput = document.getElementById("syncImportFileInput");
    if (!fileInput) throw new Error("缺少文件导入 input");
    const file = new File([exportedFileText], "homepage-sync.json", { type: "application/json" });
    // Firefox 允许直接给 input.files 赋 FileList；DataTransfer 在部分版本不可用
    const transfer = new DataTransfer();
    transfer.items.add(file);
    fileInput.files = transfer.files;
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    await waitFor(
      async () =>
        Object.values((await stored()).nodes || {}).some((n) => n.title === "异常分支验证书签" && !n.deletedAt),
      "文件导入恢复书签",
      30000,
    );
    report.checks.push("同步包文件导入恢复被删书签");

    if (errors.length) throw new Error(errors.join("；"));
  } catch (error) {
    try {
      report.syncState = await status();
      report.outboxRows = await outbox();
      report.toasts = toasts();
    } catch {
      // 诊断信息取不到不影响失败上报
    }
    report.failure = `${error?.message || String(error)}\n${error?.stack || ""}`;
  }
  try {
    await fetch(config.reportUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(report),
    });
  } catch {
    // 报告失败由外层超时兜底
  }
})();
