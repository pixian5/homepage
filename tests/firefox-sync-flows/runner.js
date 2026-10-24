// Firefox 同步分支流程运行器：冲突弹窗、同步包导入导出、周期同步。
// 只操作设置面板里的真实控件。
(async () => {
  const config = globalThis.HOMEPAGE_SYNC_FLOWS;
  const api = globalThis.browser || globalThis.chrome;
  const report = { checks: [] };
  const errors = [];
  window.addEventListener("error", (event) => errors.push(event.message));
  window.addEventListener("unhandledrejection", (event) => errors.push(String(event.reason)));

  const waitFor = async (predicate, label, timeout = 25000) => {
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
  const stored = async () => (await api.storage.local.get("homepage_data")).homepage_data;
  const syncStatus = async () => (await api.storage.local.get("homepage_sync_state")).homepage_sync_state || {};
  const hasNode = (data, title) =>
    Object.values(data?.nodes || {}).some((node) => node.title === title && !node.deletedAt);

  // 无头模式读剪切板会被拦截：导出时截获写入，导入时喂回同一段文本。
  let clipboardText = "";
  const originalWrite = navigator.clipboard.writeText.bind(navigator.clipboard);
  navigator.clipboard.writeText = async (text) => {
    clipboardText = text;
    try {
      return await originalWrite(text);
    } catch {
      return undefined;
    }
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

    // 本地先放一张书签，用于验证冲突合并时两侧数据都保留
    click("#btnAdd");
    await waitFor(() => document.getElementById("fieldUrl"), "新增面板");
    setField("fieldUrl", "https://example.invalid/local-only");
    setField("fieldTitle", "本地独有书签");
    click("#btnSave");
    await waitFor(async () => hasNode(await stored(), "本地独有书签"), "本地书签落盘");
    report.checks.push("本地书签落盘");

    // 打开同步并连接预置了不同 docId 的本地服务，触发 doc_conflict
    click("#btnSettings");
    await waitFor(() => document.getElementById("settingSync"), "设置面板");
    const syncBox = document.getElementById("settingSync");
    if (!syncBox.checked) {
      syncBox.checked = true;
      syncBox.dispatchEvent(new Event("change", { bubbles: true }));
    }
    setField("settingSyncServerUrl", config.baseUrl);
    setField("settingSyncServerToken", config.token);
    click("#btnSyncNow");

    await waitFor(async () => (await syncStatus()).status === "need_setup", "冲突状态出现", 30000);
    const conflictBtn = document.getElementById("btnSyncResolveConflict");
    if (!conflictBtn || conflictBtn.classList.contains("hidden")) {
      throw new Error("冲突状态已出现，但「解决冲突」按钮仍隐藏");
    }
    report.checks.push("冲突状态出现且解决按钮可见");

    const choice = config.conflictChoice || "merge";
    const choiceButton = {
      merge: "#btnConflictMerge",
      local: "#btnConflictLocal",
      remote: "#btnConflictRemote",
    }[choice];
    conflictBtn.click();
    await waitFor(() => document.getElementById("btnConflictMerge"), "冲突弹窗");
    report.checks.push(`冲突弹窗打开（choice=${choice}）`);
    click(choiceButton);
    await waitFor(async () => (await syncStatus()).status === "idle", "冲突处理完成", 40000);
    if (choice === "merge") {
      await waitFor(async () => hasNode(await stored(), "云端独有书签"), "云端书签已合并进本地", 20000);
      await waitFor(async () => hasNode(await stored(), "本地独有书签"), "本地书签仍在", 20000);
      report.checks.push("点「合并」后两侧书签都在");
    } else if (choice === "local") {
      await waitFor(async () => hasNode(await stored(), "本地独有书签"), "本地书签仍在", 20000);
      report.checks.push("点「本地覆盖云端」后本地书签仍在");
    } else {
      await waitFor(async () => hasNode(await stored(), "云端独有书签"), "云端书签已应用", 20000);
      report.checks.push("点「使用云端」后云端书签已应用");
    }

    // 冲突解决会关闭弹窗，重新打开设置面板再继续
    click("#btnSettings");
    await waitFor(() => document.getElementById("btnSyncExportBundle"), "设置面板重新打开");

    // 同步包：导出 → 删除本地书签 → 导入恢复
    click("#btnSyncExportBundle");
    await waitFor(() => clipboardText.includes("homepage.sync.bundle.v1"), "同步包导出", 20000);
    const bundleBytes = clipboardText.length;
    report.checks.push(`同步包导出（${bundleBytes} 字节）`);

    // 各分支保留下来的书签不同：merge/local 有本地书签，remote 只有云端书签。
    const survivorTitle = choice === "remote" ? "云端独有书签" : "本地独有书签";
    const beforeDelete = await stored();
    const survivorId = Object.values(beforeDelete.nodes).find((n) => n.title === survivorTitle)?.id;
    if (!survivorId) throw new Error(`找不到「${survivorTitle}」的节点 id`);
    beforeDelete.nodes[survivorId].deletedAt = Date.now();
    await api.storage.local.set({ homepage_data: beforeDelete });
    await waitFor(async () => !hasNode(await stored(), survivorTitle), `删除「${survivorTitle}」`);

    navigator.clipboard.readText = async () => clipboardText;
    click("#btnSyncImportBundle");
    await waitFor(async () => hasNode(await stored(), survivorTitle), `同步包导入恢复「${survivorTitle}」`, 25000);
    report.checks.push(`同步包导入恢复被删书签（${survivorTitle}）`);

    // 周期同步：无头浏览器的 document.visibilityState 恒为 hidden，
    // 而 startSyncInterval 明确在 hidden 时跳过 tick。这里把可见性覆写为 visible，
    // 只验证“定时器到点会拉取”这条逻辑；真实窗口的可见性行为不在本测试范围。
    Object.defineProperty(document, "visibilityState", { get: () => "visible", configurable: true });
    Object.defineProperty(document, "hidden", { get: () => false, configurable: true });

    // 周期同步：切到 1 分钟间隔，观察 lastPullAt 是否自动前进
    const interval = document.getElementById("settingSyncInterval");
    if (!interval) throw new Error("缺少周期同步下拉框");
    interval.value = "1m";
    interval.dispatchEvent(new Event("change", { bubbles: true }));
    const baseline = Number((await syncStatus()).lastPullAt) || 0;
    setField("settingSyncInterval", "1m");
    const visibility = document.visibilityState;
    const ticked = await (async () => {
      const deadline = Date.now() + 75000;
      while (Date.now() < deadline) {
        if ((Number((await syncStatus()).lastPullAt) || 0) > baseline) return true;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      return false;
    })();
    report.interval = { visibility, ticked, baseline };
    if (visibility === "visible") {
      if (!ticked) throw new Error("周期同步未在 75 秒内触发（lastPullAt 未前进）");
      report.checks.push("周期同步（1 分钟）自动触发");
    } else {
      report.checks.push(`周期同步未测：页面可见性为 ${visibility}，定时器按设计跳过`);
    }

    if (errors.length) throw new Error(errors.join("；"));
  } catch (error) {
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
