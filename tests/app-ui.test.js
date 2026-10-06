import assert from "node:assert/strict";
import { it } from "node:test";
import { translateAppText } from "../src/js/app-i18n.js";
import { html, rawHtml, runWithButtonState } from "../src/js/ui-utils.js";

it("切换语言后取到对应文案，残缺语言包和未知键保留回退", () => {
  assert.equal(translateAppText("en", "toolbar.add"), "Add");
  assert.equal(translateAppText("zh-CN", "toolbar.add"), "新增");
  assert.equal(translateAppText("zh-TW", "settings.saved"), "設定已儲存");
  assert.equal(translateAppText("ja", "settings.sync.state.off"), "Off");
  assert.equal(translateAppText("unknown", "toolbar.add"), "Add");
  assert.equal(translateAppText("en", "missing.key"), "missing.key");
  assert.equal(translateAppText("zh-CN", "delete.deletedCount", { count: 0 }), "已删除 0 个快捷按钮");
});

it("导入文本和嵌套界面模板中的用户内容仍会转义", () => {
  const title = '</textarea><img src=x onerror="alert(1)">';
  const nested = html`<span>${title}</span>`;
  assert.equal(
    html`<section>${rawHtml(nested)}</section>`,
    "<section><span>&lt;/textarea&gt;&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</span></section>",
  );
});

it("异步按钮防止重复提交，失败后恢复可点击状态", async () => {
  const attributes = new Map();
  const button = {
    disabled: false,
    isConnected: true,
    textContent: "保存",
    setAttribute: (key, value) => attributes.set(key, value),
    removeAttribute: (key) => attributes.delete(key),
  };
  let rejectOperation;
  const pending = runWithButtonState(
    button,
    "保存中",
    () =>
      new Promise((_resolve, reject) => {
        rejectOperation = reject;
      }),
  );
  assert.equal(button.disabled, true);
  assert.equal(attributes.get("aria-busy"), "true");
  await runWithButtonState(button, "重复保存", () => assert.fail("不应重复提交"));
  rejectOperation(new Error("磁盘不可写"));
  await assert.rejects(pending, /磁盘不可写/);
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, "保存");
  assert.equal(attributes.has("aria-busy"), false);
});
