// 仅注入临时扩展副本；使用全新浏览器配置与合成数据，不读取用户配置。
(async () => {
  const config = globalThis.HOMEPAGE_SMOKE;
  const api = globalThis.browser || globalThis.chrome;
  const checks = [];
  const errors = [];
  window.addEventListener("error", (event) => errors.push(event.message));
  window.addEventListener("unhandledrejection", (event) => errors.push(String(event.reason)));
  const waitFor = async (predicate, label) => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    throw new Error(`等待失败：${label}；脚本错误：${errors.join("；")}`);
  };
  const click = (selector) => {
    const element = document.querySelector(selector);
    if (!element || element.disabled) throw new Error(`不可点击：${selector}`);
    element.click();
  };
  const field = (id, value) => {
    const element = document.getElementById(id);
    if (!element) throw new Error(`缺少字段：${id}`);
    element.value = value;
    element.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const stored = async () => (await api.storage.local.get(config.storageKey))[config.storageKey];
  const tile = () =>
    [...document.querySelectorAll("#grid .tile")].find((item) => item.textContent.includes("冒烟书签"));
  let failure = null;
  try {
    const reloaded = sessionStorage.getItem("smoke-reload") === "1";
    if (!reloaded) await api.storage.local.set({ [config.storageKey]: config.fixture });
    await new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = config.browser === "firefox" ? "js/app.ff.js" : "js/app.js";
      if (config.browser !== "firefox") script.type = "module";
      script.onload = resolve;
      script.onerror = () => reject(new Error("主应用脚本加载失败"));
      document.body.appendChild(script);
    });
    await waitFor(() => document.documentElement.dataset.homepageReady === "true", "首页初始化");
    checks.push("首页脚本执行");
    if (reloaded) {
      await waitFor(() => tile(), "刷新后书签恢复");
      if ((await stored()).settings.language !== "zh-CN") throw new Error("刷新后语言丢失");
      checks.push(...JSON.parse(sessionStorage.getItem("smoke-checks")), "刷新后数据与语言保留");
    } else {
      click("#btnSettings");
      await waitFor(() => document.getElementById("settingLanguage"), "设置面板打开");
      field("settingLanguage", "en");
      await waitFor(() => document.querySelector("#btnAdd").textContent === "Add", "切换英文");
      await waitFor(async () => (await stored()).settings.language === "en", "英文设置落盘");
      field("settingLanguage", "zh-CN");
      await waitFor(async () => (await stored()).settings.language === "zh-CN", "中文设置落盘");
      checks.push("设置打开与中英文切换落盘");
      // 点击遮罩触发真实关闭处理，不直接调用内部控制器。
      click("#modalOverlay");
      await waitFor(() => document.querySelector("#modalOverlay").classList.contains("hidden"), "关闭设置");
      click("#btnAdd");
      await waitFor(() => document.getElementById("fieldUrl"), "新增面板");
      field("fieldUrl", "https://example.invalid/homepage-smoke");
      field("fieldTitle", "冒烟书签 <安全文本>");
      field("fieldIconType", "color");
      click("#btnSave");
      await waitFor(() => tile(), "新增书签显示");
      await waitFor(
        async () => Object.values((await stored()).nodes).some((node) => node.title === "冒烟书签 <安全文本>"),
        "新增落盘",
      );
      checks.push("新增书签与安全文本渲染");
      tile().dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 100, clientY: 100 }));
      await waitFor(() => !document.querySelector("#contextMenu").classList.contains("hidden"), "右键菜单");
      const remove = [...document.querySelectorAll("#contextMenu button")].find(
        (button) => button.textContent === "删除",
      );
      if (!remove) throw new Error("删除菜单缺失");
      remove.click();
      await waitFor(() => !tile(), "删除书签");
      const undo = [...document.querySelectorAll("#toastContainer button")].find(
        (button) => button.textContent === "撤销",
      );
      if (!undo) throw new Error("撤销按钮缺失");
      undo.click();
      await waitFor(() => tile(), "撤销恢复");
      await waitFor(
        async () => Object.values((await stored()).nodes).some((node) => node.title === "冒烟书签 <安全文本>"),
        "撤销落盘",
      );
      checks.push("右键删除与撤销落盘");
      if (errors.length) throw new Error(errors.join("；"));
      sessionStorage.setItem("smoke-checks", JSON.stringify(checks));
      sessionStorage.setItem("smoke-reload", "1");
      location.reload();
      return;
    }
    if (errors.length) throw new Error(errors.join("；"));
  } catch (error) {
    failure = error.stack || String(error);
  }
  await fetch(config.reportUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ browser: config.browser, checks: [...new Set(checks)], failure }),
  });
})();
