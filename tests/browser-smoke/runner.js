// 仅注入临时扩展副本；使用全新浏览器配置与合成数据，不读取用户配置。
(async () => {
  const config = globalThis.HOMEPAGE_SMOKE;
  const api = globalThis.browser || globalThis.chrome;
  const checks = [];
  const errors = [];
  const originalConsoleError = console.error;
  console.error = (...args) => {
    errors.push(args.map((a) => a?.stack || a?.message || String(a)).join(" "));
    originalConsoleError?.apply(console, args);
  };
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
      {
        document.dispatchEvent(
          new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true }),
        );
        await waitFor(() => {
          const ov = document.getElementById("commandPaletteOverlay");
          return ov && !ov.classList.contains("hidden");
        }, "Cmd/Ctrl+K 命令面板打开");
        const cmdInput = document.getElementById("commandPaletteInput");
        if (!cmdInput) throw new Error("缺少命令面板输入框 #commandPaletteInput");
        cmdInput.value = "mysq";
        cmdInput.dispatchEvent(new Event("input", { bubbles: true }));
        await waitFor(
          () => (document.getElementById("commandPaletteList")?.textContent || "").includes("冒烟书签 <安全文本>"),
          "命令面板拼音检索命中新增书签",
        );
        cmdInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
        await waitFor(
          () => document.getElementById("commandPaletteOverlay")?.classList.contains("hidden"),
          "Escape 关闭命令面板",
        );
        checks.push("Cmd/Ctrl+K 命令面板检索与关闭");
      }
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
      if (config.pageUrl && api?.tabs?.create && api?.scripting?.executeScript) {
        const popupMod = await import(api.runtime.getURL("popup.js"));
        const webTab = await api.tabs.create({ url: config.pageUrl, active: false });
        let loadedTab = null;
        await waitFor(async () => {
          const cur = await api.tabs.get(webTab.id);
          if (cur?.status === "complete" && cur?.url === config.pageUrl) {
            loadedTab = cur;
            return true;
          }
          return false;
        }, "打开测试网页标签");

        // 1) 验证移除静态 content_scripts 后按需注入 content-toast.js（含二次注入 IIFE 幂等）
        const t1 = await popupMod.showToastInTab(loadedTab, "按需注入提示一", 14);
        const t2 = await popupMod.showToastInTab(loadedTab, "按需注入提示二", 15);
        if (!t1 || !t2) throw new Error(`按需注入 Toast 失败：t1=${t1}, t2=${t2}`);
        const [{ result: toastText }] = await api.scripting.executeScript({
          target: { tabId: loadedTab.id },
          func: () => document.getElementById("homepage-save-toast")?.textContent || "",
        });
        if (toastText !== "按需注入提示二") throw new Error(`Toast 文本异常：${toastText}`);

        // 2) 验证按需注入 bookmark-sidebar.js、侧栏添加书签落盘与 Escape 关闭
        const currentData = await stored();
        const opened = await popupMod.openBookmarkSidebar(loadedTab, currentData, "left");
        if (!opened) throw new Error("按需注入打开书签侧栏失败");
        const [{ result: sidebarMeta }] = await api.scripting.executeScript({
          target: { tabId: loadedTab.id },
          func: () => {
            const root = document.getElementById("homepage-bookmark-sidebar-root");
            const panels = root ? root.querySelectorAll(".hp-side").length : 0;
            const targetBtn = root?.querySelector(".hp-menu-parent .hp-submenu .hp-folder");
            targetBtn?.click();
            return { panels, clicked: !!targetBtn };
          },
        });
        if (sidebarMeta?.panels !== 1 || !sidebarMeta?.clicked) {
          throw new Error(`侧栏渲染或点击异常：${JSON.stringify(sidebarMeta)}`);
        }
        await waitFor(async () => {
          const [{ result: status }] = await api.scripting.executeScript({
            target: { tabId: loadedTab.id },
            func: () => {
              const root = document.getElementById("homepage-bookmark-sidebar-root");
              const okEl = root?.querySelector(".hp-status-ok");
              const titles = [...(root?.querySelectorAll(".hp-item .hp-title") || [])].map((el) => el.textContent);
              return { okText: okEl?.textContent || "", titles };
            },
          });
          return Boolean(status?.okText) && status.titles.includes("Smoke Target Page");
        }, "侧栏保存提示与列表即时刷新");
        await waitFor(
          async () => Object.values((await stored()).nodes).some((node) => node.url === config.pageUrl),
          "后台写入网页书签落盘",
        );
        await api.scripting.executeScript({
          target: { tabId: loadedTab.id },
          func: () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })),
        });
        await waitFor(async () => {
          const [{ result: exists }] = await api.scripting.executeScript({
            target: { tabId: loadedTab.id },
            func: () => Boolean(document.getElementById("homepage-bookmark-sidebar-root")),
          });
          return exists === false;
        }, "Escape 关闭书签侧栏");
        await api.tabs.remove(loadedTab.id).catch(() => {});
        checks.push("按需注入 Toast 与网页书签侧栏闭环");
      }
      // 通过同源 iframe 加载 popup.html，避免对扩展页调用 scripting.executeScript（MV3 禁止）。
      {
        const iframe = document.createElement("iframe");
        iframe.src = "popup.html";
        iframe.style.cssText = "position:fixed;left:-9999px;width:360px;height:520px;";
        await new Promise((resolve, reject) => {
          iframe.onload = resolve;
          iframe.onerror = () => reject(new Error("Popup 页面加载失败"));
          document.body.appendChild(iframe);
        });
        const pWin = iframe.contentWindow;
        const pDoc = iframe.contentDocument;
        if (!pWin || !pDoc) throw new Error("无法访问 Popup 同源文档");
        pWin.addEventListener("error", (event) => errors.push(`popup: ${event.message}`));
        pWin.addEventListener("unhandledrejection", (event) => errors.push(`popup: ${String(event.reason)}`));
        await waitFor(() => !pDoc.body.classList.contains("hidden"), "Popup body 显示");
        await waitFor(() => pDoc.getElementById("popupBookmarksTitle")?.textContent === "所有书签", "Popup 标题渲染");
        await waitFor(
          () =>
            pDoc.querySelectorAll("#bookmarkFolderMenu button").length >= 1 &&
            pDoc.querySelectorAll("#saveAllTabsFolderMenu button").length >= 1,
          "Popup 菜单分组渲染",
        );
        await waitFor(() => {
          const text = pDoc.getElementById("popupBookmarkList")?.textContent || "";
          return text.includes("冒烟书签 <安全文本>") && (!config.pageUrl || text.includes("Smoke Target Page"));
        }, "Popup 书签列表渲染");
        const emptyEl = pDoc.getElementById("empty");
        if (!emptyEl?.classList.contains("hidden")) {
          throw new Error(`Popup 意外显示空态提示：${emptyEl?.textContent || ""}`);
        }
        iframe.remove();
        checks.push("Popup 页面渲染与书签列表加载");
      }
      if (errors.length) throw new Error(errors.join("；"));
      sessionStorage.setItem("smoke-checks", JSON.stringify(checks));
      sessionStorage.setItem("smoke-reload", "1");
      location.reload();
      return;
    }
    if (errors.length) throw new Error(errors.join("；"));
  } catch (error) {
    failure = `${error?.message || error}\n${error?.stack || ""}`;
  }
  await fetch(config.reportUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ browser: config.browser, checks: [...new Set(checks)], failure }),
  });
})();
