/**
 * The studio's flows: composer, inspector, the one running job (producing or
 * opening), mixer, saving and export. No React.
 *
 * Concurrency rules:
 *  - `running` is the synchronous job lock; a second job is refused, never
 *    queued. Each job has an id; `alive(job)` is false once it was cancelled.
 *  - A job changes the current work only through `commit()` and through
 *    reducer actions that carry its id — both ignore a job that is not alive.
 *  - Actions read the kernel's state when they run. Nothing is captured in
 *    closures across an await except values that were deliberately
 *    snapshotted before the job started.
 *
 * Money and data rules:
 *  - A cloud engine means a paid request. Nothing is sent to one without the
 *    user's yes to a dialog (until they tick 本次会话不再提示 for that
 *    service), and never on the offline rules' guess after the language
 *    model failed.
 *  - A result whose save failed stays loaded as an unsaved result: it is
 *    retried once automatically, can be retried by hand, and is not left
 *    without a question.
 *  - A result the service finished but whose file did not arrive is not
 *    asked for again with a second paid request: 重新下载 fetches it.
 *  - A stored work is only ever changed field by field (Kernel.patch), so a
 *    tab that read the library earlier cannot undo what another tab did.
 */
import { buildCloudPrompt } from "../agent/cloudPrompt";
import type { AgentPlan, AgentTurn, BrainKind } from "../agent/types";
import { REFERENCE_VOLUMES } from "../audio/render-types";
import { TRACKS } from "../music/score";
import type { PlayerSource } from "../player/usePlayer";
import { providerName } from "../providers";
import { exportWork } from "../services/exporter";
import { decodeBlob, runCloud, runLocal } from "../services/generation";
import type { RenderMusic } from "../services/generation";
import type {
  CloudProvider,
  DesktopAPI,
  MusicConfig,
  Project,
  Provider,
  TrackName,
} from "../types";
import { BUSY, WRITE_FAILED } from "./kernel";
import type { Kernel } from "./kernel";
import type { EnginePhaseListener } from "./ports";
import {
  IDLE,
  MIX_SAVE_DELAY_MS,
  SAVE_RETRY_MS,
  TOAST_ERROR_MS,
  agentTurn,
  appendPhrase,
  buildProject,
  carriedDraft,
  changedFields,
  cleanMessage,
  clampVolume,
  draftOf,
  durationChanged,
  errorText,
  failureTurn,
  isDue,
  joinText,
  rebaseVolumes,
  sameVolumes,
  scheduleChange,
  scheduleRelease,
  shouldAutoplay,
  userTurn,
  waitFor,
} from "./logic";
import type { Schedule } from "./logic";
import {
  ENGINE_STARTING,
  activeBrain,
  brainOptions,
  cancelText,
  configProblem,
  engineOptions,
  engineProblem,
  phaseText,
} from "./options";
import {
  buildAgentRequest,
  canSendPinsOnly,
  enforcePins,
  honestPlan,
  inaudiblePlan,
  paidNotice,
  pinsOnlyText,
  planFromDraft,
  planVariation,
  truthfulTiming,
  withAskedDrums,
  withStylePrompt,
} from "./plan";
import { canApplyDraft, isUnsaved } from "./selectors";
import type {
  AppActions,
  Draft,
  JobKind,
  JobStage,
  LoadEvent,
  LoadedAudio,
  Pins,
  SaveState,
  StemsAudio,
  TurnNote,
} from "./types";
import { lineage, nextRevisionIn } from "./works";

const DECODE_FAILED =
  "这段音频无法解码试听。它仍然保存在「我的作品」中，可以在「导出」里保存原始音频。";
const DECODE_FAILED_UNSAVED =
  "这段音频无法解码试听，也还没有保存到「我的作品」。请先导出原始音频。";
const AUDIO_MISSING = "这首作品的音频文件不可用。";
/** Toast keys: one notice of each kind at a time. */
const MIX_TOAST = "mix-save";
const SAVE_TOAST = "save-failed";
const NOTE_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
/** Toast key: the one "your text was replaced" notice. */
const TEXT_TOAST = "composer-replaced";
/** Toast key: the offer to fetch a finished cloud result again. */
const DOWNLOAD_TOAST = "download-again";
/**
 * How the main process starts its message when a cloud result exists on the
 * service but its file did not arrive (electron/music-service.cjs,
 * downloadStopped): network failure, cancelled, timed out. Only then is
 * there something that 重新下载 can fetch.
 */
const DOWNLOAD_STOPPED =
  /^(?:音乐已生成，但下载失败|已取消下载。|下载等待超过)/;
/** The main process no longer holds the result (another request replaced it). */
const DOWNLOAD_GONE = /^没有等待重新下载的音乐/;

/** The raw exception behind an engine failure belongs in the console, never on screen. */
function logDetail(error: unknown): void {
  const detail = (error as { detail?: unknown } | null)?.detail;
  if (typeof detail === "string" && detail)
    console.warn("[muse] engine failure:", detail);
}

interface Running {
  id: number;
  kind: JobKind;
  provider: Provider;
  brain: BrainKind;
  abort: AbortController;
  cancelled: boolean;
  /** the user's own composer text, to give back when the job is cancelled or fails */
  restoreText: string | null;
  /**
   * Inspector values this job uses up (the draft it applies, or the values
   * of the work it starts from). Edits beyond them survive onto its result.
   */
  consumed: Draft | null;
}

/**
 * A cloud request as it was planned: everything needed to take delivery of
 * its result — right away, or later through 重新下载 when the first download
 * did not arrive.
 */
interface CloudOrder {
  provider: CloudProvider;
  /** the plan as the thread will show it */
  plan: AgentPlan;
  /** the exact prompt that was sent */
  prompt: string;
  model: string | undefined;
  /** the work the request refines, as it was then; null for a new piece */
  base: Project | null;
  /** the conversation before this request */
  thread: AgentTurn[];
  /** the user's side of the request */
  mine: AgentTurn;
  note: TurnNote;
  /** a direct control (应用调整 / 换一版) rather than a message */
  direct: boolean;
  /** composer text that was handed back when the download failed */
  typed: string | null;
}

type Intent =
  | { kind: "message"; text?: string }
  | { kind: "draft" }
  | { kind: "variation" };

/** What an earlier pass of generate() already settled with the user. */
interface Pass {
  /** the paid request to this service was confirmed */
  paid?: Provider;
  /** leaving this unsaved work was accepted */
  unsaved?: string;
}

function toSource(audio: LoadedAudio): PlayerSource {
  return audio.kind === "stems"
    ? { kind: "stems", stems: audio.stems, engine: audio.engine }
    : { kind: "mix", buffer: audio.buffer };
}

export class StudioFlows {
  private readonly kernel: Kernel;
  private running: Running | null = null;
  private jobSeq = 0;
  private mixSchedule: Schedule = IDLE;
  private mixTimer: unknown = null;
  /** refused autoplay stays silent until this time */
  private quietUntil = 0;
  /**
   * The engine the user picked by hand. Opening a work points the selector
   * at that work's own engine so refinements continue on it; when the work is
   * left, the selector returns here — reopening an old cloud work must not
   * turn the next new piece into a paid request.
   */
  private chosenProvider: Provider = "local";
  /** services the user ticked 本次会话不再提示 for */
  private readonly paidAccepted = new Set<CloudProvider>();
  /**
   * What the user left unfinished on a work when another one took its place:
   * inspector edits that were not applied, and words typed for the producer
   * that were not sent. They wait here (for this run) and come back when the
   * work is opened again — leaving a work never throws them away.
   */
  private readonly parked = new Map<
    string,
    { draft?: Partial<Draft>; text?: string }
  >();
  /**
   * 循环试听 as the user last set it, per structure. Unset: a 循环片段 is
   * auditioned as a loop, a piece with a 完整结尾 plays to its end.
   */
  private readonly audition: { loop?: boolean; ending?: boolean } = {};
  /**
   * Fader positions that are set but not confirmed in the library yet, by
   * work: what the next save sends, what a late answer from storage or
   * another tab must not overwrite, and what is noted down in the session
   * when the page goes away.
   */
  private readonly unconfirmed = new Map<string, Map<TrackName, number>>();
  /** the work whose mix could not be saved: one notice per streak, not per gesture */
  private mixFailure: string | null = null;
  /** unsaved works the user has exported: leaving them needs no question */
  private readonly exported = new Set<string>();
  /**
   * Paid results that arrived after their job was cancelled and could not be
   * stored. They are not the current work; they wait here for the automatic
   * retry or an export.
   */
  private readonly strays = new Map<string, Project>();
  /**
   * The cloud request whose result exists on the service but was not
   * downloaded. The main process keeps how to fetch it (in memory, until the
   * next request); this is what to do with it once it arrives.
   */
  private undelivered: CloudOrder | null = null;

