/** 设置数据导入导出与本地备份管理。依赖在实例内绑定，不复制主页数据。 */
export function createImportExport(ctx, refreshSyncStatusLine) {
  const { getData, setData, getActiveGroupId, syncBackupBaseline } = ctx;
  const {
    $,
    qsa,
    html,
    rawHtml,
    t,
    toast,
    elements,
    openModal,
    closeModal,
    runWithButtonState,
    render,
    persistData,
    queuePersist,
    pushBackup,
    processPendingIconFetches,
    normalizeUrl,
    normalizeUrlWithScheme,
    detectExtensionPlatform,
    createDocId,
    getOrCreateDeviceId,
    getSyncStatus,
    exportSyncBundle,
    importSyncBundle,
    exportNetscapeBookmarksHtml,
    parseNetscapeBookmarksHtml,
    bookmarksToHomepageData,
    leaveSettingsForSubpanel,
    defaultSettings,
    cloneDataSnapshot,
    repairHomepageData,
    markNodeDeleted,
    mergeRootBookmarkData,
    mergeHomepage,
    toSyncDocument,
    createItemNode,
    stampNodeFieldChanges,
    resetSettingsClockBaseline,
    resetPlacementClockBaseline,
    getRootGroup,
    getRootContainers,
    getRootContainerById,
    getPlacementList,
    setPlacementList,
    touchPlacementContainer,
    isAllBookmarksGroup,
    RECENT_GROUP_ID,
  } = { ...ctx.ui, ...ctx.deps };

  function downloadJsonFile(filename, obj) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /** 下载纯文本文件（标准 HTML 书签导出用） */
  function downloadTextFile(filename, text, mime = "text/html") {
    const blob = new Blob([text], { type: `${mime}; charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function exportJsonToClipboard() {
    try {
      const payload = JSON.stringify(getData(), null, 2);
      await navigator.clipboard.writeText(payload);
      toast("设置、卡片、分组数据都已复制到剪切板", "success");
    } catch (err) {
      toast(`导出设置失败：${err.message || "无法写入剪切板"}`, "error");
      openManualExportModal();
    }
  }

  function openManualExportModal() {
    void leaveSettingsForSubpanel();
    const payload = JSON.stringify(getData(), null, 2);
    const modalHtml = html`
      <h2>导出设置</h2>
      <div class="section">
        <textarea readonly>${payload}</textarea>
      </div>
      <div class="actions">
        <button id="btnCopy" class="icon-btn">复制</button>
        <button id="btnClose" class="icon-btn">关闭</button>
      </div>
    `;
    openModal(modalHtml);
    $("btnCopy").addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(payload);
        toast("已复制到剪切板", "success");
      } catch (err) {
        toast(`复制失败：${err.message || "无法写入剪切板"}`, "error");
      }
    });
    $("btnClose").addEventListener("click", closeModal);
  }

  async function openImportModal() {
    await leaveSettingsForSubpanel();

    const modalHtml = html`
      <h2>导入设置</h2>
      <div class="section">
        <label>导入策略</label>
        <select id="importMode">
          <option value="replace">覆盖所有</option>
          <option value="merge">合并现有</option>
          <option value="add">仅新增不覆盖</option>
        </select>
      </div>
      <div class="section">
        <textarea id="importText" placeholder="正在读取剪切板内设置，如果没导出设置你得先从你其它浏览器导出设置才能导入设置..."></textarea>
      </div>
      <div class="actions">
        <button id="btnCancel" class="icon-btn">取消</button>
        <button id="btnImportNow" class="icon-btn">导入</button>
      </div>
    `;
    openModal(modalHtml);
    $("btnCancel").addEventListener("click", closeModal);
    $("btnImportNow").addEventListener("click", async () => {
      try {
        const incoming = JSON.parse($("importText").value.trim());
        const mode = $("importMode").value;
        if (!incoming || typeof incoming !== "object") throw new Error("数据格式不合法");
        // 运行时 schema 校验：修复非法字段、清理悬空引用、合并默认 settings
        const repairedIncoming = repairHomepageData(incoming, defaultSettings());
        if (!repairedIncoming.schemaVersion) throw new Error("无 schemaVersion");
        pushBackup();
        if (mode === "replace") {
          setData(repairedIncoming);
          resetSettingsClockBaseline(getData());
          resetPlacementClockBaseline(getData());
        } else if (mode === "merge") {
          const deviceId = await getOrCreateDeviceId();
          const incomingDoc = toSyncDocument(repairedIncoming, {
            deviceId: `import_${deviceId}`,
            docId: repairedIncoming?._syncMeta?.docId || createDocId(),
            revision: Number(repairedIncoming?._syncMeta?.revision || 1),
            writtenAt: Number(repairedIncoming.lastUpdated || Date.now()),
          });
          const merged = mergeHomepage(getData(), incomingDoc, { deviceId, now: Date.now() });
          if (!merged.ok) throw new Error(merged.reason || "合并失败");
          if (repairedIncoming?.settings?.backgroundCustom && !merged.state.settings?.backgroundCustom) {
            merged.state.settings.backgroundCustom = repairedIncoming.settings.backgroundCustom;
          }
          setData(merged.state);
          resetSettingsClockBaseline(getData());
          resetPlacementClockBaseline(getData());
        } else if (mode === "add") {
          mergeRootBookmarkData(getData(), repairedIncoming);
        }
        // 导入完成后对所有节点 URL 做协议白名单校验，丢弃危险协议
        if (getData()?.nodes) {
          for (const id of Object.keys(getData().nodes)) {
            const node = getData().nodes[id];
            if (!node || node.type === "folder") continue;
            const safe = normalizeUrl(node.url);
            if (!safe) {
              markNodeDeleted(getData(), id);
              for (const g of getData().groups || []) {
                if (Array.isArray(g.nodes)) g.nodes = g.nodes.filter((nid) => nid !== id);
              }
            } else {
              if (node.url !== safe) stampNodeFieldChanges(node, { urlChanged: true });
              node.url = safe;
            }
          }
        }
        await persistData();
        closeModal();
        render();
        processPendingIconFetches();
        toast("导入设置成功", "success");
      } catch (err) {
        toast(`导入设置失败，你检查一下你的设置对了嘛，先去你其它浏览器导出设置才能导入设置：${err.message}`, "error");
      }
    });

    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        $("importText").value = text;
        toast("已从剪切板读取", "success");
      } else {
        toast("剪切板为空", "warning");
      }
    } catch (err) {
      toast(`读取剪切板失败：${err.message || "权限受限"}`, "error");
    }
  }

  function openImportUrlModal() {
    void leaveSettingsForSubpanel();

    if (!getRootGroup()) {
      toast(t("group.noneAvailable"), "warning");
      return;
    }
    const options = rawHtml(
      getRootContainers()
        .map((g) => html`<option value="${g.id}">${isAllBookmarksGroup(g) ? g.name : g.title}</option>`)
        .join(""),
    );
    const modalHtml = html`
      <h2>导入网址</h2>
      <div class="section">
        <label>选择分组</label>
        <select id="importUrlGroup">${options}</select>
      </div>
      <div class="section">
        <div class="row-inline">
          <button id="btnImportUrlHttp" class="icon-btn">导入为HTTP</button>
          <button id="btnImportUrlHttps" class="icon-btn">导入为HTTPS</button>
          <button id="btnImportUrlCancel" class="icon-btn">取消</button>
        </div>
      </div>
      <div class="section">
        <textarea id="importUrlText" placeholder="每行一个网址"></textarea>
      </div>
    `;
    openModal(modalHtml);
    const groupSelect = $("importUrlGroup");
    const currentGroupId = getActiveGroupId();
    const defaultGroupId = currentGroupId && currentGroupId !== RECENT_GROUP_ID ? currentGroupId : getRootGroup().id;
    groupSelect.value = defaultGroupId;

    const closeWithCleanup = () => {
      elements.modalOverlay.removeEventListener("click", onOverlayClick);
      closeModal();
    };
    const onOverlayClick = (e) => {
      if (e.target === elements.modalOverlay) closeWithCleanup();
    };
    elements.modalOverlay.addEventListener("click", onOverlayClick);

    const importWithScheme = async (scheme) => {
      const groupId = groupSelect.value;
      const group = getRootContainerById(groupId);
      if (!group) {
        toast(t("group.notFound"), "error");
        return;
      }
      const rawText = $("importUrlText").value || "";
      const lines = rawText.split(/\r?\n/);
      const urls = [];
      let invalid = 0;
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const token = trimmed.split(/\s+/)[0];
        const normalized = normalizeUrlWithScheme(token, scheme);
        if (!normalized) {
          invalid += 1;
          continue;
        }
        urls.push(normalized);
      }
      if (!urls.length) {
        toast(t("import.noUrls"), "warning");
        return;
      }
      const targetList = getPlacementList(group);
      pushBackup();
      for (const url of urls) {
        let title = "";
        try {
          title = new URL(url).hostname;
        } catch (_e) {
          title = "";
        }
        const node = createItemNode({ url, title, iconType: "auto", iconPending: true });
        getData().nodes[node.id] = node;
        targetList.push(node.id);
      }
      setPlacementList(group, targetList);
      touchPlacementContainer(group);
      getData().settings.lastActiveGroupId = group.id;
      await persistData();
      closeWithCleanup();
      render();
      processPendingIconFetches();
      toast(
        invalid ? `已导入 ${urls.length} 条，忽略 ${invalid} 条` : `已导入 ${urls.length} 条`,
        invalid ? "warning" : "success",
      );
    };

    $("btnImportUrlCancel").addEventListener("click", closeWithCleanup);
    $("btnImportUrlHttp").addEventListener("click", () => importWithScheme("http"));
    $("btnImportUrlHttps").addEventListener("click", () => importWithScheme("https"));
  }

  function openBackupModal() {
    void leaveSettingsForSubpanel();
    const list = rawHtml(
      getData()
        .backups.map(
          (b) =>
            html`<div class="row" data-backup="${b.id}"><div>${new Date(b.ts).toLocaleString()}</div><div class="row-actions"><button class="icon-btn backup-restore">恢复</button><button class="icon-btn backup-delete">删除</button></div></div>`,
        )
        .join(""),
    );
    const modalHtml = html`
      <h2>备份管理</h2>
      <div class="section">${getData().backups.length ? list : "暂无备份"}</div>
      <div class="actions"><button id="btnClose" class="icon-btn">关闭</button></div>
    `;
    openModal(modalHtml);
    qsa(".backup-restore", elements.modal).forEach((btn) => {
      btn.addEventListener("click", async () => {
        const row = btn.closest("[data-backup]");
        const backup = getData().backups.find((b) => b.id === row.dataset.backup);
        if (!backup) return;
        const backupsBeforeRestore = Array.isArray(getData().backups) ? cloneDataSnapshot(getData().backups) : [];
        // 恢复前先做运行时 schema 校验，避免损坏的备份快照原样进入运行态
        const restoredData = repairHomepageData(cloneDataSnapshot(backup.data), defaultSettings());
        restoredData.backups = backupsBeforeRestore;
        // 恢复后对所有节点 URL 做协议白名单校验，丢弃危险协议
        if (restoredData?.nodes) {
          for (const id of Object.keys(restoredData.nodes)) {
            const node = restoredData.nodes[id];
            if (!node || node.type === "folder") continue;
            const safe = normalizeUrl(node.url);
            if (!safe) {
              markNodeDeleted(restoredData, id);
              for (const g of restoredData.groups || []) {
                if (Array.isArray(g.nodes)) g.nodes = g.nodes.filter((nid) => nid !== id);
              }
            } else {
              if (node.url !== safe) stampNodeFieldChanges(node, { urlChanged: true });
              node.url = safe;
            }
          }
        }
        const previous = getData();
        setData(restoredData);
        // 恢复已有快照不应再生成一份内容重复的自动备份。
        syncBackupBaseline(restoredData);
        try {
          const result = await persistData();
          if (!result.ok) throw new Error(result.err || "写入失败");
        } catch (error) {
          setData(previous);
          syncBackupBaseline(previous);
          toast(`恢复备份失败：${error.message || error}`, "error");
          return;
        }
        closeModal();
        render();
        toast("已恢复备份", "success");
      });
    });
    qsa(".backup-delete", elements.modal).forEach((btn) => {
      btn.addEventListener("click", () => {
        const row = btn.closest("[data-backup]");
        if (!row) return;
        const id = row.dataset.backup;
        if (!id) return;
        getData().backups = (getData().backups || []).filter((b) => b.id !== id);
        queuePersist();
        openBackupModal();
        toast("已删除备份", "success");
      });
    });
    $("btnClose").addEventListener("click", closeModal);
  }

  // 设置弹窗每次打开都会重建 DOM，只绑定本次生成的控件。
  function bindButtons() {
    $("btnSyncExportBundle")?.addEventListener("click", async () => {
      await runWithButtonState($("btnSyncExportBundle"), t("settings.sync.exporting"), async () => {
        try {
          const deviceId = await getOrCreateDeviceId();
          const bundle = exportSyncBundle(getData(), {
            deviceId,
            docId: createDocId(),
            platform: /firefox/i.test(navigator.userAgent)
              ? "firefox"
              : /safari/i.test(navigator.userAgent) && !/chrome|crios|android/i.test(navigator.userAgent)
                ? "safari"
                : "chrome",
          });
          await navigator.clipboard.writeText(JSON.stringify(bundle, null, 2));
          toast(t("settings.sync.exportOk"));
        } catch (e) {
          toast(t("settings.sync.importFail", { reason: e?.message || "export" }), "error");
        }
      });
    });
    $("btnSyncImportBundle")?.addEventListener("click", async () => {
      await runWithButtonState($("btnSyncImportBundle"), t("settings.sync.importing"), async () => {
        try {
          const text = await navigator.clipboard.readText();
          const bundle = JSON.parse(text);
          const deviceId = await getOrCreateDeviceId();
          const result = importSyncBundle(getData(), bundle, { deviceId });
          if (!result.ok) {
            toast(t("settings.sync.importFail", { reason: result.reason || "merge" }), "error");
            return;
          }
          pushBackup();
          setData(result.state);
          if (!getData().settings) getData().settings = {};
          resetSettingsClockBaseline(getData());
          resetPlacementClockBaseline(getData());
          // 保持用户当前同步开关
          await persistData();
          render();
          processPendingIconFetches();
          toast(t("settings.sync.importOk"));
          void refreshSyncStatusLine();
        } catch (e) {
          toast(t("settings.sync.importFail", { reason: e?.message || "parse" }), "error");
        }
      });
    });

    $("btnSyncExportFile")?.addEventListener("click", async () => {
      await runWithButtonState($("btnSyncExportFile"), t("settings.sync.exportingFile"), async () => {
        try {
          const deviceId = await getOrCreateDeviceId();
          const st = getSyncStatus();
          const bundle = exportSyncBundle(getData(), {
            deviceId,
            docId: st.docId || createDocId(),
            platform: detectExtensionPlatform(),
          });
          const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
          downloadJsonFile(`homepage-sync-${stamp}.json`, bundle);
          toast(t("settings.sync.exportOk"));
        } catch (e) {
          toast(t("settings.sync.importFail", { reason: e?.message || "export" }), "error");
        }
      });
    });
    $("btnSyncImportFile")?.addEventListener("click", () => {
      $("syncImportFileInput")?.click();
    });
    $("syncImportFileInput")?.addEventListener("change", async (e) => {
      const file = e.target?.files?.[0];
      e.target.value = "";
      if (!file) return;
      await runWithButtonState($("btnSyncImportFile"), t("settings.sync.importingFile"), async () => {
        try {
          const text = await file.text();
          const bundle = JSON.parse(text);
          const deviceId = await getOrCreateDeviceId();
          const result = importSyncBundle(getData(), bundle, { deviceId });
          if (!result.ok) {
            toast(t("settings.sync.importFail", { reason: result.reason || "merge" }), "error");
            return;
          }
          pushBackup();
          setData(result.state);
          if (!getData().settings) getData().settings = {};
          resetSettingsClockBaseline(getData());
          resetPlacementClockBaseline(getData());
          await persistData();
          render();
          processPendingIconFetches();
          toast(t("settings.sync.importOk"));
          void refreshSyncStatusLine();
        } catch (err) {
          toast(t("settings.sync.importFail", { reason: err?.message || "parse" }), "error");
        }
      });
    });

    $("btnExport").addEventListener("click", async () => {
      await runWithButtonState($("btnExport"), t("settings.action.exporting"), () => exportJsonToClipboard());
    });
    $("btnImport").addEventListener("click", () => openImportModal());
    $("btnImportUrl").addEventListener("click", () => openImportUrlModal());
    $("btnBackupManage").addEventListener("click", () => openBackupModal());

    // 导出为标准 Netscape 书签 HTML：Chrome/Firefox/Safari/Edge 可直接导入
    $("btnExportBookmarksHtml")?.addEventListener("click", async () => {
      await runWithButtonState($("btnExportBookmarksHtml"), t("settings.bookmarks.exporting"), async () => {
        try {
          const htmlText = exportNetscapeBookmarksHtml(getData());
          const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
          downloadTextFile(`homepage-bookmarks-${stamp}.html`, htmlText);
          toast(t("settings.bookmarks.exportOk"));
        } catch (e) {
          toast(t("settings.bookmarks.exportFail", { reason: e?.message || "export" }), "error");
        }
      });
    });

    // 导入标准书签 HTML：解析后并入「全部」根（保留文件夹层级，重复 URL 自动去重）
    $("btnImportBookmarksHtml")?.addEventListener("click", () => {
      $("importBookmarksHtmlInput")?.click();
    });
    $("importBookmarksHtmlInput")?.addEventListener("change", async (e) => {
      const file = e.target?.files?.[0];
      e.target.value = "";
      if (!file) return;
      await runWithButtonState($("btnImportBookmarksHtml"), t("settings.bookmarks.importing"), async () => {
        try {
          const text = await file.text();
          const parsed = parseNetscapeBookmarksHtml(text);
          if (!parsed.groups.length) {
            toast(t("settings.bookmarks.importEmpty"), "warning");
            return;
          }
          // 含根文件夹结构的标准书签（如 Chrome 的「书签栏」）：让用户选择导入形态——
          // 确认 = 作为新的顶层分组（以文件名命名）；取消 = 并入现有全部书签
          const hasStructure = parsed.groups.some((group) => group.name);
          const asNewGroup = hasStructure && confirm(t("settings.bookmarks.askNewGroup"));
          const groupName = asNewGroup
            ? file.name
                .replace(/\.[^.]+$/, "")
                .trim()
                .slice(0, 40) || ""
            : "";
          const deviceId = await getOrCreateDeviceId();
          // 按现有数据的全部书签 URL 去重：同一文件重复导入不会翻倍
          const knownUrls = new Set(
            Object.values(getData().nodes || {})
              .filter((node) => node?.type === "item" && !node.deletedAt && node.url)
              .map((node) => node.url),
          );
          const incoming = bookmarksToHomepageData(parsed, {
            now: Date.now(),
            updatedBy: deviceId,
            knownUrls,
            mode: asNewGroup ? "new_group" : "merge_root",
            groupName,
          });
          if (!Object.keys(incoming.nodes).length) {
            toast(t("settings.bookmarks.importEmpty"), "warning");
            return;
          }
          pushBackup();
          // mergeRootBookmarkData：同 ID 以本机为准、只追加缺失引用，天然幂等可重复导入
          mergeRootBookmarkData(getData(), incoming);
          await persistData();
          render();
          processPendingIconFetches();
          toast(t("settings.bookmarks.importOk"));
          void refreshSyncStatusLine();
        } catch (err) {
          toast(t("settings.bookmarks.importFail", { reason: err?.message || "parse" }), "error");
        }
      });
    });
  }

  return { bindButtons, exportJsonToClipboard, openImportModal, openImportUrlModal, openBackupModal, downloadJsonFile };
}
