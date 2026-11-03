/**
 * Netscape Bookmark File（标准书签 HTML）双向转换。
 *
 * 导出：本程序数据 → Chrome / Firefox / Safari / Edge 可直接导入的书签 HTML。
 * 导入：解析标准书签 HTML（容错：Netscape 历史遗留的不闭合 <DT>/<p>、未闭合 <H3>），
 *       转换为本程序数据形状，配合 data-utils.mergeRootBookmarkData 并入唯一根目录。
 *
 * 解析器不依赖 DOMParser：按行扫描的轻量状态机，浏览器与 Node 测试环境行为完全一致。
 */

import { ALL_BOOKMARKS_GROUP_ID, createItemNode } from "./data-utils.js";

/** ICON 属性长度上限：超长图标（异常数据）跳过，避免导出文件膨胀 */
const EXPORT_ICON_MAX_LENGTH = 32768;
/** 导入图标 data URI 长度上限：超出直接丢弃，防止同步体积失控 */
const IMPORT_ICON_MAX_LENGTH = 16384;

function escapeHtmlText(text) {
  return String(text ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeHtmlAttr(text) {
  return escapeHtmlText(text).replaceAll('"', "&quot;");
}

/** 毫秒时间戳 → Netscape 秒；非法/缺失返回空串（属性省略） */
function toBookmarkSeconds(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return "";
  return String(Math.floor(n / 1000));
}

/** Netscape 秒（或已带毫秒的值）→ 毫秒时间戳；非法返回 0 */
function fromBookmarkSeconds(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n < 1e12 ? Math.floor(n * 1000) : Math.floor(n);
}

function nodeTitle(node, fallback = "未命名") {
  return String(node?.title || "").trim() || fallback;
}

/** 导出用图标：仅接受 data: URI 形态的内嵌图标，超长跳过 */
function exportIconOf(node) {
  const icon = node?.iconType === "data" ? String(node?.iconData || "") : "";
  if (!icon.startsWith("data:") || icon.length > EXPORT_ICON_MAX_LENGTH) return "";
  return icon;
}

/**
 * 导出为标准 Netscape Bookmark HTML 字符串。
 * 唯一「全部」根分组时其子级直接置于顶层；旧多分组形态每个分组输出一层 <H3>。
 * 已标记 deletedAt / purgedAt 的节点与分组一律忽略。
 *
 * @param {object} data 主数据（groups / nodes）
 * @returns {string}
 */
export function exportNetscapeBookmarksHtml(data) {
  const groups = [...(data?.groups || [])]
    .filter((group) => group?.id)
    .sort(
      (left, right) =>
        Number(left?.order || 0) - Number(right?.order || 0) || String(left.id).localeCompare(String(right.id)),
    );
  const allGroup = groups.find((group) => group.id === ALL_BOOKMARKS_GROUP_ID);
  const lines = [
    "<!DOCTYPE NETSCAPE-Bookmark-file-1>",
    "<!-- This is an automatically generated file.",
    "     It will be read and overwritten.",
    "     DO NOT EDIT! -->",
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    "<TITLE>Bookmarks</TITLE>",
    "<H1>Bookmarks</H1>",
    "<DL><p>",
  ];
  const pad = (depth) => "    ".repeat(depth);

  const writeItem = (node, depth) => {
    const attrs = [`HREF="${escapeHtmlAttr(node.url)}"`];
    const addDate = toBookmarkSeconds(node.createdAt);
    if (addDate) attrs.push(`ADD_DATE="${addDate}"`);
    const icon = exportIconOf(node);
    if (icon) attrs.push(`ICON="${escapeHtmlAttr(icon)}"`);
    lines.push(`${pad(depth)}<DT><A ${attrs.join(" ")}>${escapeHtmlText(nodeTitle(node, node.url))}</A>`);
  };

  const writeFolder = (title, childIds, depth, createdAt, updatedAt, ancestors) => {
    const attrs = [];
    const addDate = toBookmarkSeconds(createdAt);
    const lastModified = toBookmarkSeconds(updatedAt);
    if (addDate) attrs.push(` ADD_DATE="${addDate}"`);
    if (lastModified) attrs.push(` LAST_MODIFIED="${lastModified}"`);
    lines.push(`${pad(depth)}<DT><H3${attrs.join("")}>${escapeHtmlText(title)}</H3>`);
    lines.push(`${pad(depth)}<DL><p>`);
    writeChildren(childIds, depth + 1, ancestors);
    lines.push(`${pad(depth)}</DL><p>`);
  };

  const writeChildren = (childIds, depth, ancestors) => {
    for (const id of Array.isArray(childIds) ? childIds : []) {
      const node = data?.nodes?.[id];
      if (!node || node.deletedAt || node.purgedAt) continue;
      if (node.type === "item") {
        if (node.url) writeItem(node, depth);
        continue;
      }
      if (node.type !== "folder") continue;
      if (ancestors.has(node.id)) continue; // 异常循环引用防御
      const next = new Set(ancestors);
      next.add(node.id);
      writeFolder(nodeTitle(node, "未命名文件夹"), node.children, depth, node.createdAt, node.updatedAt, next);
    }
  };

  if (allGroup) {
    writeChildren(allGroup.nodes, 1, new Set([allGroup.id]));
  } else {
    for (const group of groups) {
      // 旧多分组形态：分组的名字段是 name（不是节点的 title）
      writeFolder(
        String(group?.name || "").trim() || "默认",
        group.nodes,
        1,
        group.createdAt,
        group.updatedAt,
        new Set([group.id]),
      );
    }
  }
  lines.push("</DL><p>");
  return `${lines.join("\n")}\n`;
}

/** 去掉文本中残余的标签（容错解析用） */
function stripTags(text) {
  return String(text || "").replace(/<[^>]*>/g, "");
}

function safeCodePoint(code) {
  if (!Number.isInteger(code) || code < 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "�";
  return String.fromCodePoint(code);
}

/** HTML 实体解码：&amp; 最后处理，避免二次解码 */
function decodeHtmlEntities(text) {
  return String(text || "")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeCodePoint(Number.parseInt(dec, 10)))
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&");
}

/** 从标签属性串中读取属性值（大小写不敏感，支持单/双引号与裸值） */
function readTagAttr(attrText, name) {
  const match = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(String(attrText || ""));
  if (!match) return "";
  return match[1] ?? match[2] ?? match[3] ?? "";
}

/**
 * 解析 Netscape Bookmark HTML。
 * 按行扫描的状态机：<H3> 开文件夹（等待下一个 <DL> 进入层级）、<A HREF> 记书签、
 * <DL> 压栈、</DL> 弹栈；对不闭合的 <DT>/<p>、未闭合的 <H3>/<A> 具备最大容错。
 *
 * @param {string} htmlText 书签文件内容
 * @returns {{ groups: Array<{name: string, children: Array<object>}> }}
 *          顶层 <H3> → groups[i]；顶层散落书签归入 name 为空串的首个分组。
 */
export function parseNetscapeBookmarksHtml(htmlText) {
  const lines = String(htmlText || "").split(/\r?\n/);
  const root = { type: "folder", name: "", children: [] };
  const stack = [root];
  // 文件最外层的 <DL> 只是根容器本身，不构成文件夹层级；
  // 之后的每个 <DL> 才对应一个 <H3>（或匿名）文件夹。
  let enteredRoot = false;
  // <DT><H3 …>名称</H3> 之后等待 <DL> 才真正进入层级；损坏文件中孤儿 H3 会被丢弃
  let pendingFolder = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    // H3：优先匹配带闭合的完整形态，其次容错未闭合形态
    const h3 = /<h3\b([^>]*)>(.*?)<\/h3>/is.exec(line) || /<h3\b([^>]*)>(.+)$/is.exec(line);
    if (h3) {
      pendingFolder = {
        type: "folder",
        name: decodeHtmlEntities(stripTags(h3[2])).trim() || "未命名文件夹",
        children: [],
        addDate: readTagAttr(h3[1], "ADD_DATE"),
      };
      continue;
    }

    // A：书签（未闭合 </A> 时取整行剩余文本作标题）
    const anchor = /<a\b([^>]*)>(.*?)(?:<\/a>|$)/is.exec(line);
    if (anchor) {
      const href = decodeHtmlEntities(readTagAttr(anchor[1], "HREF"));
      if (!href) continue;
      const current = stack[stack.length - 1];
      const icon = decodeHtmlEntities(readTagAttr(anchor[1], "ICON"));
      current.children.push({
        type: "link",
        title: decodeHtmlEntities(stripTags(anchor[2])).trim() || href,
        url: href,
        icon,
        addDate: readTagAttr(anchor[1], "ADD_DATE"),
      });
      continue;
    }

    if (/<dl\b/i.test(line)) {
      if (!enteredRoot) {
        // 根 <DL>：顶层 H3 / 散落书签直接挂在虚拟根上
        enteredRoot = true;
        pendingFolder = null;
        continue;
      }
      const parent = stack[stack.length - 1];
      const folder = pendingFolder || { type: "folder", name: "", children: [] };
      pendingFolder = null;
      parent.children.push(folder);
      stack.push(folder);
      continue;
    }

    if (/<\/dl/i.test(line)) {
      // 根层 <DL> 的关闭不弹栈，避免多余 </DL>（容错）导致栈被掏空
      if (stack.length > 1) stack.pop();
    }
    // <DT>/<p>/<!--注释-->/META/TITLE/H1 等其余行全部忽略
  }

  const topFolders = root.children.filter((child) => child.type === "folder");
  const looseLinks = root.children.filter((child) => child.type === "link");
  const groups = topFolders.map((folder) => ({ name: folder.name, children: folder.children }));
  if (looseLinks.length) groups.unshift({ name: "", children: looseLinks });
  return { groups };
}

/** 导入图标规整：data: URI 原样保留；Netscape 裸 base64 补 PNG 前缀；超长丢弃 */
function normalizeImportIcon(icon) {
  const value = String(icon || "").trim();
  if (!value) return "";
  const uri = value.startsWith("data:") ? value : `data:image/png;base64,${value.replace(/\s+/g, "")}`;
  return uri.length <= IMPORT_ICON_MAX_LENGTH ? uri : "";
}

/**
 * 把 parseNetscapeBookmarksHtml 的结果转换为本程序数据形状：
 * 顶层分组 → 「全部」根下的顶层 folder；书签 → item 节点（icon 转内嵌数据）。
 * 传入 knownUrls（现有数据的全部书签 URL 集合）可按 URL 去重——重复导入同一文件不会翻倍；
 * 因去重而变空的文件夹会被一并丢弃。
 * 产物交给 mergeRootBookmarkData(target, incoming) 即可并入现有数据。
 *
 * @param {{groups: Array<object>}} parsed 解析结果
 * @param {{now?: number, updatedBy?: string, knownUrls?: Set<string> | Array<string>}} [options]
 * @returns {{groups: Array<object>, nodes: Record<string, object>, lastUpdated: number}}
 */
export function bookmarksToHomepageData(parsed, { now = Date.now(), updatedBy = "", knownUrls } = {}) {
  const nodes = {};
  const rootChildIds = [];
  let folderSeq = 0;
  const known = knownUrls instanceof Set ? knownUrls : new Set(Array.isArray(knownUrls) ? knownUrls : []);

  const makeFolderId = () => `fld_bm_${now.toString(36)}_${(folderSeq++).toString(36)}`;

  const buildItem = (child) => {
    if (!child?.url || known.has(String(child.url))) return null;
    const icon = normalizeImportIcon(child.icon);
    const item = createItemNode({
      url: String(child.url),
      title: String(child.title || child.url),
      iconType: icon ? "data" : "auto",
      iconData: icon,
      // 无内嵌图标的书签交给新标签页后台抓取 favicon
      iconPending: !icon,
    });
    const itemCreated = fromBookmarkSeconds(child.addDate);
    if (itemCreated) {
      item.createdAt = itemCreated;
      item.updatedAt = itemCreated;
      item.titleUpdatedAt = itemCreated;
      item.urlUpdatedAt = itemCreated;
    }
    item.updatedBy = updatedBy;
    nodes[item.id] = item;
    return item.id;
  };

  /** 构建文件夹子树；去重后没有可保留内容时返回 null（父级不再引用） */
  const buildFolder = (name, children, addDate) => {
    const id = makeFolderId();
    const created = fromBookmarkSeconds(addDate) || now;
    const folder = {
      id,
      type: "folder",
      title: String(name || "").trim() || "未命名文件夹",
      children: [],
      createdAt: created,
      updatedAt: created,
      titleUpdatedAt: created,
      updatedBy,
    };
    nodes[id] = folder;
    for (const child of Array.isArray(children) ? children : []) {
      if (child?.type === "folder") {
        const subFolder = buildFolder(child.name, child.children, child.addDate);
        if (subFolder) folder.children.push(subFolder.id);
        continue;
      }
      if (child?.type === "link") {
        const itemId = buildItem(child);
        if (itemId) folder.children.push(itemId);
      }
    }
    folder.updatedAt = Math.max(folder.updatedAt, now);
    if (!folder.children.length) {
      // 空文件夹（原本就空 / 去重后被掏空）没有导入价值
      delete nodes[id];
      return null;
    }
    return folder;
  };

  for (const group of Array.isArray(parsed?.groups) ? parsed.groups : []) {
    const children = Array.isArray(group?.children) ? group.children : [];
    if (!group?.name) {
      // 无名分组（顶层散落书签）：直接挂到「全部」根
      for (const child of children) {
        if (child?.type === "folder") {
          const subFolder = buildFolder(child.name, child.children, child.addDate);
          if (subFolder) rootChildIds.push(subFolder.id);
        } else if (child?.type === "link") {
          const itemId = buildItem(child);
          if (itemId) rootChildIds.push(itemId);
        }
      }
      continue;
    }
    const folder = buildFolder(group.name, children, "");
    if (folder) rootChildIds.push(folder.id);
  }

  return {
    groups: [
      {
        id: ALL_BOOKMARKS_GROUP_ID,
        name: "全部",
        order: -1,
        nodes: rootChildIds,
        systemAllGroup: true,
        updatedAt: now,
      },
    ],
    nodes,
    lastUpdated: now,
  };
}
