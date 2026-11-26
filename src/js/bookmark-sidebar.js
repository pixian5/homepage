/* 网页侧栏：只消费扩展传入的本程序数据，不访问浏览器 bookmarks API。 */
(() => {
  if (window.__homepageBookmarkSidebarInstalled) return;
  window.__homepageBookmarkSidebarInstalled = true;
  const ROOT_ID = "homepage-bookmark-sidebar-root";
  const STYLE_ID = "homepage-bookmark-sidebar-style";
  const ALL_GROUP_ID = "grp_all";
  const api = globalThis.browser || globalThis.chrome;

  const SIDEBAR_I18N = {
    "zh-CN": {
      allBookmarks: "所有书签",
      close: "关闭",
      addBookmark: "添加书签",
      noBookmarks: "暂无书签",
      unnamed: "未命名",
      defaultGroup: "默认",
      saved: "已保存",
      saveFailed: "保存失败",
    },
    "zh-TW": {
      allBookmarks: "所有書籤",
      close: "關閉",
      addBookmark: "新增書籤",
      noBookmarks: "暫無書籤",
      unnamed: "未命名",
      defaultGroup: "預設",
      saved: "已儲存",
      saveFailed: "儲存失敗",
    },
    en: {
      allBookmarks: "All Bookmarks",
      close: "Close",
      addBookmark: "Add Bookmark",
      noBookmarks: "No bookmarks",
      unnamed: "Unnamed",
      defaultGroup: "Default",
      saved: "Saved",
      saveFailed: "Save failed",
    },
    ja: {
      allBookmarks: "すべてのブックマーク",
      close: "閉じる",
      addBookmark: "ブックマークを追加",
      noBookmarks: "ブックマークはありません",
      unnamed: "名称未設定",
      defaultGroup: "デフォルト",
      saved: "保存しました",
      saveFailed: "保存に失敗しました",
    },
    ko: {
      allBookmarks: "모든 북마크",
      close: "닫기",
      addBookmark: "북마크 추가",
      noBookmarks: "북마크 없음",
      unnamed: "이름 없음",
      defaultGroup: "기본",
      saved: "저장됨",
      saveFailed: "저장 실패",
    },
    de: {
      allBookmarks: "Alle Lesezeichen",
      close: "Schliessen",
      addBookmark: "Lesezeichen hinzufugen",
      noBookmarks: "Keine Lesezeichen",
      unnamed: "Unbenannt",
      defaultGroup: "Standard",
      saved: "Gespeichert",
      saveFailed: "Speichern fehlgeschlagen",
    },
    fr: {
      allBookmarks: "Tous les favoris",
      close: "Fermer",
      addBookmark: "Ajouter un favori",
      noBookmarks: "Aucun favori",
      unnamed: "Sans nom",
      defaultGroup: "Par defaut",
      saved: "Enregistre",
      saveFailed: "Echec de l'enregistrement",
    },
    es: {
      allBookmarks: "Todos los marcadores",
      close: "Cerrar",
      addBookmark: "Agregar marcador",
      noBookmarks: "Sin marcadores",
      unnamed: "Sin nombre",
      defaultGroup: "Predeterminado",
      saved: "Guardado",
      saveFailed: "Error al guardar",
    },
  };
  const resolveLang = (raw) => {
    const code = String(raw || "")
      .trim()
      .replace(/_/g, "-")
      .toLowerCase();
    if (!code || code === "zh" || code.startsWith("zh-hans") || code.startsWith("zh-cn") || code.startsWith("zh-sg"))
      return "zh-CN";
    if (code.startsWith("zh-hant") || code.startsWith("zh-tw") || code.startsWith("zh-hk") || code.startsWith("zh-mo"))
      return "zh-TW";
    for (const prefix of ["ja", "ko", "de", "fr", "es", "en"]) {
      if (code.startsWith(prefix)) return prefix;
    }
    return "en";
  };
  const sbText = (lang, key) => SIDEBAR_I18N[lang]?.[key] || SIDEBAR_I18N.en[key] || key;

  const label = (node, lang) =>
    String(node?.title || node?.url || sbText(lang, "unnamed")).trim() || sbText(lang, "unnamed");
  const walk = (data, lang) => {
    const folders = [];
    const items = [];
    const groups = Array.isArray(data?.groups) ? data.groups : [];
    const seen = new Set();
    const visit = (id, groupId, path, folderIds, depth, parentId) => {
      if (!id || seen.has(`${groupId}:${id}`)) return;
      const node = data?.nodes?.[id];
      if (!node || node.deletedAt || node.purgedAt) return;
      seen.add(`${groupId}:${id}`);
      if (node.type === "item") {
        items.push({
          id: node.id || id,
          title: label(node, lang),
          url: String(node.url || ""),
          path,
          folderIds,
          groupId,
          iconType: String(node.iconType || "auto"),
          iconData: String(node.iconData || ""),
          color: String(node.color || ""),
        });
        return;
      }
      if (node.type !== "folder") return;
      const folderId = node.id || id;
      const nextPath = [...path, label(node, lang)];
      const nextFolderIds = [...folderIds, folderId];
      folders.push({ id: folderId, title: label(node, lang), path: nextPath, depth, groupId, parentId });
      for (const child of Array.isArray(node.children) ? node.children : []) {
        visit(child, groupId, nextPath, nextFolderIds, depth + 1, folderId);
      }
    };
    const allGroup = groups.find((group) => group?.id === ALL_GROUP_ID);
    if (allGroup) {
      const allName = String(allGroup.name || sbText(lang, "allBookmarks"));
      folders.push({
        id: allGroup.id,
        title: allName,
        path: [allName],
        depth: 0,
        groupId: allGroup.id,
        parentId: "",
        group: true,
      });
      for (const id of Array.isArray(allGroup.nodes) ? allGroup.nodes : []) {
        visit(id, allGroup.id, [allName], [allGroup.id], 1, allGroup.id);
      }
    } else {
      for (const group of groups) {
        if (!group?.id) continue;
        const groupName = String(group.name || sbText(lang, "defaultGroup"));
        folders.push({
          id: group.id,
          title: groupName,
          path: [groupName],
          depth: 0,
          groupId: group.id,
          parentId: "",
          group: true,
        });
        for (const id of Array.isArray(group.nodes) ? group.nodes : []) {
          visit(id, group.id, [groupName], [group.id], 1, group.id);
        }
      }
    }
    return { folders, items };
  };

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${ROOT_ID}{position:fixed;inset:0;z-index:2147483646;pointer-events:none;font:13px -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans SC",sans-serif;color:#e7eef8}
      #${ROOT_ID} *{box-sizing:border-box}
      #${ROOT_ID} .hp-side{position:fixed;top:48px;width:min(310px,88vw);height:min(760px,calc(100vh - 96px));padding:8px;background:#141b26f7;border:1px solid #ffffff20;border-radius:8px;box-shadow:0 12px 36px #0007;pointer-events:auto;display:none;flex-direction:column;gap:6px;overflow:visible}
      #${ROOT_ID} .hp-side.hp-open{display:flex}
      #${ROOT_ID} .hp-left{left:38px}#${ROOT_ID} .hp-right{right:38px}
      #${ROOT_ID} .hp-head{display:flex;align-items:center;justify-content:space-between;gap:8px;font-weight:700;color:#fff;font-size:14px}
      #${ROOT_ID} .hp-close{width:26px;height:26px;border:1px solid #ffffff25;border-radius:6px;background:transparent;color:#b8c5d4;font-size:19px;line-height:1;cursor:pointer}
      #${ROOT_ID} .hp-list{overflow:auto;display:grid;gap:2px;min-height:120px;flex:1}
      #${ROOT_ID} .hp-item,#${ROOT_ID} .hp-folder{width:100%;border:1px solid transparent;border-radius:6px;background:transparent;color:inherit;padding:7px;text-align:left;cursor:pointer;font:inherit}
      #${ROOT_ID} .hp-item{display:grid;grid-template-columns:26px minmax(0,1fr);align-items:center;gap:8px}
      #${ROOT_ID} .hp-item:hover,#${ROOT_ID} .hp-folder:hover{background:#ffffff12;border-color:#ffffff25}
      #${ROOT_ID} .hp-title,#${ROOT_ID} .hp-url,#${ROOT_ID} .hp-path{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      #${ROOT_ID} .hp-title{font-weight:600}.hp-url,#${ROOT_ID} .hp-path,#${ROOT_ID} .hp-empty{color:#9fb0c4;font-size:11px}
      #${ROOT_ID} .hp-logo-wrap{position:relative;width:24px;height:24px;display:block}
      #${ROOT_ID} .hp-logo{position:absolute;inset:0;width:24px;height:24px;border-radius:5px;object-fit:contain;background:#fff;display:block}
      #${ROOT_ID} .hp-logo-letter{position:absolute;inset:0;width:24px;height:24px;border-radius:5px;display:grid;place-items:center;color:#fff;font-weight:700;font-size:12px}
      #${ROOT_ID} .hp-item-copy{min-width:0;display:block}
      #${ROOT_ID} .hp-folders{border-top:1px solid #ffffff20;padding-top:6px;flex-shrink:0;overflow:visible;display:grid;gap:2px}
      #${ROOT_ID} .hp-menu-parent{position:relative}
      #${ROOT_ID} .hp-folder,#${ROOT_ID} .hp-add{width:100%;padding:7px 9px;color:#cdd8e5;border:1px solid transparent;border-radius:5px;background:transparent;text-align:left;cursor:pointer;font:inherit;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      #${ROOT_ID} .hp-menu-parent.hp-has-children>.hp-folder::after,#${ROOT_ID} .hp-add::after{content:'›';float:right;color:#9fb0c4;font-size:18px;line-height:13px}
      #${ROOT_ID} .hp-folder:hover,#${ROOT_ID} .hp-add:hover{background:#ffffff14;border-color:#ffffff20}
      #${ROOT_ID} .hp-submenu{display:none;position:absolute;top:-7px;left:100%;width:280px;padding:6px;background:#141b26fc;border:1px solid #ffffff20;border-radius:8px;box-shadow:0 12px 36px #0008;overflow:visible}
      #${ROOT_ID} .hp-right .hp-submenu{left:auto;right:100%}
      #${ROOT_ID} .hp-menu-parent:hover>.hp-submenu,#${ROOT_ID} .hp-menu-parent.hp-force-open>.hp-submenu{display:block}
      #${ROOT_ID} .hp-status{font-size:12px;padding:6px 8px;border-radius:6px;line-height:1.3}
      #${ROOT_ID} .hp-status-ok{background:#168048eb;color:#fff}
      #${ROOT_ID} .hp-status-err{background:#a52828eb;color:#fff}
      #${ROOT_ID} .hp-hidden{display:none}
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  let activeKeydownHandler = null;
  function detachKeydown() {
    if (activeKeydownHandler && typeof document?.removeEventListener === "function") {
      document.removeEventListener("keydown", activeKeydownHandler);
    }
    activeKeydownHandler = null;
  }

  function closeSidebarRoot() {
    document.getElementById(ROOT_ID)?.remove();
    detachKeydown();
  }

  function sendRuntimeMessage(payload) {
    const sendMessage = api?.runtime?.sendMessage;
    if (typeof sendMessage !== "function") return Promise.resolve({ ok: false, error: "no_runtime" });
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value || { ok: false });
      };
      try {
        const result = sendMessage.call(api.runtime, payload, (res) => {
          if (api.runtime?.lastError) return finish({ ok: false, error: api.runtime.lastError.message });
          finish(res || { ok: false });
        });
        if (typeof result?.then === "function") {
          result.then(
            (res) => finish(res || { ok: false }),
            (err) => finish({ ok: false, error: err?.message || String(err) }),
          );
        }
      } catch (_firstErr) {
        try {
          const retry = sendMessage.call(api.runtime, payload);
          if (typeof retry?.then === "function") {
            retry.then(
              (res) => finish(res || { ok: false }),
              (err) => finish({ ok: false, error: err?.message || String(err) }),
            );
          } else {
            finish(retry || { ok: false });
          }
        } catch (err) {
          finish({ ok: false, error: err?.message || String(err) });
        }
      }
    });
  }

  function sendOpen(url, settings) {
    void sendRuntimeMessage({ type: "homepage_open_bookmark", url, settings });
  }

  function isThirdPartyServiceUrl(raw) {
    try {
      const parsed = new URL(raw);
      const host = parsed.hostname.toLowerCase();
      const pathname = parsed.pathname || "/";
      if (host === "icons.duckduckgo.com") return true;
      if (host === "www.google.com" && pathname.startsWith("/s2/favicons")) return true;
      if (/^t\d+\.gstatic\.com$/i.test(host) && pathname.startsWith("/faviconV2")) return true;
      return false;
    } catch {
      return false;
    }
  }

  function logoCandidates(item, allowThirdPartyFallback = true) {
    const candidates = [];
    if (item.iconType === "upload" && /^data:image\//i.test(item.iconData)) candidates.push(item.iconData);
    if (
      item.iconType === "remote" &&
      /^https?:\/\//i.test(item.iconData) &&
      (allowThirdPartyFallback || !isThirdPartyServiceUrl(item.iconData))
    ) {
      candidates.push(item.iconData);
    }
    try {
      const parsed = new URL(item.url);
      if (/^https?:$/.test(parsed.protocol)) {
        candidates.push(`${parsed.origin}/favicon.ico`);
        if (allowThirdPartyFallback) {
          candidates.push(`https://www.google.com/s2/favicons?sz=64&domain_url=${encodeURIComponent(parsed.origin)}`);
          candidates.push(`https://icons.duckduckgo.com/ip3/${parsed.hostname}.ico`);
        }
      }
    } catch (_) {}
    return [...new Set(candidates)];
  }

  function hashColor(text) {
    let hash = 0;
    for (const char of String(text || "")) hash = char.charCodeAt(0) + ((hash << 5) - hash);
    return `hsl(${Math.abs(hash) % 360} 55% 42%)`;
  }

  function makeLogo(item, allowThirdPartyFallback = true) {
    const wrap = document.createElement("span");
    wrap.className = "hp-logo-wrap";
    const letter = document.createElement("span");
    letter.className = "hp-logo-letter";
    letter.textContent =
      String(item.title || item.url || "?")
        .trim()
        .slice(0, 1)
        .toUpperCase() || "?";
    letter.style.background = item.color || hashColor(item.title || item.url);
    wrap.appendChild(letter);
    if (item.iconType === "color") return wrap;
    const candidates = logoCandidates(item, allowThirdPartyFallback);
    if (!candidates.length) return wrap;
    const image = document.createElement("img");
    image.className = "hp-logo";
    image.alt = "";
    let index = 0;
    image.addEventListener("load", () => letter.remove());
    image.addEventListener("error", () => {
      index += 1;
      if (index < candidates.length) image.src = candidates[index];
      else image.remove();
    });
    image.src = candidates[index];
    wrap.prepend(image);
    return wrap;
  }

  function render(data, openSide = null, openAdd = false) {
    ensureStyle();
    closeSidebarRoot();
    const lang = resolveLang(data?.settings?.language);
    const root = document.createElement("div");
    root.id = ROOT_ID;
    let { folders, items } = walk(data, lang);
    const appendFolderTree = (host, parentId, onSelect) => {
      for (const folder of folders.filter((entry) => entry.parentId === parentId)) {
        const row = document.createElement("div");
        row.className = "hp-menu-parent";
        const button = document.createElement("button");
        button.className = "hp-folder";
        button.textContent = folder.title;
        button.title = folder.path.join(" / ");
        button.addEventListener("click", (event) => {
          event.stopPropagation();
          onSelect(folder);
        });
        row.appendChild(button);
        if (folders.some((entry) => entry.parentId === folder.id)) {
          row.classList.add("hp-has-children");
          const submenu = document.createElement("div");
          submenu.className = "hp-submenu";
          appendFolderTree(submenu, folder.id, onSelect);
          row.appendChild(submenu);
        }
        host.appendChild(row);
      }
    };
    const makeSide = (side, closable) => {
      const panel = document.createElement("aside");
      panel.className = `hp-side hp-${side}`;
      const head = document.createElement("div");
      head.className = "hp-head";
      head.appendChild(Object.assign(document.createElement("span"), { textContent: sbText(lang, "allBookmarks") }));
      if (closable) {
        const close = document.createElement("button");
        close.className = "hp-close";
        close.textContent = "×";
        close.title = sbText(lang, "close");
        close.setAttribute("aria-label", sbText(lang, "close"));
        close.addEventListener("click", () => {
          panel.classList.remove("hp-open");
          panel.remove();
          if (!root.querySelector(".hp-side.hp-open")) closeSidebarRoot();
        });
        head.appendChild(close);
      }
      panel.appendChild(head);
      let statusTimer = null;
      let selectedFolderId = "";
      const statusEl = document.createElement("div");
      statusEl.className = "hp-status hp-hidden";
      statusEl.setAttribute("role", "status");
      const showStatus = (ok, message) => {
        if (statusTimer) clearTimeout(statusTimer);
        statusEl.textContent = message;
        statusEl.className = `hp-status ${ok ? "hp-status-ok" : "hp-status-err"}`;
        statusTimer = setTimeout(() => {
          statusEl.className = "hp-status hp-hidden";
          statusTimer = null;
        }, 2600);
      };
      const list = document.createElement("div");
      list.className = "hp-list";
      const fillList = (visibleItems) => {
        list.replaceChildren();
        if (!visibleItems.length) {
          list.appendChild(
            Object.assign(document.createElement("div"), {
              className: "hp-empty",
              textContent: sbText(lang, "noBookmarks"),
            }),
          );
          return;
        }
        for (const item of visibleItems) {
          const button = document.createElement("button");
          button.className = "hp-item";
          const copy = document.createElement("span");
          copy.className = "hp-item-copy";
          copy.innerHTML = `<span class="hp-title"></span><span class="hp-url"></span><span class="hp-path"></span>`;
          copy.querySelector(".hp-title").textContent = item.title;
          copy.querySelector(".hp-url").textContent = item.url;
          copy.querySelector(".hp-path").textContent = item.path.join(" / ");
          const allowThirdPartyFallback = data?.settings?.iconThirdPartyFallback !== false;
          button.append(makeLogo(item, allowThirdPartyFallback), copy);
          button.addEventListener("click", () => sendOpen(item.url, data?.settings || {}));
          list.appendChild(button);
        }
      };
      const appendSavedNode = (folderId, node) => {
        if (!node?.id) return;
        if (!data.nodes || typeof data.nodes !== "object") data.nodes = {};
        data.nodes[node.id] = node;
        const groups = Array.isArray(data.groups) ? data.groups : [];
        const target = groups.find((entry) => entry?.id === folderId) || data.nodes[folderId];
        if (target) {
          const targetList = Array.isArray(target.nodes)
            ? target.nodes
            : Array.isArray(target.children)
              ? target.children
              : (target.children = []);
          if (!targetList.includes(node.id)) targetList.push(node.id);
        }
        const refreshed = walk(data, lang);
        folders = refreshed.folders;
        items = refreshed.items;
        fillList(selectedFolderId ? items.filter((item) => item.folderIds.includes(selectedFolderId)) : items);
      };
      if (side === "left") {
        const addRow = document.createElement("div");
        addRow.className = `hp-menu-parent hp-has-children${openAdd ? " hp-force-open" : ""}`;
        const add = document.createElement("button");
        add.className = "hp-add";
        add.textContent = sbText(lang, "addBookmark");
        addRow.appendChild(add);
        const addFolders = document.createElement("div");
        addFolders.className = "hp-submenu";
        appendFolderTree(addFolders, "", async (folder) => {
          addRow.classList.remove("hp-force-open");
          const result = await sendRuntimeMessage({
            type: "homepage_add_bookmark_to_folder",
            folderId: folder.id,
          });
          if (result?.ok && result.node) appendSavedNode(result.folderId || folder.id, result.node);
          showStatus(!!result?.ok, sbText(lang, result?.ok ? "saved" : "saveFailed"));
        });
        addRow.appendChild(addFolders);
        panel.appendChild(addRow);
      }
      panel.appendChild(statusEl);
      fillList(items);
      panel.appendChild(list);
      const foldersBox = document.createElement("div");
      foldersBox.className = "hp-folders";
      appendFolderTree(foldersBox, "", (folder) => {
        selectedFolderId = folder.id;
        fillList(items.filter((item) => item.folderIds.includes(folder.id)));
      });
      panel.appendChild(foldersBox);
      if (openSide === side) panel.classList.add("hp-open");
      return panel;
    };
    const activeSide = openSide === "right" ? "right" : "left";
    root.append(makeSide(activeSide, true));
    document.documentElement.appendChild(root);
    if (typeof document?.addEventListener === "function") {
      activeKeydownHandler = (event) => {
        if (event?.key === "Escape") closeSidebarRoot();
      };
      document.addEventListener("keydown", activeKeydownHandler);
    }
  }

  api?.runtime?.onMessage?.addListener?.((message, _sender, sendResponse) => {
    if (message?.type === "homepage_open_bookmark_sidebar") render(message.data || {}, message.side || "left");
    else if (message?.type === "homepage_open_add_bookmark_panel") render(message.data || {}, "left", true);
    else return false;
    sendResponse?.({ ok: true });
    return true;
  });
})();
