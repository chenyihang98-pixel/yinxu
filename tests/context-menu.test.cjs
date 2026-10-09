"use strict";

// MAIN-07: a minimal native context menu, so an API key can be pasted with the mouse.
// What a real right click produces under Electron is checked by scripts/desktop-smoke.cjs.
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const {
  contextMenuTemplate,
  installContextMenu,
} = require("../electron/context-menu.cjs");

const ALL = {
  canUndo: true,
  canRedo: true,
  canCut: true,
  canCopy: true,
  canPaste: true,
  canDelete: true,
  canSelectAll: true,
  canEditRichly: false,
};
const NONE = Object.fromEntries(Object.keys(ALL).map((name) => [name, false]));
const summary = (template) =>
  template.map(
    (item) => `${item.label}:${item.role}:${item.enabled ? "on" : "off"}`,
  );

test("a text field gets exactly 剪切 / 复制 / 粘贴 / 全选, enabled as Chromium reports", () => {
  assert.deepEqual(
    summary(
      contextMenuTemplate({
        isEditable: true,
        selectionText: "已选中的字",
        editFlags: ALL,
      }),
    ),
    ["剪切:cut:on", "复制:copy:on", "粘贴:paste:on", "全选:selectAll:on"],
  );
  // An empty key field: nothing to cut or copy, but paste is what the user came for.
  assert.deepEqual(
    summary(
      contextMenuTemplate({
        isEditable: true,
        selectionText: "",
        editFlags: { ...NONE, canPaste: true, canSelectAll: true },
      }),
    ),
    ["剪切:cut:off", "复制:copy:off", "粘贴:paste:on", "全选:selectAll:on"],
  );
  // A password field with a selection: Chromium does not allow copying out of it.
  assert.deepEqual(
    summary(
      contextMenuTemplate({
        isEditable: true,
        formControlType: "input-password",
        selectionText: "",
        editFlags: { ...ALL, canCut: false, canCopy: false },
      }),
    ),
    ["剪切:cut:off", "复制:copy:off", "粘贴:paste:on", "全选:selectAll:on"],
  );
  // Missing or odd flags never enable anything by accident.
  for (const editFlags of [
    undefined,
    null,
    "yes",
    {},
    { canPaste: "true", canCut: 1 },
  ]) {
    assert.deepEqual(
      summary(contextMenuTemplate({ isEditable: true, editFlags })),
      ["剪切:cut:off", "复制:copy:off", "粘贴:paste:off", "全选:selectAll:off"],
    );
  }
});

test("selected text outside a field gets 复制 only; everything else gets no menu at all", () => {
  assert.deepEqual(
    summary(
      contextMenuTemplate({
        isEditable: false,
        selectionText: "生成失败：请求编号 req_123",
        editFlags: { ...NONE, canCopy: true },
      }),
    ),
    ["复制:copy:on"],
  );
  assert.deepEqual(
    contextMenuTemplate({
      isEditable: false,
      selectionText: "",
      editFlags: NONE,
    }),
    [],
  );
  assert.deepEqual(
    contextMenuTemplate({
      isEditable: false,
      selectionText: "   \n",
      editFlags: { ...NONE, canCopy: true },
    }),
    [],
    "whitespace is not a selection",
  );
  assert.deepEqual(
    contextMenuTemplate({
      isEditable: false,
      selectionText: "text",
      editFlags: { ...NONE, canCopy: false },
    }),
    [],
    "nothing to offer when it cannot be copied",
  );
  assert.deepEqual(
    contextMenuTemplate({
      isEditable: false,
      linkURL: "https://example.com/",
      srcURL: "file:///x.png",
      mediaType: "image",
      editFlags: NONE,
    }),
    [],
    "links and images get nothing",
  );
  for (const odd of [
    undefined,
    null,
    {},
    "text",
    { isEditable: "true", selectionText: 42 },
  ])
    assert.deepEqual(contextMenuTemplate(odd), []);
});

test("nothing but the editing commands: no reload, no inspect, no separators, no custom click handlers", () => {
  const allowed = new Set(["cut", "copy", "paste", "selectAll"]);
  for (const params of [
    { isEditable: true, editFlags: ALL },
    { isEditable: false, selectionText: "x", editFlags: ALL },
    {
      isEditable: true,
      selectionText: "x",
      linkURL: "https://example.com",
      editFlags: ALL,
    },
  ]) {
    for (const item of contextMenuTemplate(params)) {
      assert.deepEqual(Object.keys(item).sort(), ["enabled", "label", "role"]);
      assert.ok(allowed.has(item.role), item.role);
      assert.match(item.label, /^[一-鿿]{2}$/, "Chinese labels");
    }
  }
});

test("installContextMenu builds the menu from the template and pops it up on the window, or stays silent", () => {
  const webContents = new EventEmitter();
  const built = [],
    popped = [];
  const Menu = {
    buildFromTemplate: (template) => {
      built.push(template);
      return { popup: (options) => popped.push(options) };
    },
  };
  const window = { id: 1 };
  installContextMenu(webContents, { Menu, getWindow: () => window });
  assert.equal(webContents.listenerCount("context-menu"), 1);

  webContents.emit(
    "context-menu",
    {},
    { isEditable: true, editFlags: { ...NONE, canPaste: true } },
  );
  assert.deepEqual(summary(built[0]), [
    "剪切:cut:off",
    "复制:copy:off",
    "粘贴:paste:on",
    "全选:selectAll:off",
  ]);
  assert.deepEqual(popped, [{ window }]);

  webContents.emit(
    "context-menu",
    {},
    { isEditable: false, selectionText: "", editFlags: NONE },
  );
  assert.equal(built.length, 1, "no menu is built for a click on nothing");
  assert.equal(popped.length, 1);

  // The window is already gone: still no throw.
  const orphan = new EventEmitter();
  installContextMenu(orphan, { Menu, getWindow: () => null });
  orphan.emit(
    "context-menu",
    {},
    {
      isEditable: false,
      selectionText: "可复制",
      editFlags: { canCopy: true },
    },
  );
  assert.deepEqual(popped[1], {});
});
