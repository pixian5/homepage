/**
 * Netscape 标准 HTML 书签双向转换测试：
 * - 导出：标准格式、HTML 转义（防 XSS）、文件夹层级嵌套、内嵌图标、忽略已删除节点；
 * - 解析：Chrome 导出样例、带属性的 <A>、多层嵌套 <DL><p>、残缺 HTML 容错；
 * - 转换合并：解析结果 → 本程序数据形状 → mergeRootBookmarkData 并入唯一根。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  bookmarksToHomepageData,
  exportNetscapeBookmarksHtml,
  parseNetscapeBookmarksHtml,
} from "../src/js/bookmark-html.js";
import { ALL_BOOKMARKS_GROUP_ID, ensureAllBookmarksGroup, mergeRootBookmarkData } from "../src/js/data-utils.js";

const TS = 1609459200000; // 2021-01-01T00:00:00Z 的毫秒值
const TS_SECONDS = "1609459200";

/** 单根「全部」模型的最小数据 */
function makeData() {
  return {
    groups: [
      { id: ALL_BOOKMARKS_GROUP_ID, name: "全部", order: -1, nodes: ["fld_work", "itm_home"], systemAllGroup: true },
    ],
    nodes: {
      fld_work: {
        id: "fld_work",
        type: "folder",
        title: "工作",
        children: ["itm_escaped", "fld_docs"],
        createdAt: TS,
        updatedAt: TS + 86400000,
      },
      fld_docs: {
        id: "fld_docs",
        type: "folder",
        title: "文档",
        children: ["itm_doc", "itm_deleted"],
        createdAt: TS,
        updatedAt: TS,
      },
      itm_home: {
        id: "itm_home",
        type: "item",
        title: "GitHub",
        url: "https://github.com/",
        createdAt: TS + 1000,
        updatedAt: TS + 1000,
      },
      itm_escaped: {
        id: "itm_escaped",
        type: "item",
        title: '带 <script>alert("xss")</script> 与 & 符号',
        url: "https://example.com/?a=1&b=2",
        iconType: "data",
        iconData: "data:image/png;base64,iVBORw0KGgo=",
        createdAt: TS,
        updatedAt: TS,
      },
      itm_doc: { id: "itm_doc", type: "item", title: "文档站", url: "https://docs.example.com/", createdAt: TS },
      // 已删除节点：导出必须忽略
      itm_deleted: {
        id: "itm_deleted",
        type: "item",
        title: "已删除",
        url: "https://gone.example.com/",
        createdAt: TS,
        deletedAt: TS,
      },
    },
  };
}