  constructor(kernel: Kernel) {
    this.kernel = kernel;
  }

  /** Player failures arrive here as ready-to-show text. */
  readonly onPlayerError = (message: string): void => {
    // An autoplay the browser refused is not an error: the work stays paused.
    if (this.kernel.deps.now() < this.quietUntil) return;
    this.kernel.toast(message, "error");
  };

  /* ---------------- composer ---------------- */

  readonly setComposerText: AppActions["setComposerText"] = (text) => {
    this.kernel.dispatch({
      type: "composer/text",
      text: typeof text === "string" ? text.slice(0, 4000) : "",
    });
    this.kernel.touchSession();
  };

  readonly setPin: AppActions["setPin"] = (field, value) => {
    const { [field]: _removed, ...rest } = this.kernel.state.studio.pins;
    this.kernel.dispatch({
      type: "composer/pins",
      pins: value === undefined ? rest : { ...rest, [field]: value },
    });
  };

  readonly setProvider: AppActions["setProvider"] = (provider) => {
    const problem = engineProblem(
      provider,
      engineOptions(this.kernel.deps.platform, this.kernel.state.settings),
    );
    if (problem) {
      this.kernel.refuse(problem);
      return;
    }
    this.chosenProvider = provider;
    this.kernel.dispatch({ type: "composer/provider", provider });
  };

  /** The loaded work is gone: the selector goes back to the user's own engine. */
  restoreEngine(): void {
    const { deps, state } = this.kernel;
    const usable = !engineProblem(
      this.chosenProvider,
      engineOptions(deps.platform, state.settings),
    );
    if (!usable) this.chosenProvider = "local";
    if (state.studio.provider !== this.chosenProvider)
      this.kernel.dispatch({
        type: "composer/provider",
        provider: this.chosenProvider,
      });
  }

  readonly setBrain: AppActions["setBrain"] = (brain) => {
    if (brain === "llm") {
      const { deps, state } = this.kernel;
      const option = brainOptions(deps.platform, state.settings).find(
        (item) => item.id === "llm",
      );
      if (!option?.available) {
        this.kernel.refuse(
          option?.desktopOnly
            ? { message: "制作人大模型只在 Windows 桌面版中可用。" }
            : {
                message: state.settings.llm.damaged
                  ? "大模型设置无法读取，请在设置中重新保存。"
                  : "请先在设置中填写大模型的连接信息。",
                settingsTab: "llm",
              },
        );
        return;
      }
    }
    this.kernel.dispatch({
      type: "composer/brain",
      brain: brain === "llm" ? "llm" : "rules",
    });
    this.kernel.writeSession();
  };

  readonly send: AppActions["send"] = (text) =>
    this.generate({ kind: "message", ...(text !== undefined ? { text } : {}) });

  readonly pickSuggestion: AppActions["pickSuggestion"] = (text) => {
    const phrase = cleanMessage(text);
    if (!phrase) return Promise.resolve(false);
    const { provider, composerText } = this.kernel.state.studio;
    if (provider === "local")
      return this.generate({ kind: "message", text: phrase });
    // A cloud engine: one click is never a paid request. The phrase joins
    // what is typed, next to the billing notice, and the user sends it.
    this.setComposerText(appendPhrase(composerText, phrase));
    return Promise.resolve(false);
  };

  readonly applyDraft: AppActions["applyDraft"] = () =>
    this.generate({ kind: "draft" });

  readonly variation: AppActions["variation"] = () =>
    this.generate({ kind: "variation" });

  /**
   * Leave the current work (it stays in the library) for the empty state,
   * then run `after`. An unsaved result is not left without a question: the
   * call returns false and the work is left only once the user has agreed.
   */
  private leaveWork(after: () => void): boolean {
    if (this.running) {
      this.kernel.toast(BUSY);
      return false;
    }
    if (this.kernel.questioning) return false;
    const leave = () => {
      if (this.kernel.state.studio.project) {
        this.park(true);
        this.flushMix();
        this.kernel.player.unload();
      }
      // Notices about the work that is being left go with it.
      this.mixFailure = null;
      this.kernel.withdraw(MIX_TOAST);
      this.kernel.withdraw(SAVE_TOAST);
      this.kernel.dispatch({ type: "studio/unloaded" });
      this.restoreEngine();
      after();
    };
    if (this.needsQuestion()) {
      void this.settleUnsaved().then((agreed) => {
        if (agreed && !this.running) leave();
      });
      return false;
    }
    leave();
    return true;
  }

  readonly newPiece: AppActions["newPiece"] = () => {
    const { project, composerText, pins } = this.kernel.state.studio;
    // Starting over in the empty state clears a description that was never
    // sent: it can be taken back.
    const typed = project ? "" : composerText;
    return this.leaveWork(() => {
      this.kernel.dispatch({ type: "ui/navigate", page: "studio" });
      this.kernel.writeSession();
      if (typed.trim()) this.offerText("已清空刚才写的描述。", typed, pins, "");
    });
  };

  /**
   * The new-piece composer just lost what the user had typed (`typed`, with
   * `pins`) and now holds `now`: say so, with 撤销 for as long as nothing
   * else has been typed or loaded since.
   */
  private offerText(
    message: string,
    typed: string,
    pins: Pins,
    now: string,
  ): void {
    this.kernel.toast(
      message,
      "info",
      {
        label: "撤销",
        run: () => {
          const { project, composerText } = this.kernel.state.studio;
          if (project || composerText !== now) return;
          this.setComposerText(typed);
          this.kernel.dispatch({ type: "composer/pins", pins });
        },
      },
      TOAST_ERROR_MS,
      { key: TEXT_TOAST },
    );
  }

  readonly chooseInspiration: AppActions["chooseInspiration"] = (choice) => {
    const { project, composerText, pins } = this.kernel.state.studio;
    // What the new-piece composer already holds. With a work loaded the
    // composer holds words for that work; they stay with it (see park).
    const typed = project ? "" : composerText;
    const kept: Pins = project ? {} : pins;
    const text = cleanMessage(choice?.text);
    this.leaveWork(() => {
      // A style card writes nothing: a description that is already there
      // stays, and so do the chosen length and structure. A scenario card is
      // a complete description: it replaces the text and starts from 自动.
      const next = text || typed;
      this.kernel.dispatch({ type: "composer/text", text: next });
      this.kernel.dispatch({
        type: "composer/pins",
        pins: choice?.mood ? { ...kept, mood: choice.mood } : text ? {} : kept,
      });
      this.kernel.dispatch({ type: "ui/navigate", page: "studio" });
      this.kernel.writeSession();
      if (text && typed.trim() && typed.trim() !== text)
        this.offerText("已换成这段现成的描述。", typed, kept, next);
      else this.kernel.withdraw(TEXT_TOAST);
    });
  };

  /**
   * The loaded work is about to make room for another one (or for the empty
   * composer): keep its unapplied inspector edits, and — when the composer
   * is emptied with it (`withText`) — the words typed for it.
   */
  park(withText: boolean): void {
    const { project, draft, composerText } = this.kernel.state.studio;
    if (!project) return;
    const fields = changedFields(draft, project.config);
    const edits = Object.fromEntries(
      fields.map((field) => [field, draft[field]]),
    ) as Partial<Draft>;
    const text = withText ? composerText : "";
    if (fields.length || text.trim())
      this.parked.set(project.id, {
        ...(fields.length ? { draft: edits } : {}),
        ...(text.trim() ? { text } : {}),
      });
    else this.parked.delete(project.id);
  }

  /* ---------------- inspector ---------------- */

  readonly setDraft: AppActions["setDraft"] = (field, value) => {
    this.kernel.dispatch({ type: "draft/set", field, value });
  };

  readonly resetDraft: AppActions["resetDraft"] = (field) => {
    this.kernel.dispatch({ type: "draft/reset", ...(field ? { field } : {}) });
  };

  /* ---------------- questions ---------------- */

