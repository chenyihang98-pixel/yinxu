/**
 * The library's flows: reading the list, rename, favourite, soft delete with
 * an undo window, import, damaged records. No React.
 */
import type { Project } from "../types";
import { BUSY, WRITE_FAILED } from "./kernel";
import type { Kernel } from "./kernel";
import { UNDO_WINDOW_MS, cleanTitle, errorText } from "./logic";
import type { StudioFlows } from "./studioFlows";
import type { AppActions } from "./types";

const MAX_IMPORT_BYTES = 1024 * 1024;

export class LibraryFlows {
  private readonly kernel: Kernel;
  private readonly studio: StudioFlows;
  /** soft deletes whose undo window is still open */
  private readonly removals = new Map<
    string,
    { timer: unknown; toast: number }
  >();

  constructor(kernel: Kernel, studio: StudioFlows) {
    this.kernel = kernel;
    this.studio = studio;
  }

  /** The page is going away: carry out the deletions still waiting for undo. */
  finishRemovals(): void {
    for (const id of [...this.removals.keys()]) void this.finishRemoval(id);
  }

  /**
   * Deletions the previous session asked for but could not finish: the page
   * closed inside the undo window, and a database write started while a page
   * is being torn down is not guaranteed to happen. Runs before the library
   * is read, so those works never reappear.
   */
  async finishInterrupted(): Promise<void> {
    const ids = [...this.kernel.pendingRemovals].filter(
      (id) => !this.removals.has(id),
    );
    if (ids.length === 0) return;
    for (const id of ids) {
      this.kernel.pendingRemovals.delete(id);
      try {
        await this.kernel.queue(() =>
          this.kernel.deps.storage.deleteProject(id),
        );
      } catch {
        /* the library cannot be written: the work simply stays */
      }
    }
    this.kernel.writeSession();
  }

  /* ---------------- library ---------------- */

  readonly refreshLibrary: AppActions["refreshLibrary"] = async () => {
    try {
      const { projects, damaged } = await this.kernel.deps.storage.listProjects();
      this.kernel.dispatch({ type: "library/loaded", projects, damaged });
    } catch (error) {
      this.kernel.dispatch({
        type: "library/failed",
        error: errorText(error, "无法读取作品库，请重新启动后再试。"),
      });
    }
    await this.kernel.refreshStorage();
  };

  readonly rename: AppActions["rename"] = async (id, title) => {
    const work = this.kernel.find(id);
    const next = cleanTitle(title);
    // Nothing typed, or nothing changed: no write at all.
    if (!work || !next || next === work.title) return false;
    return this.patchAndSave(id, { title: next }, "新名称");
  };

  readonly toggleFavourite: AppActions["toggleFavourite"] = async (
    id,
  ) => {
    const work = this.kernel.find(id);
    if (!work) return false;
    return this.patchAndSave(id, { favorite: !work.favorite }, "收藏状态");
  };

  readonly removeProject: AppActions["removeProject"] = (
    id,
    confirmed = false,
  ) => {
    const work = this.kernel.state.library.projects.find((item) => item.id === id);
    if (!work) return "refused";
    if (this.kernel.busy) {
      this.kernel.toast(BUSY);
      return "refused";
    }
    // Paid audio is never deleted by a single click.
    if (work.provider !== "local" && !confirmed) return "confirm";
    const wait = this.kernel.deps.undoMs ?? UNDO_WINDOW_MS;
    const current = this.kernel.state.studio.project?.id === id;
    if (current) {
      this.studio.flushMix();
      this.kernel.player.unload();
    }
    this.kernel.dispatch({
      type: "library/hide",
      id,
      expiresAt: this.kernel.deps.now() + wait,
    });
    // The composer is empty again: it offers the user's own engine.
    if (current) this.studio.restoreEngine();
    const toast = this.kernel.toast(
      `已删除《${work.title}》`,
      "info",
      { label: "撤销", run: () => this.undoRemove(id) },
      wait,
    );
    const timer = this.kernel.deps.timers.set(
      () => void this.finishRemoval(id),
      wait,
    );
    this.removals.set(id, { timer, toast });
    // Remembered at once (the session write is synchronous).
    this.kernel.pendingRemovals.add(id);
    this.kernel.writeSession();
    return "removed";
  };

  readonly undoRemove: AppActions["undoRemove"] = (id) => {
    const pending = this.removals.get(id);
    if (!pending) return;
    this.kernel.deps.timers.clear(pending.timer);
    this.removals.delete(id);
    this.kernel.pendingRemovals.delete(id);
    this.kernel.writeSession();
    this.kernel.dispatch({ type: "toast/dismiss", id: pending.toast });
    this.kernel.dispatch({ type: "library/restore", id });
    this.kernel.toast("已恢复");
  };