describe("exportNetscapeBookmarksHtml", () => {
  it("renders the standard Netscape header", () => {
    const html = exportNetscapeBookmarksHtml(makeData());
    assert.ok(html.startsWith("<!DOCTYPE NETSCAPE-Bookmark-file-1>\n"));
    assert.ok(html.includes("<!-- This is an automatically generated file."));
    assert.ok(html.includes('<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">'));
    assert.ok(html.includes("<TITLE>Bookmarks</TITLE>"));
    assert.ok(html.includes("<H1>Bookmarks</H1>"));
    assert.ok(html.trimEnd().endsWith("</DL><p>"));
  });

  it("renders nested folders and links with timestamps", () => {
    const html = exportNetscapeBookmarksHtml(makeData());
    // 「全部」单根：子级直接置于顶层，不额外包一层“全部”
    assert.ok(html.includes(`<DT><H3 ADD_DATE="${TS_SECONDS}" LAST_MODIFIED="1609545600">工作</H3>`));
    const workOpen = html.indexOf(">工作</H3>");
    const docsOpen = html.indexOf(">文档</H3>");
    const home = html.indexOf('HREF="https://github.com/"');
    assert.ok(workOpen > -1 && docsOpen > workOpen, "「文档」应嵌套在「工作」之内");
    // 顶层书签（GitHub）必须在「工作」文件夹之前（全部根 nodes 顺序：fld_work, itm_home）？
    // ——不：nodes 顺序是 fld_work 在前，GitHub 在后；断言相对顺序即可
    assert.ok(home > workOpen, "GitHub 应出现在「工作」文件夹之后（根顺序）");
    assert.ok(html.includes(`<DT><A HREF="https://docs.example.com/" ADD_DATE="${TS_SECONDS}">文档站</A>`));
  });

  it("escapes html text and attributes (XSS-safe)", () => {
    const html = exportNetscapeBookmarksHtml(makeData());
    // 文本节点只需转义 & < >（引号在文本中无危险）；属性值必须转义引号与 &
    assert.ok(html.includes('带 &lt;script&gt;alert("xss")&lt;/script&gt; 与 &amp; 符号'), "标题必须转义");
    assert.ok(html.includes('HREF="https://example.com/?a=1&amp;b=2"'), "URL 属性必须转义");
    assert.ok(!html.includes("<script>alert"), "不得出现未转义脚本");
  });

  it("embeds data-uri icons and skips deleted nodes", () => {
    const html = exportNetscapeBookmarksHtml(makeData());
    assert.ok(html.includes('ICON="data:image/png;base64,iVBORw0KGgo="'));
    assert.ok(!html.includes("gone.example.com"), "deletedAt 节点不得导出");
    assert.ok(!html.includes("已删除"));
  });

  it("exports legacy multi-group data with one H3 per group", () => {
    const legacy = {
      groups: [
        { id: "g1", name: "工作", order: 0, nodes: ["itm_a"] },
        { id: "g2", name: "生活", order: 1, nodes: [] },
      ],
      nodes: { itm_a: { id: "itm_a", type: "item", title: "A", url: "https://a.example.com/", createdAt: TS } },
    };
    const html = exportNetscapeBookmarksHtml(legacy);
    assert.ok(html.includes(">工作</H3>"));
    assert.ok(html.includes(">生活</H3>"));
    assert.ok(html.includes('HREF="https://a.example.com/"'));
  });
});

/** Chrome 真实导出的标准书签 HTML 样例（含实体与图标） */
const CHROME_SAMPLE = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<!-- This is an automatically generated file.
     It will be read and overwritten.
     DO NOT EDIT! -->
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><H3 ADD_DATE="1609459200" LAST_MODIFIED="1609545600" PERSONAL_TOOLBAR_FOLDER="true">书签栏</H3>
    <DL><p>
        <DT><H3 ADD_DATE="1609459300">工作 &amp; 学习</H3>
        <DL><p>
            <DT><A HREF="https://example.com/?q=1&amp;lang=zh" ADD_DATE="1609459400" ICON="data:image/png;base64,iVBORw0KGgo=">示例 &amp; 测试</A>
        </DL><p>
        <DT><A HREF="https://github.com/" ADD_DATE="1609459500">GitHub</A>
    </DL><p>
    <DT><H3>其他书签</H3>
    <DL><p>
    </DL><p>