  /**
   * Paid audio would be lost by leaving the loaded work, and the user has
   * not dealt with that. A local work whose save failed shows the same
   * banner but is free to leave: it cost nothing, and where storage is
   * blocked for good (a private window) every single work would ask.
   */
  private needsQuestion(): boolean {
    const { studio } = this.kernel.state;
    return (
      isUnsaved(studio) &&
      !!studio.project &&
      studio.project.provider !== "local" &&
      !this.exported.has(studio.project.id)
    );
  }

  /**
   * Before an unsaved result is replaced or left: one more attempt to store
   * it, and if that fails too, the question. Resolves true when it is safe
   * (saved, exported earlier) or the user chose to leave it.
   */
  private async settleUnsaved(): Promise<boolean> {
    if (!this.needsQuestion()) return true;
    if (await this.saveLoaded(true)) return true;
    const project = this.kernel.state.studio.project;
    if (!project || !this.needsQuestion()) return true;
    const { choice } = await this.kernel.ask({
      kind: "unsaved",
      title: "付费生成的音频还没有保存",
      body: [
        joinText(
          "《",
          project.title,
          "》由",
          providerName(project.provider),
          "生成，但没能保存到「我的作品」，现在只存在于当前窗口。离开后将无法找回，重新生成需要再次付费。",
        ),
        "建议先导出原始音频，或留下来重试保存。",
      ],
      choices: [
        { id: "stay", label: "留在这首作品" },
        {
          id: "export",
          label: project.audioBlob ? "导出原始音频" : "先去导出",
          variant: "primary",
        },
        { id: "leave", label: "仍然离开", variant: "danger" },
      ],
      cancel: "stay",
    });
    if (choice === "export") {
      if (project.audioBlob) await this.exportWork({ kind: "original" });
      else this.kernel.dispatch({ type: "ui/modal", modal: "export" });
      return false;
    }
    return choice === "leave";
  }

  /** A cloud engine: ask before anything is sent. Resolves true on yes. */
  private async confirmPaid(
    provider: CloudProvider,
    refining: boolean,
  ): Promise<boolean> {
    const notice = paidNotice(provider, refining);
    if (!notice) return true;
    const { choice, remember } = await this.kernel.ask({
      kind: "paid",
      title: "发送付费生成请求？",
      body: [
        notice.text,
        "生成通常需要几十秒到几分钟。请求提交后即使取消等待，服务商仍可能计费。",
      ],
      choices: [
        { id: "cancel", label: "取消" },
        { id: "confirm", label: "发送请求", variant: "primary" },
      ],
      cancel: "cancel",
      remember: joinText("本次会话不再提示（", notice.name, "）"),
    });
    if (choice !== "confirm") return false;
    if (remember) this.paidAccepted.add(provider);
    return true;
  }

  /* ---------------- jobs ---------------- */

  private begin(
    kind: JobKind,
    provider: Provider,
    brain: BrainKind,
    stage: JobStage,
    options: {
      pendingTurn?: AgentTurn;
      restoreText?: string | null;
      progress?: number | null;
      consumed?: Draft | null;
    } = {},
  ): Running | null {
    if (this.running) return null;
    const running: Running = {
      id: ++this.jobSeq,
      kind,
      provider,
      brain,
      abort: new AbortController(),
      cancelled: false,
      restoreText: options.restoreText || null,
      consumed: options.consumed ?? null,
    };
    // The lock is taken here, synchronously, before anything can await.
    this.running = running;
    this.kernel.dispatch({
      type: "job/start",
      job: {
        id: running.id,
        kind,
        provider,
        brain,
        stage,
        phase: phaseText(stage, running),
        progress: options.progress ?? null,
        cancellable: true,
        startedAt: this.kernel.deps.now(),
      },
      pendingTurn: options.pendingTurn ?? null,
    });
    return running;
  }

  /** The job is still the running one and was not cancelled. */
  private alive(job: Running): boolean {
    return this.running === job && !job.cancelled;
  }

  private stage(
    job: Running,
    stage: JobStage,
    patch: { progress?: number | null; cancellable?: boolean } = {},
  ): void {
    if (!this.alive(job)) return;
    this.kernel.dispatch({
      type: "job/update",
      job: job.id,
      patch: {
        stage,
        phase: phaseText(stage, job),
        progress: patch.progress ?? null,
        cancellable: patch.cancellable ?? true,
      },
    });
  }

  private end(job: Running): void {
    if (this.running === job) this.running = null;
    this.kernel.dispatch({ type: "job/end", job: job.id });
  }

  readonly cancelJob: AppActions["cancelJob"] = () => {
    const running = this.running;
    const job = this.kernel.state.studio.job;
    if (!running || !job || running.cancelled || !job.cancellable) return;
    running.cancelled = true;
    this.kernel.dispatch({
      type: "job/cancel",
      job: running.id,
      phase: phaseText("cancelling", running),
    });
    running.abort.abort();
    const { desktop } = this.kernel.deps;
    try {
      // What is told to the main process follows the job that is running,
      // not whatever engine the composer shows now.
      // A download of a finished result shares the main process's one job.
      if (job.stage === "cloud" || job.stage === "downloading")
        void desktop?.cancelGeneration().catch(() => {});
      if (job.stage === "planning" && job.brain === "llm")
        void desktop?.cancelAgent().catch(() => {});
    } catch {
      /* the bridge is gone: nothing to cancel */
    }
    this.giveBackText(running);
    this.kernel.toast(cancelText(job));
  };

  /** The user's own words return to an empty composer, exactly as typed. */
  private giveBackText(job: Running): void {
    if (job.restoreText && !this.kernel.state.studio.composerText)
      this.setComposerText(job.restoreText);
  }

  /**
   * The single place where a job's result becomes the current work: state
   * first (project, audio, draft, thread and solo in one step), then the
   * player with the committed faders and no solo.
   */
  private commit(
    job: Running,
    input: {
      project: Project;
      audio: LoadedAudio | null;
      audioError: string | null;
      thread: AgentTurn[];
      notes?: Record<string, TurnNote>;
      reason: LoadEvent["reason"];
      saveState: SaveState;
      stored: boolean;
      autoplay: boolean;
      provider?: Provider;
      clearPins?: boolean;
    },
  ): boolean {
    if (!this.alive(job)) return false;
    // The outgoing work may have a fader change that is not written yet.
    this.flushMix();
    const { project, audio } = input;
    // Inspector edits the job did not use are still the user's pending edits.
    const generated = input.reason === "generated";
    const outgoing = this.kernel.state.studio.project;
    let carry: Partial<Draft> =
      generated && job.consumed
        ? carriedDraft(
            this.kernel.state.studio.draft,
            job.consumed,
            project.config,
          )
        : {};
    const carried = Object.keys(carry).length;
    // Another work takes the place of the loaded one: its unapplied edits
    // wait with it, and what was left on the incoming work comes back.
    let returned = 0;
    let returnedText = "";
    if (!generated && outgoing?.id !== project.id) {
      if (outgoing) this.park(false);
      const kept = this.parked.get(project.id);
      this.parked.delete(project.id);
      if (kept?.draft) {
        carry = kept.draft;
        returned = changedFields(
          { ...draftOf(project.config), ...kept.draft },
          project.config,
        ).length;
      }
      if (kept?.text && !this.kernel.state.studio.composerText)
        returnedText = kept.text;
    }
    this.mixFailure = null;
    this.kernel.withdraw(MIX_TOAST);
    this.kernel.withdraw(SAVE_TOAST);
    this.kernel.dispatch({
      type: "studio/loaded",
      job: job.id,
      project,
      audio,
      audioError: input.audioError,
      thread: input.thread,
      ...(input.notes ? { notes: input.notes } : {}),
      reason: input.reason,
      saveState: input.saveState,
      stored: input.stored,
      ...(carried || returned ? { carry } : {}),
      ...(input.provider ? { provider: input.provider } : {}),
      ...(input.clearPins ? { clearPins: true } : {}),
    });
    if (audio) {
      // The audition loop follows the structure of the work that arrives.
      this.kernel.player.setLoop?.(this.auditionFor(project));
      this.kernel.player.load(
        toSource(audio),
        { gains: project.config.volumes, solo: null },
        { autoplay: input.autoplay },
      );
      if (input.autoplay) this.quietUntil = this.kernel.deps.now() + 5000;
    } else this.kernel.player.unload();
    if (returnedText) this.setComposerText(returnedText);
    this.kernel.writeSession();
    if (carried)
      this.kernel.toast(
        `「声音微调」里还有 ${carried} 项没有应用的修改，已保留在新版本上。`,
      );
    if (returned)
      this.kernel.toast(
        `上次在这首作品的「声音微调」里有 ${returned} 项修改没有应用，已经放回来了。`,
      );
    return true;
  }

