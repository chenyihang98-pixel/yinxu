"use strict";

const { contextBridge, ipcRenderer } = require("electron");

// Electron reports a rejected handler as
//   "Error invoking remote method 'muse:x': Error: <our message>"
// Only <our message> is meant for the user. (The preload is sandboxed, so this
// stays inline: no local modules can be required here.)
const IPC_PREFIX =
  /^Error invoking remote method '[^']*': (?:[A-Za-z]*Error: )?/;
function invoke(channel, ...args) {
  return ipcRenderer.invoke(channel, ...args).catch((error) => {
    const raw =
      error && typeof error.message === "string"
        ? error.message
        : typeof error === "string"
          ? error
          : "";
    throw new Error(raw.replace(IPC_PREFIX, "").trim() || "操作失败，请重试。");
  });
}

// A deliberately small, typed bridge; no raw IPC, filesystem, or credentials access.
contextBridge.exposeInMainWorld(
  "museDesktop",
  Object.freeze({
    getSettings: () => invoke("muse:get-settings"),
    saveProviderCredentials: (provider, credentials) =>
      invoke("muse:save-provider", provider, credentials),
    deleteProviderCredentials: (provider) =>
      invoke("muse:delete-provider", provider),
    generateMusic: (input) => invoke("muse:generate-music", input),
    cancelGeneration: () => invoke("muse:cancel-generation"),
    // Downloads the last finished result of that service again (nothing is submitted, nothing billed).
    retryLastDownload: (provider) => invoke("muse:retry-download", provider),
    // true while the page holds a paid result that is not stored yet: closing the window then asks first.
    setUnsavedWork: (value) => invoke("muse:set-unsaved-work", value === true),
    saveAudio: (input) => invoke("muse:save-audio", input),
    openExternal: (url) => invoke("muse:open-external", url),
    // Producer agent (large language model); the key never comes back from the main process.
    saveLlmSettings: (settings) => invoke("muse:save-llm", settings),
    deleteLlmSettings: () => invoke("muse:delete-llm"),
    agentPlan: (input) => invoke("muse:agent-plan", input),
    cancelAgent: () => invoke("muse:cancel-agent"),
  }),
);
