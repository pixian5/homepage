import { translateAppText } from "./app-i18n.js";

/** 设置数据导入导出与本地备份管理。依赖在实例内绑定，不复制主页数据。 */
export function createImportExport(ctx, refreshSyncStatusLine) {
  const { getData, setData, getActiveGroupId, syncBackupBaseline } = ctx;
  const {
    $,
    qsa,
    html,
    rawHtml,
    t: rawT,
    toast,
    elements,
    openModal,
    closeModal,
    runWithButtonState,
    render,
    persistData,
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
    removeNodeFromLocation,
    findDuplicateBookmarkGroups,
    mergeDuplicateBookmarks,
    isAllBookmarksGroup,
    RECENT_GROUP_ID,
  } = { ...ctx.ui, ...ctx.deps };

  const t = typeof rawT === "function" ? rawT : (key, vars = null) => translateAppText("zh-CN", key, vars);

  let importInFlight = false;

  /**
   * 将持久化等待期间发生的外部并发原地编辑（新增/修改/删除节点、分组、设置）合并回回滚基线，
   * 避免导入写盘失败回滚时顺带抹掉用户在保存窗口期内的正常编辑。
   * 若无并发编辑则不触碰 target，保持原对象引用与结构零改动。
   */
  function preserveConcurrentEdits(target, postChangeSnapshot, currentData) {
    if (!target || !postChangeSnapshot || !currentData) return;

    // 1. 设置项并发改动
    if (currentData.settings && postChangeSnapshot.settings && target.settings) {
      for (const [key, val] of Object.entries(currentData.settings)) {
        if (JSON.stringify(val) !== JSON.stringify(postChangeSnapshot.settings[key])) {
          target.settings[key] = cloneDataSnapshot(val);
        }
      }
    }

    // 2. 节点并发新增、编辑或删除
    if (currentData.nodes && postChangeSnapshot.nodes && target.nodes) {
      for (const [id, node] of Object.entries(currentData.nodes)) {
        const snapNode = postChangeSnapshot.nodes[id];
        if (!snapNode || JSON.stringify(node) !== JSON.stringify(snapNode)) {
          target.nodes[id] = cloneDataSnapshot(node);
        }
      }
      for (const id of Object.keys(postChangeSnapshot.nodes)) {
        if (!(id in currentData.nodes) && id in target.nodes) {
          delete target.nodes[id];
        }
      }
    }

    // 3. 分组与放置列表并发改动
    if (Array.isArray(currentData.groups) && Array.isArray(postChangeSnapshot.groups) && Array.isArray(target.groups)) {
      for (const group of currentData.groups) {
        const snapGroup = postChangeSnapshot.groups.find((g) => g.id === group.id);
        const targetGroup = target.groups.find((g) => g.id === group.id);
        if (!snapGroup) {
          if (!targetGroup) {
            target.groups.push(cloneDataSnapshot(group));
          }
          continue;
        }
        if (!targetGroup) continue;
        if (group.name !== snapGroup.name) targetGroup.name = group.name;
        if (group.title !== snapGroup.title) targetGroup.title = group.title;
        if (group.order !== snapGroup.order) targetGroup.order = group.order;
        if (Array.isArray(group.nodes) && Array.isArray(snapGroup.nodes) && Array.isArray(targetGroup.nodes)) {
          const snapSet = new Set(snapGroup.nodes);
          const curSet = new Set(group.nodes);
          for (const nid of group.nodes) {
            if (!snapSet.has(nid) && !targetGroup.nodes.includes(nid)) {
              targetGroup.nodes.push(nid);
            }
          }
          for (const nid of snapGroup.nodes) {
            if (!curSet.has(nid) && targetGroup.nodes.includes(nid)) {
              targetGroup.nodes = targetGroup.nodes.filter((id) => id !== nid);
            }
          }
        }
      }
    }
  }

  /** 在隔离副本上修改，写盘失败恢复原对象；成功后的关闭/渲染由调用方负责。 */
  async function commitImport(change) {
    if (importInFlight) throw new Error(t("settings.import.inFlight"));
    importInFlight = true;
    const previous = getData();
    let workingData = null;
    let postChangeSnapshot = null;
    try {
      setData(cloneDataSnapshot(previous));
      await change();
      workingData = getData();
      postChangeSnapshot = cloneDataSnapshot(workingData);
      const result = await persistData();
      if (!result?.ok) throw new Error(result?.err || t("settings.import.writeFailed"));
    } catch (error) {
      const currentAfterFail = getData();
      if (workingData && currentAfterFail && currentAfterFail !== workingData) {
        // 持久化等待期间其它标签页重载或外部调用了 setData：保留最新外部数据，不用旧快照覆盖
        syncBackupBaseline?.(currentAfterFail);
        resetSettingsClockBaseline?.(currentAfterFail);
        resetPlacementClockBaseline?.(currentAfterFail);
      } else {
        if (postChangeSnapshot && currentAfterFail) {
          preserveConcurrentEdits(previous, postChangeSnapshot, currentAfterFail);
        }
        setData(previous);
        syncBackupBaseline?.(previous);
        resetSettingsClockBaseline?.(previous);
        resetPlacementClockBaseline?.(previous);
      }
      throw error;
    } finally {
      importInFlight = false;
    }
  }

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
      toast(t("settings.export.clipboardOk"), "success");
    } catch (err) {
      toast(t("settings.export.fail", { reason: err.message || t("settings.export.clipboardDeny") }), "error");
      openManualExportModal();
    }
  }

  function openManualExportModal() {
    void leaveSettingsForSubpanel();
    const payload = JSON.stringify(getData(), null, 2);
    const modalHtml = html`
      <h2>${t("settings.export.title")}</h2>
      <div class="section">
        <textarea readonly>${payload}</textarea>
      </div>
      <div class="actions">
        <button id="btnCopy" class="icon-btn">${t("common.copy")}</button>
        <button id="btnClose" class="icon-btn">${t("common.close")}</button>
      </div>
    `;
    openModal(modalHtml);
    $("btnCopy").addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(payload);
        toast(t("settings.export.copied"), "success");
      } catch (err) {
        toast(t("settings.export.copyFail", { reason: err.message || t("settings.export.clipboardDeny") }), "error");
      }
    });
    $("btnClose").addEventListener("click", closeModal);
  }

  async function openImportModal() {
    await leaveSettingsForSubpanel();

    const modalHtml = html`
      <h2>${t("settings.import.title")}</h2>
      <div class="section">
        <label>${t("settings.import.strategy")}</label>
        <select id="importMode">
          <option value="replace">${t("settings.import.modeReplace")}</option>
          <option value="merge">${t("settings.import.modeMerge")}</option>
          <option value="add">${t("settings.import.modeAdd")}</option>
        </select>
      </div>
      <div class="section">
        <textarea id="importText" placeholder="${t("settings.import.placeholder")}"></textarea>
      </div>
      <div class="actions">
        <button id="btnCancel" class="icon-btn">${t("common.cancel")}</button>
        <button id="btnImportNow" class="icon-btn">${t("settings.import.submit")}</button>
      </div>
    `;
    openModal(modalHtml);
    $("btnCancel").addEventListener("click", closeModal);
    $("btnImportNow").addEventListener("click", async () => {
      try {
        const incoming = JSON.parse($("importText").value.trim());
        const mode = $("importMode").value;
        if (!incoming || typeof incoming !== "object") throw new Error(t("settings.import.invalidFormat"));
        // 运行时 schema 校验：修复非法字段、清理悬空引用、合并默认 settings
        const repairedIncoming = repairHomepageData(incoming, defaultSettings());
        if (!repairedIncoming.schemaVersion) throw new Error(t("settings.import.missingSchema"));
        const deviceId = mode === "merge" ? await getOrCreateDeviceId() : "";
        await commitImport(() => {
          pushBackup();
          if (mode === "replace") {
            setData(repairedIncoming);
            resetSettingsClockBaseline?.(getData());
            resetPlacementClockBaseline?.(getData());
          } else if (mode === "merge") {
            const incomingDoc = toSyncDocument(repairedIncoming, {
              deviceId: `import_${deviceId}`,
              docId: repairedIncoming?._syncMeta?.docId || createDocId(),
              revision: Number(repairedIncoming?._syncMeta?.revision || 1),
              writtenAt: Number(repairedIncoming.lastUpdated || Date.now()),
            });
            const merged = mergeHomepage(getData(), incomingDoc, { deviceId, now: Date.now() });
            if (!merged.ok) throw new Error(merged.reason || t("settings.import.mergeFail"));
            if (repairedIncoming?.settings?.backgroundCustom && !merged.state.settings?.backgroundCustom) {
              merged.state.settings.backgroundCustom = repairedIncoming.settings.backgroundCustom;
            }
            setData(merged.state);
            resetSettingsClockBaseline?.(getData());
            resetPlacementClockBaseline?.(getData());
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
        });
        closeModal();
        render();
        processPendingIconFetches();
        toast(t("settings.import.ok"), "success");
      } catch (err) {
        toast(t("settings.import.fail", { reason: err.message || err }), "error");
      }
    });

    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        $("importText").value = text;
        toast(t("settings.import.clipboardRead"), "success");
      } else {
        toast(t("settings.import.clipboardEmpty"), "warning");
      }
    } catch (err) {
      toast(
        t("settings.import.clipboardFail", { reason: err.message || t("settings.import.clipboardNoPerm") }),
        "error",
      );
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
      <h2>${t("settings.importUrl.title")}</h2>
      <div class="section">
        <label>${t("common.selectGroup")}</label>
        <select id="importUrlGroup">${options}</select>
      </div>
      <div class="section">
        <div class="row-inline">
          <button id="btnImportUrlHttp" class="icon-btn">${t("settings.importUrl.http")}</button>
          <button id="btnImportUrlHttps" class="icon-btn">${t("settings.importUrl.https")}</button>
          <button id="btnImportUrlCancel" class="icon-btn">${t("common.cancel")}</button>
        </div>
      </div>
      <div class="section">
        <textarea id="importUrlText" placeholder="${t("settings.importUrl.placeholder")}"></textarea>
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
      try {
        await commitImport(() => {
          const targetGroup = getRootContainerById(groupId);
          const targetList = getPlacementList(targetGroup);
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
          setPlacementList(targetGroup, targetList);
          touchPlacementContainer(targetGroup);
          getData().settings.lastActiveGroupId = targetGroup.id;
        });
      } catch (error) {
        toast(t("settings.importUrl.fail", { reason: error.message || error }), "error");
        return;
      }
      closeWithCleanup();
      render();
      processPendingIconFetches();
      toast(
        invalid
          ? t("settings.importUrl.partial", { count: urls.length, ignored: invalid })
          : t("settings.importUrl.done", { count: urls.length }),
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
            html`<div class="row" data-backup="${b.id}"><div>${new Date(b.ts).toLocaleString()}</div><div class="row-actions"><button class="icon-btn backup-restore">${t("settings.backup.restore")}</button><button class="icon-btn backup-delete">${t("common.delete")}</button></div></div>`,
        )
        .join(""),
    );
    const modalHtml = html`
      <h2>${t("settings.backup.title")}</h2>
      <div class="section">${getData().backups.length ? list : t("settings.backup.empty")}</div>
      <div class="actions"><button id="btnClose" class="icon-btn">${t("common.close")}</button></div>
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
        try {
          await commitImport(() => {
            setData(restoredData);
            // 恢复已有快照不应再生成一份内容重复的自动备份。
            syncBackupBaseline?.(restoredData);
            resetSettingsClockBaseline?.(restoredData);
            resetPlacementClockBaseline?.(restoredData);
          });
        } catch (error) {
          toast(t("settings.backup.restoreFail", { reason: error.message || error }), "error");
          return;
        }
        closeModal();
        render();
        toast(t("settings.backup.restoreOk"), "success");
      });
    });
    qsa(".backup-delete", elements.modal).forEach((btn) => {
      btn.addEventListener("click", async () => {
        const row = btn.closest("[data-backup]");
        if (!row) return;
        const id = row.dataset.backup;
        if (!id) return;
        try {
          await commitImport(() => {
            getData().backups = (getData().backups || []).filter((b) => b.id !== id);
            syncBackupBaseline?.(getData());
          });
        } catch (error) {
          toast(t("settings.backup.deleteFail", { reason: error.message || error }), "error");
          return;
        }
        openBackupModal();
        toast(t("settings.backup.deleteOk"), "success");
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
          await commitImport(() => {
            pushBackup();
            setData(result.state);
            if (!getData().settings) getData().settings = {};
            resetSettingsClockBaseline(getData());
            resetPlacementClockBaseline(getData());
            // 保持用户当前同步开关
          });
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
          await commitImport(() => {
            pushBackup();
            setData(result.state);
            if (!getData().settings) getData().settings = {};
            resetSettingsClockBaseline(getData());
            resetPlacementClockBaseline(getData());
          });
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
    $("btnDedupeBookmarks")?.addEventListener("click", () => {
      openDedupeBookmarksModal();
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
          await commitImport(() => {
            pushBackup();
            // 在副本里追加，失败时不把书签或备份留在运行态。
            mergeRootBookmarkData(getData(), incoming);
          });
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

  function openDedupeBookmarksModal() {
    if (typeof findDuplicateBookmarkGroups !== "function" || typeof mergeDuplicateBookmarks !== "function") return;
    const scan = findDuplicateBookmarkGroups(getData());
    if (!scan.totalDuplicateCount) {
      toast(t("settings.dedupe.none"));
      return;
    }
    void leaveSettingsForSubpanel();
    const previewRows = rawHtml(
      scan.groups
        .slice(0, 50)
        .map(
          (entry) =>
            html`<div class="row" style="flex-direction:column;align-items:flex-start;gap:2px"><div><strong>${entry.keep.title || entry.keep.url}</strong> (${t("settings.dedupe.groupCount", { total: entry.duplicates.length + 1 })})</div><div class="hint" style="margin:0;word-break:break-all">${entry.canonicalUrl}</div></div>`,
        )
        .join(""),
    );
    const modalHtml = html`
      <h2>${t("settings.dedupe.title")}</h2>
      <p class="hint">${t("settings.dedupe.summary", { groups: scan.groups.length, duplicates: scan.totalDuplicateCount })}</p>
      <div class="section" style="max-height:280px;overflow:auto">${previewRows}</div>
      <div class="actions">
        <button id="btnDedupeCancel" class="icon-btn">${t("common.cancel")}</button>
        <button id="btnDedupeConfirm" class="icon-btn primary">${t("settings.dedupe.confirm", { count: scan.totalDuplicateCount })}</button>
      </div>
    `;
    openModal(modalHtml);
    $("btnDedupeCancel").addEventListener("click", closeModal);
    $("btnDedupeConfirm").addEventListener("click", async () => {
      await runWithButtonState($("btnDedupeConfirm"), t("settings.dedupe.running"), async () => {
        try {
          let merged = { mergedGroups: 0, removedCount: 0 };
          await commitImport(() => {
            pushBackup();
            merged = mergeDuplicateBookmarks(getData(), {
              removeNodeFromLocation,
              touchPlacementContainer,
              markNodeDeleted,
              stampNodeFieldChanges,
            });
          });
          closeModal();
          render();
          toast(t("settings.dedupe.done", { removed: merged.removedCount }));
          void refreshSyncStatusLine();
        } catch (error) {
          toast(t("settings.dedupe.fail", { reason: error?.message || error }), "error");
        }
      });
    });
  }

  return {
    bindButtons,
    exportJsonToClipboard,
    openImportModal,
    openImportUrlModal,
    openBackupModal,
    downloadJsonFile,
    openDedupeBookmarksModal,
  };
}