  /**
   * One local render for `job`: progress goes to the job, and when the
   * engine reports that the render has to wait for its worker to start
   * (`onPhase("starting")`, see audio/engine.ts) the job says that instead of
   * showing a bar that stands at 0 %.
   */
  private async render(job: Running, config: MusicConfig): Promise<StemsAudio> {
    const { deps } = this.kernel;
    let waiting = false;
    const update = (patch: { phase?: string; progress: number | null }) => {
      if (this.alive(job))
        this.kernel.dispatch({ type: "job/update", job: job.id, patch });
    };
    const rendering = (progress: number) => {
      waiting = false;
      update({ phase: phaseText("rendering", job), progress });
    };
    const onPhase: EnginePhaseListener = (phase) => {
      if (phase === "starting") {
        waiting = true;
        update({ phase: ENGINE_STARTING, progress: null });
      } else if (waiting) rendering(0);
    };
    // The engine takes more options than the port's type names; an engine
    // (or a stand-in) that does not know this one simply never calls it.
    const renderMusic: RenderMusic = (settings, options) => {
      const withPhase: NonNullable<Parameters<RenderMusic>[1]> & {
        onPhase: EnginePhaseListener;
      } = { ...options, onPhase };
      return deps.renderMusic(settings, withPhase);
    };
    return runLocal(
      config,
      {
        signal: job.abort.signal,
        onProgress: (fraction) => {
          // progress means the engine is up, whatever it last said
          if (waiting && fraction > 0) rendering(fraction);
          else update({ progress: fraction });
        },
      },
      { renderMusic },
    );
  }

  /** 循环试听 for this work: the user's choice for its structure, else the structure itself. */
  private auditionFor(project: Project): boolean {
    const { loop } = project.config;
    return (loop ? this.audition.loop : this.audition.ending) ?? loop;
  }

  readonly setLoopAudition: AppActions["setLoopAudition"] = (loop) => {
    const on = loop === true;
    const project = this.kernel.state.studio.project;
    if (project) this.audition[project.config.loop ? "loop" : "ending"] = on;
    this.kernel.player.setLoop?.(on);
  };

  /** A player was just attached: give it the loaded work, paused. */
  reloadPlayer(): void {
    const { project, audio, solo } = this.kernel.state.studio;
    if (!project || !audio) return;
    this.kernel.player.setLoop?.(this.auditionFor(project));
    this.kernel.player.load(
      toSource(audio),
      { gains: project.config.volumes, solo },
      { autoplay: false },
    );
  }

  private async generate(intent: Intent, pass: Pass = {}): Promise<boolean> {
    if (this.running || this.kernel.questioning) return false;
    const { deps } = this.kernel;
    const { studio, settings } = this.kernel.state;
    const base = studio.project;
    const provider = studio.provider;

    let text = "";
    let pinsOnly = false;
    /** the composer's own text when that is what is being sent */
    let typed: string | null = null;
    if (intent.kind === "message") {
      if (intent.text === undefined) typed = studio.composerText;
      text = cleanMessage(intent.text ?? studio.composerText);
      // A pinned style alone is a complete request for a new piece.
      pinsOnly = !base && canSendPinsOnly(text, studio.pins);
      if (!text && !pinsOnly) {
        this.kernel.toast(
          base
            ? "先告诉制作人想怎么改。"
            : "先描述一下你想要的音乐，或者选一个风格。",
        );
        return false;
      }
    } else if (!base) return false;
    if (intent.kind === "draft" && !canApplyDraft(studio)) return false;

    const refusal = engineProblem(
      provider,
      engineOptions(deps.platform, settings),
    );
    if (refusal) {
      this.kernel.refuse(refusal);
      return false;
    }

    // The new version takes the place of the loaded work. If that work exists
    // only in this window, it is saved or the user is asked first.
    if (base && pass.unsaved !== base.id && this.needsQuestion()) {
      if (!(await this.settleUnsaved())) return false;
      return this.generate(intent, { ...pass, unsaved: base.id });
    }
    // A cloud engine is a paid request: never without the user's yes. State
    // is read again afterwards — the dialog was open for as long as they liked.
    if (
      provider !== "local" &&
      pass.paid !== provider &&
      !this.paidAccepted.has(provider)
    ) {
      if (!(await this.confirmPaid(provider, !!base))) return false;
      return this.generate(intent, { ...pass, paid: provider });
    }

    // Everything the job needs is read from the current state here, before
    // the first await: the committed work, its thread, the pins, the draft.
    const brain: BrainKind =
      intent.kind === "message"
        ? activeBrain(studio.brain, brainOptions(deps.platform, settings))
        : "rules";
    const llm = brain === "llm" ? deps.desktop?.agentPlan : undefined;
    const gestureAt = deps.now();
    const nextSeed = deps.randomSeed();
    const thread = studio.thread;
    const projects = this.kernel.state.library.projects;
    // The newest version carries the whole conversation. A version made from
    // an earlier one continues the shared thread, but the producer is told
    // only the part that led to the work it is actually changing.
    const newest = base ? lineage(base, projects).latest.id === base.id : true;
    const request =
      intent.kind === "message"
        ? buildAgentRequest({
            text,
            project: base,
            thread: newest ? thread : (base?.chat ?? []),
            pins: studio.pins,
            provider,
            nextSeed,
          })
        : null;
    const direct =
      intent.kind === "draft" && base
        ? planFromDraft(base, studio.draft, provider)
        : intent.kind === "variation" && base
          ? planVariation(base, nextSeed, provider)
          : null;
    const startVolumes = base ? { ...base.config.volumes } : null;
    const mine = userTurn(
      deps.newId(),
      this.kernel.iso(),
      direct?.request ?? (text || pinsOnlyText(studio.pins)),
    );

    const job = this.begin("generate", provider, brain, "planning", {
      pendingTurn: mine,
      restoreText: typed,
      consumed: base
        ? intent.kind === "draft"
          ? studio.draft
          : draftOf(base.config)
        : null,
    });
    if (!job) return false;
    this.kernel.player.unlock();
    // Only the composer's own text leaves the composer: a ready-made phrase
    // (a chip) never erases what the user was typing.
    if (typed !== null)
      this.kernel.dispatch({ type: "composer/text", text: "" });

    let order: CloudOrder | null = null;
    try {
      let plan: AgentPlan;
      let asked = false;
      if (request) {
        for (;;) {
          const answer = await deps.producePlan(request, llm ? { llm } : {});
          if (!this.alive(job)) return false;
          plan = withStylePrompt(enforcePins(answer, request), request);
          // The language model failed and the offline rules answered. For
          // the free local engine that is a fine fallback. A paid request is
          // not made on a guess the user did not ask for: stop and ask.
          if (!plan.fallbackReason || provider === "local" || plan.unchanged)
            break;
          this.stage(job, "asking", { cancellable: false });
          const { choice } = await this.kernel.ask({
            kind: "fallback",
            title: "大模型没有给出编曲方案",
            body: [
              `${plan.fallbackReason.replace(/[，,]\s*已改用离线规则[。.]?$/, "")}。`,
              joinText(
                "可以改用离线规则的方案继续（会向",
                providerName(provider),
                "发送付费请求），重试大模型，或者取消这次生成。",
              ),
            ],
            choices: [
              { id: "cancel", label: "取消" },
              { id: "retry", label: "重试大模型" },
              { id: "rules", label: "用离线规则继续", variant: "primary" },
            ],
            cancel: "cancel",
          });
          if (!this.alive(job)) return false;
          asked = true;
          if (choice === "rules") break;
          if (choice === "retry") {
            this.stage(job, "planning");
            continue;
          }
          this.giveBackText(job);
          this.kernel.toast("已取消，没有发送生成请求。");
          return false;
        }
      } else if (direct) plan = direct.plan;
      else return false;
      // Whoever wrote the reply: it must be true for the engine that runs it
      // — drums asked for where the arrangement has none are really added,
      // a change nobody could hear is not a version, a tune that will not
      // survive is not "kept", and a loop has the tempo and length it is
      // fitted to.
      if (base && provider === "local" && base.provider === "local")
        plan = withAskedDrums(plan, base.config);
      plan = inaudiblePlan(plan, provider, base);
      plan = truthfulTiming(honestPlan(plan, provider, base), provider, base);

      const note: TurnNote = {
        ...(plan.model ? { model: plan.model } : {}),
        ...(plan.fallbackReason ? { fallbackReason: plan.fallbackReason } : {}),
      };
      const notesFor = (turn: AgentTurn) =>
        Object.keys(note).length ? { [turn.id]: note } : undefined;
      if (plan.fallbackReason && !asked) this.kernel.toast(plan.fallbackReason);

      if (plan.unchanged) {
        // Nothing audible would change: answer, generate nothing.
        const reply = agentTurn(deps.newId(), this.kernel.iso(), plan, {
          direct: !request,
        });
        this.kernel.dispatch({
          type: "thread/append",
          job: job.id,
          turns: [mine, reply],
          notes: notesFor(reply),
        });
        return false;
      }

      const limit = configProblem(provider, plan.config);
      if (limit) throw new Error(limit.message);

      const revision = nextRevisionIn(base, projects);
      if (base && !newest)
        plan = {
          ...plan,
          reasoning: [`在 v${base.revision} 的基础上修改`, ...plan.reasoning],
        };
      const reply = agentTurn(deps.newId(), this.kernel.iso(), plan, {
        revision,
        direct: !request,
      });
      const id = deps.newId();

      if (provider === "local") {
        // A new piece starts its own conversation; a refinement continues it.
        const chat = base ? [...thread, mine, reply] : [mine, reply];
        const notes = notesFor(reply);
        this.stage(job, "rendering", { progress: 0 });
        let audio = await this.render(job, plan.config);
        if (!this.alive(job)) return false;
        // The work the job started from as it is NOW: the user may have
        // renamed it or moved its faders while the job ran, and the new
        // version continues from there.
        const live = base ? (this.kernel.find(base.id) ?? base) : null;
        const volumes =
          live && startVolumes
            ? rebaseVolumes(
                plan.config.volumes,
                startVolumes,
                live.config.volumes,
              )
            : plan.config.volumes;
        if (!sameVolumes(volumes, plan.config.volumes)) {
          plan = { ...plan, config: { ...plan.config, volumes } };
          try {
            audio = { ...audio, peaks: deps.stemsOutline(audio, volumes) };
          } catch {
            /* the outline is decoration */
          }
        }
        const project = buildProject({
          id,
          now: this.kernel.iso(),
          plan,
          base: live,
          provider,
          chat,
          audioDuration: audio.duration,
          revision,
        });
        this.stage(job, "saving", { cancellable: false });
        this.commit(job, {
          project,
          audio,
          audioError: null,
          thread: chat,
          notes,
          reason: "generated",
          saveState: "saving",
          stored: false,
          autoplay: shouldAutoplay(gestureAt, deps.now()),
          clearPins: !base,
        });
        if (await this.saveNew(project))
          this.kernel.toast("创作完成，已保存到「我的作品」");
        return true;
      }

      const bridge = deps.desktop;
      if (!bridge) throw new Error("云端生成只在 Windows 桌面版中可用。");
      // A new request replaces a result that was still waiting to be
      // fetched: the main process drops it when this one takes its lock.
      this.forgetDownload();
      order = {
        provider,
        plan,
        prompt: plan.cloudPrompt ?? buildCloudPrompt(plan.config, base?.config),
        model: settings.providers[provider]?.model,
        base,
        thread: base ? thread : [],
        mine,
        note,
        direct: !request,
        typed,
      };
      this.stage(job, "cloud");
      return await this.receive(job, order, bridge.generateMusic, {
        reply,
        id,
        revision,
        gestureAt,
      });
    } catch (error) {
      logDetail(error);
      // The service has the music; only its file is missing. Asking again
      // would be a second paid request — offer to fetch it instead, also
      // when it was the user who stopped waiting.
      const stopped = errorText(error, "");
      const fetchable =
        order !== null &&
        !!deps.desktop?.retryLastDownload &&
        DOWNLOAD_STOPPED.test(stopped);
      if (this.alive(job)) {
        const message = errorText(
          error,
          provider === "local"
            ? "本地作曲引擎出错了，请换个描述或参数再试。"
            : joinText(providerName(provider), "没有返回音乐，请稍后重试。"),
        );
        if (base)
          this.kernel.dispatch({
            type: "thread/append",
            job: job.id,
            turns: [
              mine,
              failureTurn(
                deps.newId(),
                this.kernel.iso(),
                fetchable ? message : `这次没有生成成功：${message}`,
              ),
            ],
          });
        if (!fetchable) this.kernel.toast(`生成失败：${message}`, "error");
        this.giveBackText(job);
      }
      if (order && fetchable) this.offerDownload(order, stopped);
      return false;
    } finally {
      this.end(job);
    }
  }

