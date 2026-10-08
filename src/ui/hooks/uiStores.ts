import { createValueStore } from "./store";

/**
 * The main transport (in the player card) is on screen. The mini transport
 * shows whenever this is false while a work is loaded.
 */
export const transportInView = createValueStore(false);

/** Sheets and dialogs that are open outside `ui.modal` (e.g. 全部风格). */
export const localOverlays = createValueStore(0);
