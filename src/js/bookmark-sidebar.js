/* 网页侧栏：只消费扩展传入的本程序数据，不访问浏览器 bookmarks API。 */
(() => {
  if (window.__homepageBookmarkSidebarInstalled) return;
  window.__homepageBookmarkSidebarInstalled = true;
  const ROOT_ID = "homepage-bookmark-sidebar-root";
  const STYLE_ID = "homepage-bookmark-sidebar-style";
  const api = globalThis.browser || globalThis.chrome;

  const label = (node) => String(node?.title || node?.url || "未命名").trim() || "未命名";
  const walk = (data) => {
    const folders = [];
    const items = [];
    const groups = Array.isArray(data?.groups) ? data.groups : [];
    const seen = new Set();
    const visit = (id, groupId, path, depth, parentId) => {
      if (!id || seen.has(`${groupId}:${id}`)) return;
      const node = data?.nodes?.[id];
      if (!node || node.deletedAt || node.purgedAt) return;
      seen.add(`${groupId}:${id}`);
      if (node.type === "item") {
        items.push({ id: node.id || id, title: label(node), url: String(node.url || ""), path, groupId });
        return;
      }
      if (node.type !== "folder") return;
      const nextPath = [...path, label(node)];
      folders.push({ id: node.id || id, title: label(node), path: nextPath, depth, groupId, parentId });
      for (const child of Array.isArray(node.children) ? node.children : [])
        visit(child, groupId, nextPath, depth + 1, node.id || id);
    };
    for (const group of groups) {
      if (!group?.id) continue;
      const groupName = String(group.name || "默认");
      folders.push({
        id: group.id,
        title: groupName,
        path: [groupName],
        depth: 0,
        groupId: group.id,
        parentId: "",
        group: true,
      });
      for (const id of Array.isArray(group.nodes) ? group.nodes : []) visit(id, group.id, [groupName], 1, group.id);
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
      #${ROOT_ID} .hp-item:hover,#${ROOT_ID} .hp-folder:hover{background:#ffffff12;border-color:#ffffff25}
      #${ROOT_ID} .hp-title,#${ROOT_ID} .hp-url,#${ROOT_ID} .hp-path{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      #${ROOT_ID} .hp-title{font-weight:600}.hp-url,#${ROOT_ID} .hp-path,#${ROOT_ID} .hp-empty{color:#9fb0c4;font-size:11px}
      #${ROOT_ID} .hp-folders{border-top:1px solid #ffffff20;padding-top:6px;max-height:220px;overflow:visible;display:grid;gap:2px}
      #${ROOT_ID} .hp-menu-parent{position:relative}
      #${ROOT_ID} .hp-folder,#${ROOT_ID} .hp-add{width:100%;padding:7px 9px;color:#cdd8e5;border:1px solid transparent;border-radius:5px;background:transparent;text-align:left;cursor:pointer;font:inherit;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      #${ROOT_ID} .hp-menu-parent.hp-has-children>.hp-folder::after,#${ROOT_ID} .hp-add::after{content:'›';float:right;color:#9fb0c4;font-size:18px;line-height:13px}
      #${ROOT_ID} .hp-folder:hover,#${ROOT_ID} .hp-add:hover{background:#ffffff14;border-color:#ffffff20}
      #${ROOT_ID} .hp-submenu{display:none;position:absolute;top:-7px;left:100%;width:280px;padding:6px;background:#141b26fc;border:1px solid #ffffff20;border-radius:8px;box-shadow:0 12px 36px #0008;overflow:visible}
      #${ROOT_ID} .hp-right .hp-submenu{left:auto;right:100%}
      #${ROOT_ID} .hp-menu-parent:hover>.hp-submenu,#${ROOT_ID} .hp-menu-parent.hp-force-open>.hp-submenu{display:block}
      #${ROOT_ID} .hp-hidden{display:none}
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function sendOpen(url, settings) {
    try {
      api?.runtime?.sendMessage?.({ type: "homepage_open_bookmark", url, settings });
    } catch (_) {
      /* 页面关闭时忽略 */
    }
  }

  function render(data, openSide = null, openAdd = false) {
    ensureStyle();
    document.getElementById(ROOT_ID)?.remove();
    const root = document.createElement("div");
    root.id = ROOT_ID;
    const { folders, items } = walk(data);
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
      head.appendChild(Object.assign(document.createElement("span"), { textContent: "所有书签" }));
      if (closable) {
        const close = document.createElement("button");
        close.className = "hp-close";
        close.textContent = "×";
        close.title = "关闭";
        close.addEventListener("click", () => panel.remove());
        head.appendChild(close);
      }
      panel.appendChild(head);
      if (side === "left") {
        const addRow = document.createElement("div");
        addRow.className = `hp-menu-parent hp-has-children${openAdd ? " hp-force-open" : ""}`;
        const add = document.createElement("button");
        add.className = "hp-add";
        add.textContent = "添加书签";
        addRow.appendChild(add);
        const addFolders = document.createElement("div");
        addFolders.className = "hp-submenu";
        appendFolderTree(addFolders, "", (folder) => {
          try {
            api?.runtime?.sendMessage?.({ type: "homepage_add_bookmark_to_folder", folderId: folder.id });
          } catch (_) {}
        });
        addRow.appendChild(addFolders);
        panel.appendChild(addRow);
      }
      const list = document.createElement("div");
      list.className = "hp-list";
      const fillList = (visibleItems) => {
        list.replaceChildren();
        if (!visibleItems.length) {
          list.appendChild(
            Object.assign(document.createElement("div"), { className: "hp-empty", textContent: "暂无书签" }),
          );
          return;
        }
        for (const item of visibleItems) {
          const button = document.createElement("button");
          button.className = "hp-item";
          button.innerHTML = `<span class="hp-title"></span><span class="hp-url"></span><span class="hp-path"></span>`;
          button.querySelector(".hp-title").textContent = item.title;
          button.querySelector(".hp-url").textContent = item.url;
          button.querySelector(".hp-path").textContent = item.path.join(" / ");
          button.addEventListener("click", () => sendOpen(item.url, data?.settings || {}));
          list.appendChild(button);
        }
      };
      fillList(items);
      panel.appendChild(list);
      const foldersBox = document.createElement("div");
      foldersBox.className = "hp-folders";
      appendFolderTree(foldersBox, "", (folder) => {
        const prefix = folder.path.join("\u0000");
        fillList(items.filter((item) => item.path.join("\u0000").startsWith(prefix)));
      });
      panel.appendChild(foldersBox);
      if (openSide === side) panel.classList.add("hp-open");
      return panel;
    };
    const leftPanel = makeSide("left", true);
    const rightPanel = makeSide("right", true);
    root.append(leftPanel, rightPanel);
    document.documentElement.appendChild(root);
  }

  api?.runtime?.onMessage?.addListener?.((message, _sender, sendResponse) => {
    if (message?.type === "homepage_open_bookmark_sidebar") render(message.data || {}, message.side || "left");
    else if (message?.type === "homepage_open_add_bookmark_panel") render(message.data || {}, "left", true);
    else return false;
    sendResponse?.({ ok: true });
    return true;
  });
})();