</DL><p>
`;

describe("parseNetscapeBookmarksHtml", () => {
  it("parses a standard chrome export with nesting and attributes", () => {
    const parsed = parseNetscapeBookmarksHtml(CHROME_SAMPLE);
    assert.deepEqual(
      parsed.groups.map((group) => group.name),
      ["书签栏", "其他书签"],
    );
    const bar = parsed.groups[0];
    assert.equal(bar.children.length, 2);
    assert.equal(bar.children[0].type, "folder");
    assert.equal(bar.children[0].name, "工作 & 学习");
    const workLinks = bar.children[0].children;
    assert.equal(workLinks.length, 1);
    assert.equal(workLinks[0].url, "https://example.com/?q=1&lang=zh");
    assert.equal(workLinks[0].title, "示例 & 测试");
    assert.equal(workLinks[0].icon, "data:image/png;base64,iVBORw0KGgo=");
    assert.equal(workLinks[0].addDate, "1609459400");
    assert.equal(bar.children[1].type, "link");
    assert.equal(bar.children[1].url, "https://github.com/");
    assert.deepEqual(parsed.groups[1].children, []);
  });

  it("tolerates unclosed H3/A tags and missing </DL>", () => {
    const broken = [
      "<!DOCTYPE NETSCAPE-Bookmark-file-1>",
      "<DL><p>",
      '    <DT><H3 ADD_DATE="123">未闭合文件夹',
      "    <DL><p>",
      '        <DT><A HREF="https://unclosed.example.com/">标题未闭合',
      '        <DT><A HREF="https://ok.example.com/">正常</A>',
      // 意外的结束标签与多余缩进
      "    </DL><p>",
      "</DL><p>",
      "</DL><p>",
    ].join("\n");
    const parsed = parseNetscapeBookmarksHtml(broken);
    assert.equal(parsed.groups.length, 1);
    assert.equal(parsed.groups[0].name, "未闭合文件夹");
    assert.deepEqual(
      parsed.groups[0].children.map((child) => child.url),
      ["https://unclosed.example.com/", "https://ok.example.com/"],
    );
    assert.equal(parsed.groups[0].children[0].title, "标题未闭合");
  });

  it("puts top-level loose links into an unnamed group and survives garbage", () => {
    const loose = [
      "<DL><p>",
      '    <DT><A HREF="https://a.example.com/">A</A>',
      '    <DT><A HREF="https://b.example.com/">B</A>',
      "</DL><p>",
    ].join("\n");
    const parsed = parseNetscapeBookmarksHtml(loose);
    assert.equal(parsed.groups.length, 1);
    assert.equal(parsed.groups[0].name, "");
    assert.equal(parsed.groups[0].children.length, 2);

    // 纯垃圾 / 空输入：不抛异常、返回空分组
    assert.deepEqual(parseNetscapeBookmarksHtml("not html at all\n<trash>").groups, []);
    assert.deepEqual(parseNetscapeBookmarksHtml("").groups, []);
    assert.deepEqual(parseNetscapeBookmarksHtml(null).groups, []);
    // 无 HREF 的锚点忽略
    assert.deepEqual(parseNetscapeBookmarksHtml('<DL><p><DT><A NAME="x">无链接</A></DL><p>').groups, []);
  });

  it("decodes numeric and named entities", () => {
    const html = [
      "<DL><p>",
      "    <DT><H3>&#20013;&#25991; &quot;quoted&quot; &lt;tag&gt;</H3>",
      "    <DL><p>",
      '        <DT><A HREF="https://e.example.com/">&#x4F8B;&#x5982;</A>',
      "    </DL><p>",
      "</DL><p>",
    ].join("\n");
    const parsed = parseNetscapeBookmarksHtml(html);
    assert.equal(parsed.groups[0].name, '中文 "quoted" <tag>');
    assert.equal(parsed.groups[0].children[0].title, "例如");
  });
});

describe("bookmarksToHomepageData + mergeRootBookmarkData", () => {
  it("converts parsed groups into the single-root data shape", () => {
    const parsed = parseNetscapeBookmarksHtml(CHROME_SAMPLE);
    const incoming = bookmarksToHomepageData(parsed, { now: TS, updatedBy: "dev_test" });
    assert.equal(incoming.groups.length, 1);
    assert.equal(incoming.groups[0].id, ALL_BOOKMARKS_GROUP_ID);
    assert.equal(incoming.groups[0].systemAllGroup, true);
    // 两个顶层分组 → 顶层 folder；「其他书签」为空被跳过，只保留「书签栏」
    const rootFolderIds = incoming.groups[0].nodes;
    assert.equal(rootFolderIds.length, 1);
    const barFolder = incoming.nodes[rootFolderIds[0]];
    assert.equal(barFolder.type, "folder");
    assert.equal(barFolder.title, "书签栏");
    const inner = incoming.nodes[barFolder.children[0]];
    assert.equal(inner.title, "工作 & 学习");
    const link = incoming.nodes[inner.children[0]];
    assert.equal(link.type, "item");
    assert.equal(link.url, "https://example.com/?q=1&lang=zh");
    assert.equal(link.iconType, "data");
    assert.equal(link.iconData, "data:image/png;base64,iVBORw0KGgo=");
    assert.equal(link.iconPending, false);
    // ADD_DATE 秒 → 毫秒 createdAt
    assert.equal(link.createdAt, 1609459400000);
    assert.equal(link.updatedBy, "dev_test");
    // 空分组「其他书签」没有导入价值：不应产生节点
    assert.ok(!rootFolderIds.some((id) => incoming.nodes[id]?.title === "其他书签"));
  });

  it("prefixes bare base64 icons and drops oversized ones", () => {
    const parsed = {
      groups: [
        {
          name: "图标",
          children: [
            { type: "link", title: "裸 base64", url: "https://bare.example.com/", icon: "iVBORw0KGgo=" },
            {
              type: "link",
              title: "超大图标",
              url: "https://huge.example.com/",
              icon: `data:image/png;base64,${"A".repeat(20000)}`,
            },
          ],
        },
      ],
    };
    const incoming = bookmarksToHomepageData(parsed, { now: TS });
    const items = Object.values(incoming.nodes).filter((node) => node.type === "item");
    assert.equal(items.length, 2);
    const bare = items.find((node) => node.url.includes("bare"));
    assert.equal(bare.iconData, "data:image/png;base64,iVBORw0KGgo=");
    const huge = items.find((node) => node.url.includes("huge"));
    assert.equal(huge.iconData, "");
    assert.equal(huge.iconType, "auto");
  });

  it("merges into existing data and knownUrls keeps re-imports idempotent", () => {
    const target = makeData();
    ensureAllBookmarksGroup(target);
    const parsed = parseNetscapeBookmarksHtml(CHROME_SAMPLE);
    const incoming = bookmarksToHomepageData(parsed, { now: TS, updatedBy: "dev_test" });

    const changedFirst = mergeRootBookmarkData(target, incoming);
    assert.equal(changedFirst, true);
    const root = target.groups.find((group) => group.id === ALL_BOOKMARKS_GROUP_ID);
    // 顶层新增「书签栏」一个 folder（「其他书签」为空被跳过）
    assert.ok(root.nodes.some((id) => target.nodes[id]?.title === "书签栏"));
    const nodeCountAfterFirst = Object.keys(target.nodes).length;

    // 再次导入同一文件：以现有全部 URL 作为 knownUrls，转换结果为空 → 不再并入任何节点
    const knownUrls = new Set(
      Object.values(target.nodes)
        .filter((node) => node?.type === "item" && !node.deletedAt && node.url)
        .map((node) => node.url),
    );
    const secondIncoming = bookmarksToHomepageData(parsed, { now: TS + 1, updatedBy: "dev_test", knownUrls });
    assert.equal(Object.keys(secondIncoming.nodes).length, 0, "已知 URL 应全部被过滤");
    const changedSecond = mergeRootBookmarkData(target, secondIncoming);
    assert.equal(Object.keys(target.nodes).length, nodeCountAfterFirst, "重复导入不得使数据翻倍");
    assert.ok(changedFirst || !changedSecond);
  });
});

describe("round-trip export → parse", () => {
  it("preserves folder hierarchy, titles and urls across a round trip", () => {
    const html = exportNetscapeBookmarksHtml(makeData());
    const parsed = parseNetscapeBookmarksHtml(html);
    // 单根导出：顶层节点是「工作」文件夹 + GitHub 链接（顶层散链接 → 无名分组）
    const work = parsed.groups.find((group) => group.name === "工作");
    assert.ok(work, "「工作」文件夹应成为顶层分组");
    assert.equal(work.children.length, 2);
    assert.equal(work.children[0].type, "link");
    assert.equal(work.children[0].title, '带 <script>alert("xss")</script> 与 & 符号');
    assert.equal(work.children[0].url, "https://example.com/?a=1&b=2");
    assert.equal(work.children[1].type, "folder");
    assert.equal(work.children[1].name, "文档");
    assert.equal(work.children[1].children[0].url, "https://docs.example.com/");
    const loose = parsed.groups.find((group) => !group.name);
    assert.ok(loose.children.some((child) => child.url === "https://github.com/"));
    // 已删除节点不应在往返中出现
    assert.ok(!html.includes("gone.example.com"));
  });
});
