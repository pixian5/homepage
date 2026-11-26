/**
 * 首页批量移动弹窗与命令面板动作构建器（从 app.js 拆出）。
 *
 * 用 IIFE 包裹：Firefox 拼接经典脚本时不污染全局作用域。
 */
import { collectNodeSubtreeIds, isAllBookmarksGroup } from "./data-utils.js";

var HomepageAppActions = (() => {
  /**
   * 收集可作为批量移动目标的根目录与文件夹列表，自动排除选中节点自身及其子孙文件夹防成环。
   */
  function collectBatchMoveTargets({ data, selectedIds, getRootGroup, t }) {
    const blocked = new Set();
    for (const id of selectedIds || []) {
      for (const subId of collectNodeSubtreeIds(data, id)) blocked.add(subId);
    }
    const targets = [];
    const root = getRootGroup();
    if (root) {
      targets.push({ id: root.id, label: t("batchMove.rootContainer"), depth: 0 });
    }
    const walkFolder = (folderId, depth) => {
      const folder = data?.nodes?.[folderId];
      if (folder?.type !== "folder" || folder.deletedAt || folder.purgedAt) return;
      if (!blocked.has(folder.id)) {
        targets.push({ id: folder.id, label: folder.title || t("folder.defaultTitle"), depth });
      }
      for (const childId of folder.children || []) {
        walkFolder(childId, depth + 1);
      }
    };
    for (const group of data?.groups || []) {
      if (!group || (!isAllBookmarksGroup(group) && group.id !== root?.id)) {
        targets.push({ id: group.id, label: group.title || group.name || t("group.default"), depth: 0 });
      }
      for (const childId of group?.nodes || []) {
        walkFolder(childId, 1);
      }
    }
    return targets;
  }

  function showBatchMoveModal({
    ids,
    onMoved,
    data,
    getRootGroup,
    t,
    toast,
    html,
    rawHtml,
    openModal,
    closeModal,
    elements,
    $,
    qsa,
    moveNodesToContainer,
  }) {
    const targets = collectBatchMoveTargets({ data, selectedIds: ids, getRootGroup, t });
    if (!targets.length) {
      toast(t("batchMove.emptyTargets"), "warning");
      return;
    }
    const buttonsHtml = targets
      .map(
        (item) =>
          html`<button type="button" class="icon-btn batch-move-target" data-target-id="${item.id}" style="text-align:left;padding-left:${12 + item.depth * 18}px">${item.label}</button>`,
      )
      .join("");
    const modalHtml = html`
      <h2>${t("batchMove.title", { count: ids.length })}</h2>
      <div class="section" style="display:flex;flex-direction:column;gap:6px;max-height:320px;overflow:auto">${rawHtml(buttonsHtml)}</div>
      <div class="actions"><button id="btnBatchMoveCancel" class="icon-btn">${t("common.cancel")}</button></div>
    `;
    openModal(modalHtml);
    $("btnBatchMoveCancel")?.addEventListener("click", closeModal);
    qsa(".batch-move-target", elements.modal).forEach((btn) => {
      btn.addEventListener("click", async () => {
        const targetId = btn.dataset.targetId;
        const targetLabel = btn.textContent || "";
        const res = moveNodesToContainer(ids, targetId);
        await closeModal();
        if (res?.movedCount > 0) {
          onMoved?.();
          toast(t("batchMove.moved", { count: res.movedCount, target: targetLabel }));
        } else {
          toast(t("batchMove.noneMoved"), "warning");
        }
      });
    });
  }

  function buildCommandPaletteActions({
    t,
    openAddModal,
    openSettingsModal,
    getData,
    pullNow,
    clickDedupeButton,
    toggleTheme,
    toggleSidebar,
  }) {
    return [
      { id: "action:add", title: t("cmdk.action.add"), keywords: "add new bookmark", run: () => openAddModal() },
      {
        id: "action:settings",
        title: t("cmdk.action.settings"),
        keywords: "settings preferences",
        run: () => openSettingsModal(),
      },
      {
        id: "action:sync",
        title: t("cmdk.action.sync"),
        keywords: "sync push pull",
        run: () => {
          if (getData()?.settings?.syncEnabled) void pullNow("manual");
          else openSettingsModal();
        },
      },
      {
        id: "action:dedupe",
        title: t("settings.action.dedupeBookmarks"),
        keywords: "dedupe duplicate clean",
        run: () => {
          openSettingsModal();
          clickDedupeButton();
        },
      },
      {
        id: "action:theme",
        title: t("cmdk.action.toggleTheme"),
        keywords: "theme dark light",
        run: () => toggleTheme(),
      },
      {
        id: "action:sidebar",
        title: t("cmdk.action.toggleSidebar"),
        keywords: "sidebar toggle collapse",
        run: () => toggleSidebar(),
      },
    ];
  }

  return {
    collectBatchMoveTargets,
    showBatchMoveModal,
    buildCommandPaletteActions,
  };
})();

export const collectBatchMoveTargets = HomepageAppActions.collectBatchMoveTargets;
export const showBatchMoveModal = HomepageAppActions.showBatchMoveModal;
export const buildCommandPaletteActions = HomepageAppActions.buildCommandPaletteActions;