  /* ---------------- cloud results ---------------- */

  /**
   * Take delivery of the result of a cloud request: wait for `fetch` (the
   * paid request itself, or a repeated download of what it produced), store
   * the bytes, decode them, and make the new version the current work.
   * Rejects when the service gave no usable audio.
   */
  private async receive(
    job: Running,
    order: CloudOrder,
    fetch: DesktopAPI["generateMusic"],
    made: { reply: AgentTurn; id: string; revision: number; gestureAt: number },
  ): Promise<boolean> {
    const { deps } = this.kernel;
    const { provider, plan, prompt, model, base } = order;
    const { reply, id, revision } = made;
    // A new piece starts its own conversation; a refinement continues it.
    const chat = base
      ? [...order.thread, order.mine, reply]
      : [order.mine, reply];
    const notes = Object.keys(order.note).length
      ? { [reply.id]: order.note }
      : undefined;
    /** The work the request started from as it is NOW (renamed, remixed). */
    const liveBase = () => (base ? (this.kernel.find(base.id) ?? base) : null);
    const build = (blob?: Blob) =>
      buildProject({
        id,
        now: this.kernel.iso(),
        plan,
        base: liveBase(),
        provider,
        chat,
        cloud: { prompt, ...(model ? { model } : {}) },
        revision,
        ...(blob ? { audioBlob: blob } : {}),
      });
    let project = build();
    let saveError: unknown = null;
    const result = await runCloud(
      { provider, prompt, duration: plan.config.duration },
      {
        // From here on the audio is paid for: the job cannot be cancelled,
        // and the bytes are stored before anything tries to decode them.
        onReceived: () => this.stage(job, "saving", { cancellable: false }),
        persist: async ({ blob }) => {
          project = build(blob);
          try {
            await this.kernel.store(project);
            return true;
          } catch (error) {
            saveError = error;
            return false;
          }
        },
        onDecoding: () => this.stage(job, "decoding", { cancellable: false }),
        wanted: () => this.alive(job),
      },
      {
        generateMusic: fetch,
        decode: deps.decode,
        ...(deps.mixPeaks ? { mixPeaks: deps.mixPeaks } : {}),
      },
    );
    // The file is here: nothing is left to fetch.
    if (this.undelivered === order) this.forgetDownload();
    if (result.saved) {
      this.kernel.dispatch({ type: "library/upsert", project });
      this.kernel.afterSave();
    }
    if (!this.alive(job)) {
      // Cancelled while the answer was already on its way: the paid audio
      // is kept in the library, the current work is not touched.
      if (result.saved)
        this.kernel.toast("云端结果在取消后到达，已保存到「我的作品」。");
      else this.keepStray(project, saveError);
      return false;
    }
    if (result.audio) {
      project = { ...project, audioDuration: result.audio.duration };
      if (result.saved) {
        this.kernel.dispatch({ type: "library/upsert", project });
        // Only the length is new; if this write fails the next open repeats it.
        void this.kernel
          .patch(project.id, { audioDuration: result.audio.duration })
          .catch(() => {});
      }
    }
    this.commit(job, {
      project,
      audio: result.audio,
      audioError: result.audio
        ? null
        : result.saved
          ? DECODE_FAILED
          : DECODE_FAILED_UNSAVED,
      thread: chat,
      notes,
      reason: "generated",
      saveState: result.saved ? "saved" : "failed",
      stored: result.saved,
      autoplay: shouldAutoplay(made.gestureAt, deps.now()),
      clearPins: !base,
    });
    if (!result.saved) {
      // The only copy is in this window: say so, say what to do first, and
      // try the library once more on our own.
      this.kernel.toast(
        `音乐已生成，但没能保存到「我的作品」：${errorText(saveError, WRITE_FAILED)}音频还在当前窗口，请先导出原始音频；稍后会自动再试一次保存。`,
        "error",
        undefined,
        undefined,
        { key: SAVE_TOAST },
      );
      this.scheduleRetry(project.id);
    } else if (!result.audio) this.kernel.toast(DECODE_FAILED, "error");
    else this.kernel.toast("创作完成，已保存到「我的作品」");
    return true;
  }

