/**
 * 模态对话框管理器 (Modal Manager)
 * 负责通用模态框渲染、Enter快捷保存、添加/编辑卡片表单以及生命周期管理
 */

import { createItemNode, stampNodeFieldChanges } from "./data-utils.js";
import { getChromeApi, normalizeUrl, RECENT_GROUP_ID } from "./shared-utils.js";
import { deepClone } from "./storage.js";
import { html, rawHtml } from "./ui-utils.js";

/**
 * 解析并导入安全 HTML 到 DocumentFragment
 * @param {string} htmlString
 * @returns {DocumentFragment}
 */
export function parseModalHtml(htmlString) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(`<div id="modal-root">${htmlString}</div>`, "text/html");
  const root = doc.getElementById("modal-root");
  const fragment = document.createDocumentFragment();
  if (!root) return fragment;
  fragment.append(...Array.from(root.childNodes).map((node) => document.importNode(node, true)));
  return fragment;
}

/**
 * 寻找模态弹窗内当前应触发的默认主操作按钮
 * @param {HTMLElement} modal
 * @returns {HTMLButtonElement | null}
 */
export function findModalDefaultActionButton(modal) {
  const preferredIds = ["btnSave", "btnImportNow", "btnAddHistorySave", "btnImportUrlHttps", "btnCopy", "btnClose"];
  for (const id of preferredIds) {
    const btn = modal.querySelector?.(`#${id}`);
    if (btn && !btn.disabled && btn.offsetParent !== null) return btn;
  }
  // 设置面板改完即存，且 actions 末钮是「刷新图标」——禁止 Enter 误触
  if (modal.querySelector?.(".settings-actions") && !modal.querySelector?.("#btnSave")) {
    return null;
  }
  // 其它有 .actions 的面板：取最后一个非 danger 按钮
  const actions = modal.querySelector?.(".actions");
  if (actions) {
    const buttons = [...actions.querySelectorAll("button.icon-btn, button")].filter(
      (b) => !b.disabled && !b.classList.contains("danger"),
    );
    if (buttons.length) return buttons[buttons.length - 1];
  }
  return null;
}

/**
 * 弹窗内 Enter → 点击默认主按钮。
 * @param {HTMLElement} modal
 */
export function bindModalEnterToDefaultAction(modal) {
  if (!modal) return;
  if (modal._enterHandler) {
    modal.removeEventListener("keydown", modal._enterHandler);
  }
  const handler = (e) => {
    if (e.key !== "Enter") return;
    if (e.isComposing || e.keyCode === 229) return; // IME 组字中不触发
    if (e.altKey || e.ctrlKey || e.metaKey) return;

    const target = e.target;
    if (!(target instanceof Element)) return;

    // 搜索框：保持原搜索行为
    if (target.id === "topSearch" || target.closest?.("#topSearchWrap")) return;

    // 多行文本：Enter 换行
    const tag = (target.tagName || "").toLowerCase();
    if (tag === "textarea") return;

    // contenteditable
    if (target.isContentEditable) return;

    const defaultBtn = findModalDefaultActionButton(modal);
    if (!defaultBtn || defaultBtn.disabled) return;

    e.preventDefault();
    e.stopPropagation();
    defaultBtn.click();
  };
  modal._enterHandler = handler;
  modal.addEventListener("keydown", handler);
}

/**
 * 创建模态框管理器实例
 * @param {object} options
 */
