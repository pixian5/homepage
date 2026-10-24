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
    // 先恢复一次成功同步，清掉上一轮残留的 network_error，否则会瞬间误判超时。
    await setMode("pass");
    await ensureSettings();
    click("#btnSyncNow");
    await waitFor(
      async () => {
        const st = await status();
        return st.status === "idle" && !st.lastError;
      },
      "超时测试前重置为正常状态",
      30000,
    );

    await setMode("timeout");
    await ensureSettings();
    clearToasts();
    const startedAt = Date.now();
    click("#btnSyncNow");
    // 客户端单次请求 10 秒超时；必须等够时间再判断，否则读到的是上一轮的旧错误。
    await waitFor(
      async () => {
        if (Date.now() - startedAt < 8000) return false;
        const st = await status();
        const err = String(st.lastError || "");
        return /超时|timeout/i.test(toasts()) || /timeout|network_error/i.test(err);
      },
      "timeout 后出现提示或错误状态（且已接近 10 秒）",
      120000,
    );
    report.elapsedMs = Date.now() - startedAt;
    // 单次请求 10 秒超时；若前一次尝试的失败已经被记录（例如代理重置），
    // 这里可能在更短时间内就观察到错误状态，因此不把耗时当成唯一判据。
    report.checks.push(`请求超时：客户端在 ${report.elapsedMs}ms 内报出超时/网络错误`);

    // 6) 恢复：等 outbox 退避到期后由 flushOutbox 自动补发。
    // 注意：立即同步走 pushNow，它不会绕过退避；退避基数是 5 秒，这里等 20 秒。
    await setMode("pass");
    clearToasts();
    const retryDeadline = Date.now() + 40000;
    let recovered = false;
    while (Date.now() < retryDeadline) {
      if ((await outbox()).length === 0) {
        recovered = true;
        break;
      }
      // 不能重载页面：重载会重新执行整个运行器，后续步骤的 DOM 引用全部失效。
      // 改为在设置里改一次字号，触发真实的本地变更 → 防抖 push → 成功后清空 outbox。
      await ensureSettings();
      const fontField = document.getElementById("settingFontSize");
      if (fontField) {
        fontField.value = String(12 + (Math.floor(Date.now() / 2000) % 5));
        fontField.dispatchEvent(new Event("input", { bubbles: true }));
      }
      await new Promise((resolve) => setTimeout(resolve, 3000));
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

    // 导出后再新增一张书签，用来证明导入走的是真实合并（并集），而不是简单覆盖。
    click("#btnSettings");
    await waitFor(() => document.getElementById("modalOverlay").classList.contains("hidden"), "关闭设置");
    click("#btnAdd");
    await waitFor(() => document.getElementById("fieldUrl"), "新增面板");
    setField("fieldUrl", "https://example.invalid/after-export");
    setField("fieldTitle", "导出后新增书签");
    click("#btnSave");
    await waitFor(
      async () => Object.values((await stored()).nodes || {}).some((n) => n.title === "导出后新增书签" && !n.deletedAt),
      "导出后新增书签落盘",
      20000,
    );

    click("#btnSettings");
    await waitFor(() => document.getElementById("btnSyncImportFile"), "设置面板重新打开");
    const fileInput = document.getElementById("syncImportFileInput");
    if (!fileInput) throw new Error("缺少文件导入 input");
    const file = new File([exportedFileText], "homepage-sync.json", { type: "application/json" });
    // Firefox 无头模式下 DataTransfer 赋给 input.files 会得到空列表（实测 length=0）。
    // 处理函数只读取 e.target.files[0]，这里直接定义一个只读的类数组即可。
    Object.defineProperty(fileInput, "files", {
      configurable: true,
      value: Object.assign([file], { item: (index) => (index === 0 ? file : null) }),
    });
    // 处理函数拿到文件后会执行 e.target.value = "" 清空输入，这里容忍该赋值。
    Object.defineProperty(fileInput, "value", {
      configurable: true,
      get: () => "",
      set: () => {},
    });
    report.fileInputFiles = fileInput.files.length;
    clearToasts();
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));

    // 成功标志：真实处理函数弹出「同步包已合并」
    await waitFor(() => toasts().includes("同步包已合并"), "文件导入成功提示", 30000);
    // 合并语义：导出后新增的书签仍在（并集），原有书签也在
    await waitFor(
      async () => {
        const nodes = Object.values((await stored()).nodes || {});
        return (
          nodes.some((n) => n.title === "导出后新增书签" && !n.deletedAt) &&
          nodes.some((n) => n.title === "异常分支验证书签" && !n.deletedAt)
        );
      },
      "文件导入后两本书签都在",
      20000,
    );
    report.checks.push("同步包文件导入成功（提示 + 合并并集）");

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
