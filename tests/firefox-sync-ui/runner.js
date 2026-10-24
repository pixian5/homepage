// Firefox 同步设置界面验证运行器。
// 只通过设置面板里的真实控件操作，不直接调用同步引擎内部函数。
(async () => {
  const config = globalThis.HOMEPAGE_SYNC_UI;
  const api = globalThis.browser || globalThis.chrome;
  const report = { checks: [] };
  const errors = [];
  window.addEventListener("error", (event) => errors.push(event.message));
  window.addEventListener("unhandledrejection", (event) => errors.push(String(event.reason)));

  const waitFor = async (predicate, label, timeout = 20000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 60));
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
  const statusText = () => (document.getElementById("syncStatusLine")?.textContent || "").trim();
  const toasts = () => [...document.querySelectorAll("#toastContainer *")].map((n) => n.textContent || "").join(" ");

  try {
    // 主应用脚本被入口替换，需要自己加载
    await new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "js/app.ff.js";
      script.onload = resolve;
      script.onerror = () => reject(new Error("主应用脚本加载失败"));
      document.body.appendChild(script);
    });
    await waitFor(() => document.documentElement.dataset.homepageReady === "true", "首页初始化");

    // 新 profile 是空主页：先通过界面新增一张书签，这样同步才有可验证的内容
    click("#btnAdd");
    await waitFor(() => document.getElementById("fieldUrl"), "新增面板");
    setField("fieldUrl", "https://example.invalid/sync-ui");
    setField("fieldTitle", "同步界面验证书签");
    click("#btnSave");
    await waitFor(async () => {
      const got = await api.storage.local.get("homepage_data");
      return Object.values(got.homepage_data?.nodes || {}).some((node) => node.title === "同步界面验证书签");
    }, "新增书签落盘");
    report.checks.push("新增书签落盘");

    click("#btnSettings");
    await waitFor(() => document.getElementById("settingSync"), "设置面板");
    report.checks.push("设置面板打开");

    // 先不填服务器直接点“立即同步”，应提示未启用或缺少地址，证明按钮真的绑定了
    click("#btnSyncNow");
    await new Promise((resolve) => setTimeout(resolve, 500));
    const offHint = toasts();
    report.checks.push(`未启用时点击立即同步有提示：${offHint.length > 0}`);

    // 打开同步并填入本地服务器
    const syncBox = document.getElementById("settingSync");
    if (!syncBox.checked) {
      syncBox.checked = true;
      syncBox.dispatchEvent(new Event("change", { bubbles: true }));
    }
    setField("settingSyncServerUrl", config.baseUrl);
    setField("settingSyncServerToken", config.token);
    const interval = document.getElementById("settingSyncInterval");
    if (interval) {
      interval.value = "off";
      interval.dispatchEvent(new Event("change", { bubbles: true }));
    }
    report.checks.push("填写服务器地址与 Token");

    // 测试服务器连通性
    click("#btnSyncTestServer");
    await waitFor(() => /成功|込|connected|ok/i.test(toasts()) || statusText().length > 0, "测试服务器返回", 20000);
    report.checks.push("测试服务器按钮有响应");

    // 立即同步：等待状态行出现成功或同步完成提示
    const before = statusText();
    click("#btnSyncNow");
    await waitFor(() => statusText() !== before || /同步|成功|完成/i.test(toasts()), "立即同步触发", 20000);
    report.checks.push("立即同步按钮触发同步");

    // 等待同步引擎落盘：本地设置里应记录启用状态与服务器地址
    await waitFor(async () => {
      const got = await api.storage.local.get("homepage_data");
      const settings = got.homepage_data?.settings || {};
      return settings.syncEnabled === true && settings.syncServerUrl === config.baseUrl;
    }, "同步配置落盘");
    report.checks.push("同步配置写入本地存储");

    // 再点一次，验证重复同步不会报错
    click("#btnSyncNow");
    await new Promise((resolve) => setTimeout(resolve, 2500));
    report.checks.push("重复立即同步无异常");

    const got = await api.storage.local.get(["homepage_data", "homepage_sync_state", "homepage_sync_outbox"]);
    report.syncState = got.homepage_sync_state || null;
    report.outboxRows = Array.isArray(got.homepage_sync_outbox) ? got.homepage_sync_outbox.length : 0;
    report.nodeCount = Object.keys(got.homepage_data?.nodes || {}).length;
    report.statusText = statusText();
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