export function createModalManager(options) {
  const {
    modalEl,
    modalOverlayEl,
    btnSettingsEl,
    t,
    toast,
    getState,
    readFileAsDataUrl,
    fetchTitleInBackground,
    fetchFaviconInBackground,
    fetchFaviconNow,
    clearIconCacheForUrl,
    pushBackup,
    persistData,
    render,
    debugLog,
    getContainerHelpers,
    onModalClose,
  } = options;

  function $(id) {
    return document.getElementById(id);
  }

  function openModal(htmlContent) {
    if (!modalEl || !modalOverlayEl) return;
    modalEl.replaceChildren(parseModalHtml(htmlContent));
    modalOverlayEl.removeAttribute("inert");
    modalOverlayEl.classList.remove("hidden");
    modalOverlayEl.setAttribute("aria-hidden", "false");
    bindModalEnterToDefaultAction(modalEl);
  }

  async function closeModal() {
    if (onModalClose) {
      await onModalClose();
    }
    const activeEl = document.activeElement;
    if (activeEl && modalOverlayEl?.contains(activeEl)) {
      btnSettingsEl?.focus?.({ preventScroll: true });
    }
    if (modalOverlayEl) {
      modalOverlayEl.setAttribute("inert", "");
      modalOverlayEl.classList.add("hidden");
      modalOverlayEl.setAttribute("aria-hidden", "true");
    }
    if (modalEl) {
      modalEl.replaceChildren();
    }
  }

  function openAddModal() {
    const modalHtml = html`
      <h2>${t("modal.add.title")}</h2>
      <div class="section">
        <label>${t("field.url")}</label>
        <input id="fieldUrl" type="url" placeholder="https://" />
      </div>
      <div class="section">
        <label>${t("field.title")}</label>
        <input id="fieldTitle" type="text" placeholder="${t("field.titleOptional")}" />
      </div>
      <div class="section">
        <label>${t("field.iconSource")}</label>
        <select id="fieldIconType">
          <option value="auto">${t("field.icon.auto")}</option>
          <option value="upload">${t("field.icon.upload")}</option>
          <option value="color">${t("field.icon.color")}</option>
          <option value="remote">${t("field.icon.remote")}</option>
        </select>
      </div>
      <div id="iconExtra" class="section"></div>
      <div class="section">
        <button id="btnFromTab" class="icon-btn">${t("field.fromTab")}</button>
      </div>
      <div class="actions">
        <button id="btnCancel" class="icon-btn">${t("common.cancel")}</button>
        <button id="btnSave" class="icon-btn">${t("common.save")}</button>
      </div>
    `;
    openModal(modalHtml);

    const iconTypeEl = $("fieldIconType");
    const iconExtra = $("iconExtra");
    if (!iconTypeEl || !iconExtra) {
      console.warn("openAddModal: required fields missing after render");
      return;
    }

    function renderIconExtra(type) {
      iconExtra.replaceChildren();
      if (type === "upload") {
        const label = document.createElement("label");
        label.textContent = t("field.uploadIcon");
        const input = document.createElement("input");
        input.id = "fieldUpload";
        input.type = "file";
        input.accept = "image/*";
        iconExtra.appendChild(label);
        iconExtra.appendChild(input);
      } else if (type === "color") {
        const label = document.createElement("label");
        label.textContent = t("field.colorAvatar");
        const input = document.createElement("input");
        input.id = "fieldColor";
        input.type = "color";
        input.value = "#4dd6a8";
        iconExtra.appendChild(label);
        iconExtra.appendChild(input);
      } else if (type === "remote") {
        const label = document.createElement("label");
        label.textContent = t("field.remoteIconUrl");
        const input = document.createElement("input");
        input.id = "fieldRemote";
        input.type = "url";
        input.placeholder = "https://";
        iconExtra.appendChild(label);
        iconExtra.appendChild(input);
      }
    }

    renderIconExtra(iconTypeEl.value);
    iconTypeEl.addEventListener("change", () => renderIconExtra(iconTypeEl.value));
    const urlInput = $("fieldUrl");
    if (urlInput) {
      urlInput.focus();
      if (urlInput.select) urlInput.select();
    }

    $("btnFromTab")?.addEventListener("click", async () => {
      const api = getChromeApi();
      if (!api?.tabs) return;
      api.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (api.runtime?.lastError) {
          toast(t("error.invalidUrl"), "error");
          return;
        }
        const tab = tabs?.[0];
        if (!tab) return;
        const fieldUrl = $("fieldUrl");
        const fieldTitle = $("fieldTitle");
        if (fieldUrl) fieldUrl.value = tab.url || "";
        if (fieldTitle) fieldTitle.value = tab.title || "";
      });
    });

    $("btnCancel")?.addEventListener("click", closeModal);
    $("btnSave")?.addEventListener("click", async () => {
      const state = getState();
      const snapshot = deepClone(state.data);
      const url = normalizeUrl(($("fieldUrl")?.value || "").trim());
      if (!url) {
        toast(t("error.invalidUrl"), "error");
        return;
      }
      let title = ($("fieldTitle")?.value || "").trim();
      const titlePending = !title;
      if (!title) title = new URL(url).hostname;
      let iconType = iconTypeEl.value;
      let iconData = "";
      let color = "";

      if (iconType === "upload") {
        const file = $("fieldUpload")?.files?.[0];
        if (file) {
          iconData = await readFileAsDataUrl(file);
        }
      } else if (iconType === "color") {
        color = $("fieldColor")?.value || "#4dd6a8";
      } else if (iconType === "remote") {
        iconData = ($("fieldRemote")?.value || "").trim();
      }

      const iconPending = iconType === "auto";
      if (iconType === "auto") {
        iconType = "letter";
      }

      pushBackup();
      const node = createItemNode({
        url,
        title,
        iconType,
        iconData,
        color,
        titlePending,
        iconPending,
      });
      state.data.nodes[node.id] = node;

      const helpers = getContainerHelpers();
      if (state.openFolderId) {
        const targetContainer = helpers.getFolderPlacementContainer(state.openFolderId);
        const targetList = helpers.getPlacementList(targetContainer);
        targetList.push(node.id);
        helpers.setPlacementList(targetContainer, targetList);
        helpers.touchPlacementContainer(targetContainer);
      } else {
        const targetGroup = helpers.getActiveGroup();
        const targetList = helpers.getPlacementList(targetGroup);
        targetList.push(node.id);
        helpers.setPlacementList(targetGroup, targetList);
        helpers.touchPlacementContainer(targetGroup);
        if (state.activeGroupId === RECENT_GROUP_ID) {
          state.activeGroupId = targetGroup.id;
        }
      }
      state.data.settings.lastActiveGroupId = helpers.getActiveGroup().id;
      debugLog("add_item", {
        id: node.id,
        url,
        groupId: state.openFolderId ? state.openFolderId : helpers.getActiveGroup().id,
        openFolderId: state.openFolderId || "",
      });

      const result = await persistData();
      if (!result.ok) {
        state.data = snapshot;
        render();
        toast(t("error.saveQuota"), "error");
        return;
      }
      render();
      closeModal();
      if (titlePending) fetchTitleInBackground(node.id, url);
      if (iconPending) fetchFaviconInBackground(node.id, url);

      if (result.warning === "local_trimmed_backups") {
        toast(t("toast.add.trimBackup"), "warning");
      } else if (result.warning === "local_trimmed_icons") {
        toast(t("toast.add.trimIcons"), "warning");
      } else if (result.warning === "local_trimmed_background") {
        toast(t("toast.add.trimBackground"), "warning");
      } else if (result.warning === "sync_quota_exceeded") {
        toast(t("toast.add.syncFallback"), "warning");
      } else if (result.warning === "sync_write_failed") {
        toast(t("toast.add.syncWriteFailed"), "warning");
      } else {
        toast(t("toast.add.success"));
      }
    });
  }

  function openEditModal(node) {
    const itemFields =
      node.type === "item"
        ? rawHtml(html`
            <div class="section">
              <label>${t("field.url")}</label>
              <input id="fieldUrl" type="url" value="${node.url || ""}" />
            </div>
            <div class="section">
              <label>${t("field.iconSource")}</label>
              <select id="fieldIconType">
                <option value="auto">${t("field.icon.auto")}</option>
                <option value="upload">${t("field.icon.upload")}</option>
                <option value="color">${t("field.icon.color")}</option>
                <option value="remote">${t("field.icon.remote")}</option>
              </select>
            </div>
            <div id="iconExtra" class="section"></div>
          `)
        : "";
    const fetchIconBtn =
      node.type === "item"
        ? rawHtml(html`
            <div class="actions-start">
              <button id="btnFetchIcon" type="button" class="icon-btn">${t("field.icon.fetchNow")}</button>
            </div>
          `)
        : "";
    const modalHtml = html`
      <h2>${t("modal.edit.title")}</h2>
      <div class="section">
        <label>${t("field.title")}</label>
        <input id="fieldTitle" type="text" value="${node.title || ""}" />
      </div>
      ${itemFields}
      <div class="actions">
        ${fetchIconBtn}
        <button id="btnCancel" class="icon-btn">${t("common.cancel")}</button>
        <button id="btnSave" class="icon-btn">${t("common.save")}</button>
      </div>
    `;
    openModal(modalHtml);

    if (node.type === "item") {
      const iconTypeEl = $("fieldIconType");
      if (!iconTypeEl) {
        console.warn("openEditModal: fieldIconType missing after render");
        return;
      }
      iconTypeEl.value = node.iconType === "letter" ? "auto" : node.iconType || "auto";
      const iconExtra = $("iconExtra");
      function renderIconExtra(type) {
        if (!iconExtra) return;
        iconExtra.replaceChildren();
        if (type === "upload") {
          const label = document.createElement("label");
          label.textContent = t("field.uploadIcon");
          const input = document.createElement("input");
          input.id = "fieldUpload";
          input.type = "file";
          input.accept = "image/*";
          iconExtra.appendChild(label);
          iconExtra.appendChild(input);
        } else if (type === "color") {
          const label = document.createElement("label");
          label.textContent = t("field.colorAvatar");
          const input = document.createElement("input");
          input.id = "fieldColor";
          input.type = "color";
          input.value = node.color || "#4dd6a8";
          iconExtra.appendChild(label);
          iconExtra.appendChild(input);
        } else if (type === "remote") {
          const label = document.createElement("label");
          label.textContent = t("field.remoteIconUrl");
          const input = document.createElement("input");
          input.id = "fieldRemote";
          input.type = "url";
          input.value = node.iconData || "";
          iconExtra.appendChild(label);
          iconExtra.appendChild(input);
        }
      }
      renderIconExtra(iconTypeEl.value);
      iconTypeEl.addEventListener("change", () => renderIconExtra(iconTypeEl.value));

      const btnFetchIcon = $("btnFetchIcon");
      btnFetchIcon?.addEventListener("click", async () => {
        if (!btnFetchIcon || btnFetchIcon.disabled) return;
        const url = normalizeUrl(($("fieldUrl")?.value || "").trim() || node.url || "");
        if (!url) {
          toast(t("error.invalidUrl"), "error");
          return;
        }
        const original = t("field.icon.fetchNow");
        btnFetchIcon.disabled = true;
        btnFetchIcon.textContent = t("field.icon.fetching");
        try {
          await clearIconCacheForUrl(url === node.url ? node.url : "", url);
          const ok = await fetchFaviconNow(node.id, url);
          if (ok) {
            if (iconTypeEl) iconTypeEl.value = "auto";
            renderIconExtra("auto");
            toast(t("field.icon.fetchOk"));
            if (url === node.url) {
              node.iconType = "auto";
              node.iconData = "";
              node.iconPending = false;
              render();
            }
          } else {
            toast(t("field.icon.fetchFail"), "warning");
          }
        } catch (e) {
          console.warn("btnFetchIcon failed", e);
          toast(t("field.icon.fetchFail"), "error");
        } finally {
          const live = $("btnFetchIcon");
          if (live) {
            live.disabled = false;
            live.textContent = original;
          }
        }
      });
    }

    $("btnCancel")?.addEventListener("click", closeModal);
    $("btnSave")?.addEventListener("click", async () => {
      const nextTitle = ($("fieldTitle")?.value || "").trim() || node.title;
      let nextUrl = node.url;
      if (node.type === "item") {
        nextUrl = normalizeUrl(($("fieldUrl")?.value || "").trim());
        if (!nextUrl) {
          toast(t("error.invalidUrl"), "error");
          return;
        }
      }

      const state = getState();
      const snapshot = deepClone(state.data);
      pushBackup();

      const oldUrl = node.url;
      const oldIconType = node.iconType;
      const titleChanged = node.title !== nextTitle;
      const urlChanged = node.type === "item" && oldUrl !== nextUrl;
      stampNodeFieldChanges(node, { titleChanged, urlChanged });

      node.title = nextTitle;
      if (node.type === "item") {
        const url = nextUrl;
        node.url = url;
        const iconType = $("fieldIconType")?.value || "auto";
        node.iconType = iconType;
        if (iconType === "upload") {
          const file = $("fieldUpload")?.files?.[0];
          if (file) node.iconData = await readFileAsDataUrl(file);
        } else if (iconType === "color") {
          node.color = $("fieldColor")?.value || node.color;
          node.iconData = "";
        } else if (iconType === "remote") {
          node.iconData = ($("fieldRemote")?.value || "").trim();
        } else {
          node.iconData = "";
        }

        const iconTypeChanged = oldIconType !== iconType;
        const shouldRefetchIcon = urlChanged || (iconTypeChanged && iconType === "auto");

        if (shouldRefetchIcon) {
          await clearIconCacheForUrl(oldUrl, url);
          if (iconType === "auto") {
            node.iconPending = true;
          }
        }
      }

      const result = await persistData();
      if (!result.ok) {
        state.data = snapshot;
        render();
        toast(t("error.saveQuota"), "error");
        return;
      }
      render();
      closeModal();
      if (node.type === "item" && node.iconPending) {
        fetchFaviconInBackground(node.id, node.url);
      }
      if (result.warning === "local_trimmed_backups") {
        toast(t("toast.save.trimBackup"), "warning");
      } else if (result.warning === "local_trimmed_icons") {
        toast(t("toast.save.trimIcons"), "warning");
      } else if (result.warning === "local_trimmed_background") {
        toast(t("toast.save.trimBackground"), "warning");
      } else if (result.warning === "sync_quota_exceeded") {
        toast(t("toast.save.syncFallback"), "warning");
      } else if (result.warning === "sync_write_failed") {
        toast(t("toast.save.syncWriteFailed"), "warning");
      } else {
        toast(t("toast.save.success"));
      }
    });
  }

  return {
    openModal,
    closeModal,
    openAddModal,
    openEditModal,
  };
}