  /**
   * The service finished `order` but its file did not arrive: keep the order
   * and offer 重新下载 for as long as the notice stays on screen. `reason` is
   * the main process's own account (it names the task for the console).
   */
  private offerDownload(order: CloudOrder, reason: string): void {
    this.undelivered = order;
    this.kernel.toast(
      `${reason}也可以点「重新下载」再取一次，不会再次计费。`,
      "error",
      { label: "重新下载", run: () => void this.fetchAgain() },
      undefined,
      { key: DOWNLOAD_TOAST, sticky: true },
    );
    this.kernel.riskChanged();
  }

  private forgetDownload(): void {
    if (!this.undelivered) return;
    this.undelivered = null;
    this.kernel.withdraw(DOWNLOAD_TOAST);
    this.kernel.riskChanged();
  }

  /** The offer is still on screen (closing its notice declines it). */
  private downloadOffered(): boolean {
    return (
      this.undelivered !== null &&
      this.kernel.state.ui.toasts.some((toast) => toast.key === DOWNLOAD_TOAST)
    );
  }

  /**
   * 重新下载: fetch the finished result of the last cloud request again and
   * treat it exactly like a fresh one — stored first, then decoded, then the
   * current work. Nothing is submitted to the service and nothing is billed.
   */
  private async fetchAgain(): Promise<boolean> {
    const order = this.undelivered;
    const bridge = this.kernel.deps.desktop;
    if (!order || !bridge) return false;
    // The click closes the notice; whenever the download cannot start, or
    // fails again, the offer is put back.
    const waiting = joinText(
      providerName(order.provider),
      "已经生成的音乐还没有下载下来。",
    );
    if (this.running || this.kernel.questioning) {
      this.kernel.toast(BUSY);
      this.offerDownload(order, waiting);
      return false;
    }
    // The result takes the place of the loaded work, like any new version.
    if (this.needsQuestion() && !(await this.settleUnsaved())) {
      this.offerDownload(order, waiting);
      return false;
    }
    const { deps } = this.kernel;
    const gestureAt = deps.now();
    const job = this.begin("generate", order.provider, "rules", "downloading");
    if (!job) {
      this.offerDownload(order, waiting);
      return false;
    }
    this.kernel.player.unlock();
    try {
      // Versions made since the request keep their numbers.
      const revision = nextRevisionIn(
        order.base,
        this.kernel.state.library.projects,
      );
      const reply = agentTurn(deps.newId(), this.kernel.iso(), order.plan, {
        revision,
        direct: order.direct,
      });
      const delivered = await this.receive(
        job,
        order,
        () => bridge.retryLastDownload(order.provider),
        { reply, id: deps.newId(), revision, gestureAt },
      );
      // The words that were handed back for another try have been answered.
      if (
        delivered &&
        order.typed !== null &&
        this.kernel.state.studio.composerText === order.typed
      )
        this.setComposerText("");
      return delivered;
    } catch (error) {
      const message = errorText(error, "下载没有成功，请稍后重试。");
      if (DOWNLOAD_GONE.test(message)) {
        this.forgetDownload();
        this.kernel.toast(message, "error");
      } else
        // Cancelled, timed out or failed again: the result is still there.
        this.offerDownload(
          order,
          DOWNLOAD_STOPPED.test(message) ? message : `${waiting}${message}`,
        );
      return false;
    } finally {
      this.end(job);
    }
  }

  /* ---------------- opening ---------------- */

  readonly openProject: AppActions["openProject"] = (id, options) =>
    this.open(id, { reason: "opened", autoplay: options?.autoplay === true });

  async open(
    id: string,
    options: { reason: LoadEvent["reason"]; autoplay: boolean },
  ): Promise<boolean> {
    const { deps } = this.kernel;
    const { studio, library } = this.kernel.state;
    if (studio.project?.id === id && studio.audio && !this.running) {
      // Already loaded: no need to render or decode it again.
      this.kernel.dispatch({ type: "ui/navigate", page: "studio" });
      if (options.autoplay) void this.kernel.player.play();
      return true;
    }
    const item = library.projects.find((work) => work.id === id);
    if (!item) {
      this.kernel.toast("找不到这首作品，它可能已被删除。", "error");
      return false;
    }
    if (this.running) {
      this.kernel.toast(BUSY);
      return false;
    }
    if (this.kernel.questioning) return false;
    // The work on screen exists only in this window: save it or ask.
    if (this.needsQuestion()) {
      if (!(await this.settleUnsaved())) return false;
      if (this.running) return false;
    }
    const local = item.provider === "local";
    const gestureAt = deps.now();
    const job = this.begin(
      "open",
      item.provider,
      "rules",
      local ? "rendering" : "decoding",
      { progress: local ? 0 : null },
    );
    if (!job) return false;
    if (options.autoplay) this.kernel.player.unlock();
    if (options.reason === "opened")
      this.kernel.dispatch({ type: "ui/navigate", page: "studio" });
    try {
      let audio: LoadedAudio | null = null;
      let audioError: string | null = null;
      if (local) {
        // config.engine picks the engine: v0.2 works go through the legacy one.
        audio = await this.render(job, item.config);
      } else if (!item.audioBlob) audioError = AUDIO_MISSING;
      else {
        // Cloud audio is only ever decoded from its stored bytes; opening a
        // work never calls a paid service.
        try {
          audio = await decodeBlob(item.audioBlob, {
            decode: deps.decode,
            ...(deps.mixPeaks ? { mixPeaks: deps.mixPeaks } : {}),
          });
        } catch {
          audioError = DECODE_FAILED;
        }
      }
      if (!this.alive(job)) return false;
      // The list may have changed while the audio was prepared.
      const now = this.kernel.state;
      const latest =
        now.library.projects.find((work) => work.id === id) ?? item;
      const fix =
        audio && durationChanged(latest.audioDuration, audio.duration);
      const project: Project =
        audio && fix ? { ...latest, audioDuration: audio.duration } : latest;
      const engines = engineOptions(deps.platform, now.settings);
      this.commit(job, {
        project,
        audio,
        audioError,
        // Versions of one piece share one conversation: an earlier version
        // opens with everything that was said since, not only its own part.
        thread: lineage(project, now.library.projects).thread,
        reason: options.reason,
        saveState: "idle",
        stored: true,
        autoplay:
          options.autoplay && !!audio && shouldAutoplay(gestureAt, deps.now()),
        // Refinements continue on the work's own engine when it is usable.
        provider: engineProblem(project.provider, engines)
          ? "local"
          : project.provider,
      });
      if (audioError) this.kernel.toast(audioError, "error");
      if (fix && audio) {
        this.kernel.dispatch({
          type: "project/patch",
          id,
          patch: { audioDuration: project.audioDuration },
        });
        void this.kernel
          .patch(id, { audioDuration: audio.duration })
          .catch(() => {});
      }
      return true;
    } catch (error) {
      logDetail(error);
      if (this.alive(job))
        this.kernel.toast(
          `打开失败：${errorText(error, "这首作品暂时无法重建，请稍后重试。")}`,
          "error",
        );
      return false;
    } finally {
      this.end(job);
    }
  }

  /* ---------------- mixer ---------------- */

  private syncMix(): void {
    const { project, solo } = this.kernel.state.studio;
    if (project) this.kernel.player.setMix(project.config.volumes, solo);
  }

  /** A fader of the loaded work was set: it is owed to the library. */
  private owe(track: TrackName): void {
    const project = this.kernel.state.studio.project;
    if (!project) return;
    let tracks = this.unconfirmed.get(project.id);
    if (!tracks) this.unconfirmed.set(project.id, (tracks = new Map()));
    tracks.set(track, project.config.volumes[track]);
  }

  readonly setVolume: AppActions["setVolume"] = (track, value) => {
    const before = this.kernel.state.studio.project;
    this.kernel.dispatch({
      type: "mix/volume",
      track,
      value: clampVolume(value),
    });
    if (this.kernel.state.studio.project === before) return;
    this.owe(track);
    this.syncMix();
    this.mixSchedule = scheduleChange(
      this.kernel.deps.now(),
      MIX_SAVE_DELAY_MS,
    );
    this.armMix();
  };

