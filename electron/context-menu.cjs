"use strict";

/**
 * The window has no application menu and Electron shows no context menu of its
 * own, so without this a right click does nothing - and an API key could only
 * be pasted with Ctrl+V. The menu is deliberately minimal: the four editing
 * commands in a text field, "copy" on selected text, nothing anywhere else
 * (no reload, no inspect - in development or in a packaged build).
 */
function contextMenuTemplate(params) {
  const flags =
    params && typeof params.editFlags === "object" && params.editFlags
      ? params.editFlags
      : {};
  if (params?.isEditable === true) {
    return [
      { role: "cut", label: "剪切", enabled: flags.canCut === true },
      { role: "copy", label: "复制", enabled: flags.canCopy === true },
      { role: "paste", label: "粘贴", enabled: flags.canPaste === true },
      {
        role: "selectAll",
        label: "全选",
        enabled: flags.canSelectAll === true,
      },
    ];
  }
  if (
    typeof params?.selectionText === "string" &&
    params.selectionText.trim() &&
    flags.canCopy !== false
  ) {
    return [{ role: "copy", label: "复制", enabled: true }];
  }
  return [];
}

/** `Menu` is Electron's Menu class; `getWindow()` returns the window the menu belongs to. */
function installContextMenu(webContents, { Menu, getWindow }) {
  webContents.on("context-menu", (_event, params) => {
    const template = contextMenuTemplate(params);
    if (!template.length) return;
    const window = typeof getWindow === "function" ? getWindow() : null;
    Menu.buildFromTemplate(template).popup(window ? { window } : {});
  });
}

module.exports = { contextMenuTemplate, installContextMenu };
