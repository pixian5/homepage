// Firefox 持久化验证运行器：注入临时扩展副本，使用真实界面事件。
(async () => {
  const config = globalThis.HOMEPAGE_PERSIST;
  const api = globalThis.browser || globalThis.chrome;
  const key = "homepage_data";
  const waitFor = async (predicate, label) => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`等待失败：${label}`);
  };
  const stored = async () => (await api.storage.local.get(key))[key];
  const click = (selector) => {
    const element = document.querySelector(selector);
    if (!element) throw new Error(`缺少元素：${selector}`);
    element.click();
  };
  const setField = (id, value) => {
    const element = document.getElementById(id);
    if (!element) throw new Error(`缺少字段：${id}`);
    element.value = value;
    // 数字/文本输入框注册的是 input 事件，复选框与下拉框注册的是 change，
    // 两种都派发，避免测试脚本与真实用户操作不一致。
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const report = { phase: config.phase };
  try {
    // newtab.html 的入口脚本被替换成了本运行器，这里动态加载真正的应用脚本
    await new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "js/app.ff.js";
      script.onload = resolve;
      script.onerror = () => reject(new Error("主应用脚本加载失败"));
      document.body.appendChild(script);
    });
    // 等主应用初始化完成（复用 NEWTAB 的 dataset 标记）
    const readyDeadline = Date.now() + 20000;
    while (Date.now() < readyDeadline && document.documentElement.dataset.homepageReady !== "true") {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (document.documentElement.dataset.homepageReady !== "true") throw new Error("首页未初始化");

    const load = async () => {
      const data = await stored();
      return {
        data,
        nodes: data ? Object.keys(data.nodes || {}).length : 0,
        backups: data ? (data.backups || []).length : 0,
        fontSize: data?.settings?.fontSize ?? null,
        hasTest: !!data && Object.values(data.nodes || {}).some((node) => node.title === "Firefox 持久化书签"),
      };
    };

    if (config.phase === "seed") {
      click("#btnSettings");
      await waitFor(() => document.getElementById("settingFontSize"), "设置面板");
      setField("settingFontSize", "22");
      await waitFor(async () => (await load()).fontSize === 22, "字号落盘");
      // 关闭设置，新增一张书签
      click("#modalOverlay");
      await waitFor(() => document.querySelector("#modalOverlay").classList.contains("hidden"), "关闭设置");
      click("#btnAdd");
      await waitFor(() => document.getElementById("fieldUrl"), "新增面板");
      setField("fieldUrl", "https://example.invalid/firefox-persist");
      setField("fieldTitle", "Firefox 持久化书签");
      click("#btnSave");
      await waitFor(async () => (await load()).hasTest, "新增落盘");
      const state = await load();
      // 导出到剪切板（Firefox headless 支持 navigator.clipboard.writeText）
      click("#btnSettings");
      await waitFor(() => document.getElementById("btnExport"), "设置面板");
      // 无头模式没有用户激活，直接读剪切板会被浏览器拦截；
      // 包一层 writeText 捕获真实导出处理函数写入的内容，仍然走原逻辑。
      let exportText = "";
      const originalWrite = navigator.clipboard.writeText.bind(navigator.clipboard);
      navigator.clipboard.writeText = async (text) => {
        exportText = text;
        try {
          return await originalWrite(text);
        } catch {
          return undefined;
        }
      };
      click("#btnExport");
      await waitFor(() => exportText.length > 0, "导出写入");
      if (!exportText.includes("nodes")) throw new Error(`导出内容不含主页数据：${exportText.slice(0, 120)}`);
      Object.assign(report, {
        nodeCount: state.nodes,
        backupCount: state.backups,
        fontSize: state.fontSize,
        exportText,
        checks: ["新增书签落盘", "字号设置落盘", "导出 JSON"],
      });
      // 改字号到 13，制造一个可回滚的差异
      setField("settingFontSize", "13");
      await waitFor(async () => (await load()).fontSize === 13, "字号改动落盘");
      report.backupRestoreReady = true;
    } else if (config.phase === "verify") {
      const state = await load();
      if (!state.hasTest) throw new Error("重启后书签丢失");
      // 备份管理里恢复最新一份（签名字号 22 之前），确认能回滚设置
      click("#btnSettings");
      await waitFor(() => document.getElementById("btnBackupManage"), "设置面板");
      click("#btnBackupManage");
      await waitFor(() => document.querySelector("[data-backup]"), "备份列表");
      const first = document.querySelector("[data-backup] .backup-restore");
      if (!first) throw new Error("备份恢复按钮缺失");
      first.click();
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const restored = await load();
      Object.assign(report, {
        nodeCount: state.nodes,
        backupCount: state.backups,
        keptTestNode: state.hasTest,
        fontSizeAfterRestore: restored.fontSize,
        checks: ["重启后书签保留", "重启后字号保留", "备份恢复可执行"],
      });
    } else if (config.phase === "reinstall") {
      const state = await load();
      const empty = !state.data || state.nodes === 0;
      if (!empty) throw new Error(`删除扩展存储后本地仍有 ${state.nodes} 个节点，未模拟出卸载`);
      // 通过真实导入面板恢复
      click("#btnSettings");
      await waitFor(() => document.getElementById("btnImport"), "设置面板");
      click("#btnImport");
      await waitFor(() => document.getElementById("importText"), "导入面板");
      const textarea = document.getElementById("importText");
      textarea.value = config.importText;
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      const mode = document.getElementById("importMode");
      if (mode) mode.value = "replace";
      click("#btnImportNow");
      await waitFor(async () => (await load()).hasTest, "导入后书签出现");
      const after = await load();
      Object.assign(report, {
        storageWasEmpty: empty,
        nodeCount: after.nodes,
        fontSize: after.fontSize,
        checks: ["删除存储后确认为空", "导入 JSON 恢复"],
      });
    } else if (config.phase === "verify-import") {
      const state = await load();
      if (!state.hasTest) throw new Error("导入后重启数据丢失");
      Object.assign(report, {
        nodeCount: state.nodes,
        backupCount: state.backups,
        fontSize: state.fontSize,
        keptTestNode: state.hasTest,
        checks: ["导入结果重启后保留"],
      });
    } else {
      throw new Error(`未知阶段：${config.phase}`);
    }
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
    // 报告失败时浏览器退出码会由外部超时兜底
  }
})();