  readonly commitMix: AppActions["commitMix"] = () => {
    this.flushMix();
  };

  readonly toggleMute: AppActions["toggleMute"] = (track) => {
    const before = this.kernel.state.studio.project;
    this.kernel.dispatch({
      type: "mix/mute",
      track,
      fallback: REFERENCE_VOLUMES[track],
    });
    if (this.kernel.state.studio.project === before) return;
    this.owe(track);
    this.syncMix();
    this.mixSchedule = scheduleChange(this.kernel.deps.now(), 0);
    this.armMix();
  };

  readonly toggleSolo: AppActions["toggleSolo"] = (track) => {
    this.kernel.dispatch({
      type: "studio/solo",
      track: this.kernel.state.studio.solo === track ? null : track,
    });
    // Audition only: nothing is saved and nothing is re-rendered.
    this.syncMix();
  };

  /** Write a pending fader change now (before a work is switched or removed). */
  flushMix(): void {
    if (this.mixSchedule.dueAt === null) return;
    this.mixSchedule = scheduleRelease(
      this.mixSchedule,
      this.kernel.deps.now(),
    );
    this.armMix();
  }

  /**
   * The page is being hidden or closed. A database write started now may
   * never finish, so every fader position the library has not confirmed is
   * noted in the session (a synchronous write) before the normal save is
   * started; the next start applies whatever is still noted.
   */
  noteMixes(): void {
    const at = this.kernel.deps.now();
    for (const [id, tracks] of this.unconfirmed) {
      const current = this.kernel.state.studio.project;
      // A work that never reached the library has no record to patch.
      if (current?.id === id && !this.kernel.state.studio.stored) continue;
      if (tracks.size)
        this.kernel.pendingMixes.set(id, {
          id,
          volumes: Object.fromEntries(tracks),
          at,
        });
    }
  }

  /**
   * Fader positions a page noted down before it went away: apply them to the
   * stored works now, before the library is read. A note older than the
   * record's last change is dropped — something newer was saved since.
   */
  async applyNotedMixes(): Promise<void> {
    const { mixes } = this.kernel.readNotes();
    if (!mixes.length) return;
    const now = this.kernel.deps.now();
    for (const note of mixes) {
      try {
        await this.kernel.patch(
          note.id,
          {
            volumes: note.volumes,
            updatedAt: new Date(note.at).toISOString(),
          },
          { unlessNewer: true },
        );
      } catch {
        // The library cannot be written right now: try again next time,
        // unless the note is hopelessly old.
        if (now - note.at < NOTE_MAX_AGE_MS) continue;
      }
      this.kernel.settleMix(note.id);
    }
    this.kernel.writeSession();
  }

  private armMix(): void {
    const { timers } = this.kernel.deps;
    if (this.mixTimer !== null) {
      timers.clear(this.mixTimer);
      this.mixTimer = null;
    }
    const wait = waitFor(this.mixSchedule, this.kernel.deps.now());
    if (wait === null) return;
    if (wait === 0) {
      this.mixSchedule = IDLE;
      void this.saveMix();
      return;
    }
    this.mixTimer = timers.set(() => {
      this.mixTimer = null;
      if (isDue(this.mixSchedule, this.kernel.deps.now())) {
        this.mixSchedule = IDLE;
        void this.saveMix();
      } else this.armMix();
    }, wait);
  }

  /** Write the committed faders of the current work and refresh its outline. */
  private async saveMix(): Promise<void> {
    const { project, audio, stored } = this.kernel.state.studio;
    if (!project) return;
    const updatedAt = this.kernel.iso();
    this.kernel.dispatch({
      type: "project/patch",
      id: project.id,
      patch: { updatedAt },
    });
    if (audio?.kind === "stems") {
      try {
        this.kernel.dispatch({
          type: "studio/peaks",
          id: project.id,
          peaks: this.kernel.deps.stemsOutline(audio, project.config.volumes),
        });
      } catch {
        /* the outline is decoration; the save matters */
      }
    }
    await this.saveCurrent(project.id, updatedAt, stored);
  }

  /* ---------------- saving ---------------- */

  /** One automatic retry, a moment after a first save failed. */
  private scheduleRetry(id: string): void {
    this.kernel.deps.timers.set(() => void this.autoRetry(id), SAVE_RETRY_MS);
  }

  private async autoRetry(id: string): Promise<void> {
    const stray = this.strays.get(id);
    if (stray) {
      try {
        await this.kernel.store(stray);
      } catch {
        return; // the notice with 导出原始音频 stays
      }
      this.strays.delete(id);
      this.kernel.riskChanged();
      this.kernel.withdraw(`stray-${id}`);
      this.kernel.dispatch({ type: "library/upsert", project: stray });
      this.kernel.afterSave();
      this.kernel.toast("刚才没能保存的云端结果已保存到「我的作品」。");
      return;
    }
    const { studio } = this.kernel.state;
    if (studio.project?.id === id && isUnsaved(studio))
      await this.saveLoaded(true);
  }

  /**
   * A paid result that arrived after its job was cancelled and could not be
   * stored: it is not loaded, but it is not dropped either.
   */
  private keepStray(project: Project, saveError: unknown): void {
    if (!project.audioBlob) return;
    this.strays.set(project.id, project);
    this.kernel.riskChanged();
    this.kernel.toast(
      `云端结果在取消后到达，但没能保存到「我的作品」：${errorText(saveError, WRITE_FAILED)}音频还在当前窗口，请先导出；稍后会自动再试一次保存。`,
      "error",
      { label: "导出原始音频", run: () => void this.exportStray(project.id) },
      undefined,
      { key: `stray-${project.id}`, sticky: true },
    );
    this.scheduleRetry(project.id);
  }

  private async exportStray(id: string): Promise<void> {
    const project = this.strays.get(id);
    if (!project) return;
    try {
      const result = await exportWork(
        project,
        null,
        { kind: "original" },
        this.kernel.deps.exporter,
      );
      if (!result.saved) return;
      // The user has the bytes: nothing is at risk any more.
      this.strays.delete(id);
      this.kernel.riskChanged();
      this.kernel.withdraw(`stray-${id}`);
      this.kernel.toast(
        this.kernel.deps.platform.isDesktop
          ? "已导出到选定位置"
          : `已开始下载「${result.name}」`,
      );
    } catch (error) {
      this.kernel.toast(errorText(error, "导出失败，请重试。"), "error");
    }
  }

  /** First save of a freshly generated local work. */
  private async saveNew(project: Project): Promise<boolean> {
    try {
      await this.kernel.store(this.kernel.find(project.id) ?? project);
    } catch (error) {
      this.kernel.dispatch({
        type: "studio/saveState",
        id: project.id,
        saveState: "failed",
      });
      this.kernel.toast(
        `音乐已生成，但没能保存到「我的作品」：${errorText(error, WRITE_FAILED)}它只存在于当前窗口，请先导出；稍后会自动再试一次保存。`,
        "error",
        undefined,
        undefined,
        { key: SAVE_TOAST },
      );
      this.scheduleRetry(project.id);
      return false;
    }
    this.landed(project.id, project);
    return true;
  }

  /** A whole work reached the library: list it and mark it stored. */
  landed(id: string, fallback: Project): void {
    // The work may have changed while it was written (a fader, the title).
    this.kernel.dispatch({
      type: "library/upsert",
      project: this.kernel.find(id) ?? fallback,
    });
    this.kernel.dispatch({
      type: "studio/saveState",
      id,
      saveState: "saved",
      stored: true,
    });
    this.kernel.withdraw(SAVE_TOAST);
    this.exported.delete(id);
    this.kernel.afterSave();
  }

  readonly retrySave: AppActions["retrySave"] = () => this.saveLoaded(false);

  /**
   * Store the loaded work whose save failed. `quiet`: an automatic attempt —
   * a failure adds no new notice (the banner is already there).
   */
  private async saveLoaded(quiet: boolean): Promise<boolean> {
    const { project, stored, saveState } = this.kernel.state.studio;
    if (!project) return false;
    if (saveState !== "failed") return stored;
    const { id } = project;
    if (stored) {
      // In the library, but its last fader write failed: send those again.
      this.mixSchedule = IDLE;
      return this.saveCurrent(id, this.kernel.iso(), true, quiet);
    }
    // The state stays "failed" until the write has really succeeded: the
    // unsaved-result banner must not blink away during an attempt.
    try {
      await this.kernel.store(this.kernel.find(id) ?? project);
    } catch (error) {
      if (!quiet)
        this.kernel.toast(
          `还是没能保存：${errorText(error, WRITE_FAILED)}`,
          "error",
          undefined,
          undefined,
          { key: SAVE_TOAST },
        );
      return false;
    }
    this.unconfirmed.delete(id);
    this.landed(id, project);
    this.kernel.toast("已保存到「我的作品」");
    return true;
  }