  /** The undo window closed: now the record is really deleted. */
  private async finishRemoval(id: string): Promise<void> {
    const pending = this.removals.get(id);
    if (!pending) return;
    this.kernel.deps.timers.clear(pending.timer);
    this.removals.delete(id);
    try {
      await this.kernel.queue(() => this.kernel.deps.storage.deleteProject(id));
      this.kernel.pendingRemovals.delete(id);
      this.kernel.writeSession();
      this.kernel.dispatch({ type: "library/removed", id });
      void this.kernel.refreshStorage();
    } catch (error) {
      this.kernel.pendingRemovals.delete(id);
      this.kernel.writeSession();
      this.kernel.dispatch({ type: "library/restore", id });
      this.kernel.toast(
        `删除失败，作品仍在作品库中：${errorText(error, WRITE_FAILED)}`,
        "error",
      );
    }
  }

  readonly importFile: AppActions["importFile"] = async (file) => {
    if (this.kernel.busy) {
      this.kernel.toast(BUSY);
      return false;
    }
    let project: Project;
    try {
      if (!file || !(file.size <= MAX_IMPORT_BYTES))
        throw new Error("工程文件过大，请选择小于 1 MB 的 Muse 工程 JSON 文件。");
      project = this.kernel.deps.storage.importProject(await file.text());
      await this.kernel.store(project);
    } catch (error) {
      this.kernel.toast(
        errorText(error, "无法导入这个文件，请选择由音序导出的工程 JSON。"),
        "error",
      );
      return false;
    }
    this.kernel.dispatch({ type: "library/upsert", project });
    this.kernel.afterSave();
    this.kernel.toast(`已导入《${project.title}》`);
    await this.studio.open(project.id, { reason: "opened", autoplay: false });
    return true;
  };

  readonly exportDamaged: AppActions["exportDamaged"] = async (id) => {
    const record = this.kernel.state.library.damaged.find((item) => item.id === id);
    if (!record) return false;
    try {
      const raw = await this.kernel.deps.storage.readRawRecord(id);
      if (raw === null) throw new Error("这条记录已经不存在了。");
      const result = await this.kernel.deps.exporter.saveFile({
        name: `${record.title}-原始数据`,
        data: new TextEncoder().encode(raw).buffer as ArrayBuffer,
        format: "json",
      });
      if (result.saved) this.kernel.toast("已导出这条记录的原始数据");
      return result.saved;
    } catch (error) {
      this.kernel.toast(errorText(error, "导出失败，请重试。"), "error");
      return false;
    }
  };

  readonly removeDamaged: AppActions["removeDamaged"] = async (id) => {
    if (!this.kernel.state.library.damaged.some((item) => item.id === id))
      return false;
    try {
      await this.kernel.queue(() => this.kernel.deps.storage.deleteProject(id));
    } catch (error) {
      this.kernel.toast(
        `删除失败：${errorText(error, WRITE_FAILED)}`,
        "error",
      );
      return false;
    }
    this.kernel.dispatch({ type: "library/damagedRemoved", id });
    this.kernel.toast("已删除这条无法读取的记录");
    void this.kernel.refreshStorage();
    return true;
  };

  /** Rename / favourite: optimistic, rolled back when the write fails. */
  private async patchAndSave(
    id: string,
    patch: Partial<Project>,
    what: string,
  ): Promise<boolean> {
    const before = this.kernel.find(id);
    if (!before) return false;
    const rollback: Partial<Project> = {};
    for (const key of Object.keys(patch) as (keyof Project)[])
      Object.assign(rollback, { [key]: before[key] });
    this.kernel.dispatch({ type: "project/patch", id, patch });
    const next = this.kernel.find(id);
    if (!next) return false;
    try {
      await this.kernel.store(next);
    } catch (error) {
      this.kernel.dispatch({ type: "project/patch", id, patch: rollback });
      this.kernel.toast(
        `${what}没有保存：${errorText(error, WRITE_FAILED)}`,
        "error",
      );
      return false;
    }
    if (!this.kernel.listed(id) && this.kernel.state.studio.project?.id === id) {
      // The work had never reached the library (an earlier save failed).
      this.kernel.dispatch({
        type: "library/upsert",
        project: this.kernel.find(id) ?? next,
      });
      this.kernel.dispatch({ type: "studio/saveState", id, saveState: "saved" });
    }
    return true;
  }
}