  /**
   * Save the faders of a work. A stored work gets only the faders that were
   * moved, merged into its record; a work that never reached the library is
   * stored whole.
   */
  private async saveCurrent(
    id: string,
    updatedAt: string,
    stored: boolean,
    quiet = false,
  ): Promise<boolean> {
    const report = (saveState: SaveState, landed?: boolean) =>
      this.kernel.dispatch({
        type: "studio/saveState",
        id,
        saveState,
        ...(landed ? { stored: true } : {}),
      });
    const project = this.kernel.find(id);
    if (!project) return false;
    const owed = this.unconfirmed.get(id);
    const sent = new Map(owed ?? []);
    for (const track of sent.keys())
      sent.set(track, project.config.volumes[track]);
    report("saving");
    let merged: Project | null = project;
    try {
      if (stored) {
        merged = await this.kernel.patch(id, {
          volumes: Object.fromEntries(
            sent.size
              ? sent
              : TRACKS.map((track) => [track, project.config.volumes[track]]),
          ),
          updatedAt,
        });
      } else await this.kernel.store({ ...project, updatedAt });
    } catch (error) {
      report("failed");
      // One notice for as long as the library refuses this work's faders —
      // not one per gesture. The save indicator carries the state.
      if (!quiet && this.mixFailure !== id) {
        this.mixFailure = id;
        this.kernel.toast(
          `混音没有保存：${errorText(error, WRITE_FAILED)}之后的调整会继续尝试保存。`,
          "error",
          undefined,
          undefined,
          { key: MIX_TOAST, sticky: true },
        );
      }
      return false;
    }
    if (this.mixFailure === id) this.mixFailure = null;
    this.kernel.withdraw(MIX_TOAST);
    // What was written is no longer owed — unless the fader moved again.
    for (const [track, value] of sent)
      if (owed?.get(track) === value) owed.delete(track);
    if (owed && owed.size === 0) this.unconfirmed.delete(id);
    if (this.kernel.pendingMixes.has(id) && !this.unconfirmed.has(id)) {
      this.kernel.settleMix(id);
      this.kernel.writeSession();
    }
    if (!merged) {
      // Deleted in another tab while it was open here: it stays deleted.
      this.gone(id);
      return false;
    }
    if (stored) this.absorb(merged);
    const removing = this.kernel.state.library.removing.some(
      (entry) => entry.project.id === id,
    );
    if (!removing)
      this.kernel.dispatch({
        type: "library/upsert",
        project: this.kernel.find(id) ?? project,
      });
    if (!stored) {
      // The whole work reached the library with this write.
      this.kernel.withdraw(SAVE_TOAST);
      this.exported.delete(id);
    }
    // A newer change may already be waiting; its own write reports again.
    if (this.mixSchedule.dueAt === null) report("saved", true);
    else if (!stored) report("saving", true);
    this.kernel.afterSave();
    return true;
  }

  /* ---------------- other tabs ---------------- */

  /**
   * Take over what the library holds for a work — it was changed by a write
   * of ours that merged with another tab's, or by another tab. Fields named
   * in `except` and faders this tab still owes the library keep the values
   * in memory.
   */
  absorb(stored: Project, except: readonly (keyof Project)[] = []): void {
    const mine = this.kernel.find(stored.id);
    const waiting = this.kernel.state.library.removing.some(
      (entry) => entry.project.id === stored.id,
    );
    if (waiting) return;
    if (!mine) {
      this.kernel.dispatch({ type: "library/upsert", project: stored });
      return;
    }
    const owed = this.unconfirmed.get(stored.id);
    const volumes = { ...stored.config.volumes };
    for (const track of owed?.keys() ?? [])
      volumes[track] = mine.config.volumes[track];
    const remixed = !sameVolumes(volumes, mine.config.volumes);
    // A field this tab is still writing is newer in memory than in storage.
    const keep = (field: keyof Project) =>
      except.includes(field) || this.kernel.holding(stored.id, field);
    const patch: Partial<Project> = {
      ...(keep("title") ? {} : { title: stored.title }),
      ...(keep("favorite") ? {} : { favorite: stored.favorite }),
      ...(stored.audioDuration !== undefined && !keep("audioDuration")
        ? { audioDuration: stored.audioDuration }
        : {}),
      ...(Date.parse(stored.updatedAt) > Date.parse(mine.updatedAt)
        ? { updatedAt: stored.updatedAt }
        : {}),
      ...(remixed ? { config: { ...mine.config, volumes } } : {}),
    };
    const changed = (Object.keys(patch) as (keyof Project)[]).some(
      (key) => patch[key] !== mine[key],
    );
    if (!changed) return;
    this.kernel.dispatch({ type: "project/patch", id: stored.id, patch });
    if (remixed && this.kernel.state.studio.project?.id === stored.id)
      this.syncMix();
  }

  /**
   * A work no longer exists in the library (another tab deleted it for
   * good). It leaves the list, and the studio if it was loaded there — as
   * with a deletion made in this tab.
   */
  gone(id: string): void {
    const { studio } = this.kernel.state;
    const work = this.kernel.find(id);
    const current = studio.project?.id === id && !this.running;
    this.unconfirmed.delete(id);
    if (this.kernel.pendingMixes.has(id)) this.kernel.settleMix(id);
    if (current) {
      this.mixSchedule = IDLE;
      if (this.mixTimer !== null) {
        this.kernel.deps.timers.clear(this.mixTimer);
        this.mixTimer = null;
      }
      this.kernel.player.unload();
    }
    this.kernel.dispatch({ type: "library/gone", id });
    if (current) {
      this.restoreEngine();
      this.kernel.writeSession();
    }
    if (work && (current || studio.project?.id === id))
      this.kernel.toast(`《${work.title}》已在另一个窗口中删除。`);
  }

  /* ---------------- leaving the page ---------------- */

  /**
   * Why closing the page now would lose something that was paid for, or
   * null: an unsaved cloud result, a cloud request that is on its way, or a
   * finished result that still has to be downloaded.
   */
  closeRisk(): string | null {
    const { studio } = this.kernel.state;
    const { job, project } = studio;
    if (
      (isUnsaved(studio) &&
        project?.provider !== "local" &&
        !!project &&
        !this.exported.has(project.id)) ||
      this.strays.size > 0
    )
      return "付费生成的音频还没有保存到「我的作品」，现在关闭将无法找回。请先导出原始音频。";
    if (
      job?.kind === "generate" &&
      job.provider !== "local" &&
      (job.stage === "cloud" ||
        job.stage === "saving" ||
        job.stage === "decoding")
    )
      return "正在生成付费音乐，现在关闭可能仍会计费且得不到结果。";
    // The address of a finished result lives only in this run of the app.
    if (job?.stage === "downloading" || this.downloadOffered())
      return "云端已经生成的音乐还没有下载下来，现在关闭将无法再取回，重新生成需要再次付费。";
    return null;
  }

  /* ---------------- export ---------------- */

  readonly exportWork: AppActions["exportWork"] = async (request) => {
    // Always the committed work: its faders, its stems, its stored bytes.
    const { project, audio, exporting } = this.kernel.state.studio;
    if (!project || exporting) return false;
    this.kernel.dispatch({ type: "studio/exporting", exporting: true });
    try {
      const result = await exportWork(
        project,
        audio,
        request,
        this.kernel.deps.exporter,
      );
      if (result.saved) {
        // An unsaved result the user now holds a copy of: the audio itself
        // (or, for a local work, its recipe) is out of danger.
        if (
          !this.kernel.state.studio.stored &&
          (project.provider === "local" || request.kind !== "project")
        )
          this.exported.add(project.id);
        this.kernel.riskChanged();
        this.kernel.toast(
          this.kernel.deps.platform.isDesktop
            ? "已导出到选定位置"
            : `已开始下载「${result.name}」`,
        );
      }
      return result.saved;
    } catch (error) {
      this.kernel.toast(errorText(error, "导出失败，请重试。"), "error");
      return false;
    } finally {
      this.kernel.dispatch({ type: "studio/exporting", exporting: false });
    }
  };
}
