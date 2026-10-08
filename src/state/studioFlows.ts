/**
 * The studio's flows: composer, inspector, the one running job (producing or
 * opening), mixer and export. No React.
 *
 * Concurrency rules (kept from v0.2 S05, now structural):
 *  - `running` is the synchronous job lock; a second job is refused, never
 *    queued. Each job has an id; `alive(job)` is false once it was cancelled.
 *  - A job changes the current work only through `commit()` and through
 *    reducer actions that carry its id — both ignore a job that is not alive.
 *  - Actions read the kernel's state when they run. Nothing is captured in
 *    closures across an await except values that were deliberately
 *    snapshotted before the job started.
 */
import { buildCloudPrompt } from "../agent/cloudPrompt";
import type { AgentPlan, AgentTurn, BrainKind } from "../agent/types";
import { REFERENCE_VOLUMES } from "../audio/render-types";
import type { PlayerSource } from "../player/usePlayer";
import { providerName } from "../providers";
import { exportWork } from "../services/exporter";
import { decodeBlob, runCloud, runLocal } from "../services/generation";
import type { Project, Provider } from "../types";
import { BUSY, WRITE_FAILED } from "./kernel";
import type { Kernel } from "./kernel";
import {
  IDLE,
  MIX_SAVE_DELAY_MS,
  agentTurn,
  buildProject,
  cleanMessage,
  clampVolume,
  durationChanged,
  errorText,
  failureTurn,
  isDue,
  joinText,
  nextRevision,
  scheduleChange,
  scheduleRelease,
  shouldAutoplay,
  userTurn,
  waitFor,
} from "./logic";
import type { Schedule } from "./logic";
import {
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
  enforcePins,
  planFromDraft,
  planVariation,
} from "./plan";
import { canApplyDraft } from "./selectors";
import type {
  AppActions,
  JobKind,
  JobStage,
  LoadEvent,
  LoadedAudio,
  SaveState,
  TurnNote,
} from "./types";

const DECODE_FAILED =
  "这段音频无法解码试听。它仍然保存在作品库中，可以在「导出」里保存原始音频。";
const AUDIO_MISSING = "这首作品的音频文件不可用。";

interface Running {
  id: number;
  kind: JobKind;
  provider: Provider;
  brain: BrainKind;
  abort: AbortController;
  cancelled: boolean;
  /** composer text to give back when the job is cancelled or fails */
  restoreText: string | null;
}

type Intent =
  | { kind: "message"; text?: string }
  | { kind: "draft" }
  | { kind: "variation" };

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
            ? { message: "大模型制作人只在 Windows 桌面版中可用。" }
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

  readonly applyDraft: AppActions["applyDraft"] = () =>
    this.generate({ kind: "draft" });

  readonly variation: AppActions["variation"] = () =>
    this.generate({ kind: "variation" });

  /** Leave the current work (it stays in the library) for the empty state. */
  private leaveWork(): boolean {
    if (this.running) {
      this.kernel.toast(BUSY);
      return false;
    }
    if (this.kernel.state.studio.project) {
      this.flushMix();
      this.kernel.player.unload();
    }
    this.kernel.dispatch({ type: "studio/unloaded" });
    this.restoreEngine();
    return true;
  }

  readonly newPiece: AppActions["newPiece"] = () => {
    if (!this.leaveWork()) return false;
    this.kernel.dispatch({ type: "ui/navigate", page: "studio" });
    this.kernel.writeSession();
    return true;
  };

  readonly chooseInspiration: AppActions["chooseInspiration"] = (
    choice,
  ) => {
    if (!this.leaveWork()) return;
    this.kernel.dispatch({
      type: "composer/text",
      text: cleanMessage(choice?.text),
    });
    this.kernel.dispatch({
      type: "composer/pins",
      pins: choice?.mood ? { mood: choice.mood } : {},
    });
    this.kernel.dispatch({ type: "ui/navigate", page: "studio" });
    this.kernel.writeSession();
  };

  /* ---------------- inspector ---------------- */

  readonly setDraft: AppActions["setDraft"] = (field, value) => {
    this.kernel.dispatch({ type: "draft/set", field, value });
  };

  readonly resetDraft: AppActions["resetDraft"] = (field) => {
    this.kernel.dispatch({ type: "draft/reset", ...(field ? { field } : {}) });
  };

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
      restoreText: options.restoreText ?? null,
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
      if (job.stage === "cloud")
        void desktop?.cancelGeneration().catch(() => {});
      if (job.stage === "planning" && job.brain === "llm")
        void desktop?.cancelAgent().catch(() => {});
    } catch {
      /* the bridge is gone: nothing to cancel */
    }
    this.giveBackText(running);
    this.kernel.toast(cancelText(job));
  };

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
      autoplay: boolean;
      provider?: Provider;
      clearPins?: boolean;
    },
  ): boolean {
    if (!this.alive(job)) return false;
    // The outgoing work may have a fader change that is not written yet.
    this.flushMix();
    const { project, audio } = input;
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
      ...(input.provider ? { provider: input.provider } : {}),
      ...(input.clearPins ? { clearPins: true } : {}),
    });
    if (audio) {
      this.kernel.player.load(
        toSource(audio),
        { gains: project.config.volumes, solo: null },
        { autoplay: input.autoplay },
      );
      if (input.autoplay) this.quietUntil = this.kernel.deps.now() + 5000;
    } else this.kernel.player.unload();
    this.kernel.writeSession();
    return true;
  }

  /** A player was just attached: give it the loaded work, paused. */
  reloadPlayer(): void {
    const { project, audio, solo } = this.kernel.state.studio;
    if (!project || !audio) return;
    this.kernel.player.load(
      toSource(audio),
      { gains: project.config.volumes, solo },
      { autoplay: false },
    );
  }

  private async generate(intent: Intent): Promise<boolean> {
    if (this.running) return false;
    const { deps } = this.kernel;
    const { studio, settings } = this.kernel.state;
    const base = studio.project;
    const provider = studio.provider;

    let text = "";
    if (intent.kind === "message") {
      text = cleanMessage(intent.text ?? studio.composerText);
      if (!text) {
        this.kernel.toast(
          base
            ? "先告诉制作人想怎么改。"
            : "先描述一下你想要的音乐吧。",
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

    // Everything the job needs is read from the current state here, before
    // the first await: the committed work, its thread, the pins, the draft.
    const brain: BrainKind =
      intent.kind === "message"
        ? activeBrain(studio.brain, brainOptions(deps.platform, settings))
        : "rules";
    const llm = brain === "llm" ? deps.desktop?.agentPlan : undefined;
    const gestureAt = deps.now();
    const nextSeed = deps.randomSeed();
    const request =
      intent.kind === "message"
        ? buildAgentRequest({
            text,
            project: base,
            thread: studio.thread,
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
    const thread = studio.thread;
    const mine = userTurn(
      deps.newId(),
      this.kernel.iso(),
      direct?.request ?? text,
    );

    const job = this.begin("generate", provider, brain, "planning", {
      pendingTurn: mine,
      restoreText: intent.kind === "message" ? text : null,
    });
    if (!job) return false;
    this.kernel.player.unlock();
    if (intent.kind === "message")
      this.kernel.dispatch({ type: "composer/text", text: "" });

    try {
      let plan: AgentPlan;
      if (request) {
        const answer = await deps.producePlan(request, llm ? { llm } : {});
        plan = enforcePins(answer, request);
      } else if (direct) plan = direct.plan;
      else return false;
      if (!this.alive(job)) return false;

      const note: TurnNote = {
        ...(plan.model ? { model: plan.model } : {}),
        ...(plan.fallbackReason ? { fallbackReason: plan.fallbackReason } : {}),
      };
      const notesFor = (turn: AgentTurn) =>
        Object.keys(note).length ? { [turn.id]: note } : undefined;
      if (plan.fallbackReason) this.kernel.toast(plan.fallbackReason);

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

      const reply = agentTurn(deps.newId(), this.kernel.iso(), plan, {
        revision: nextRevision(base),
        direct: !request,
      });
      // A new piece starts its own conversation; a refinement continues it.
      const chat = base ? [...thread, mine, reply] : [mine, reply];
      const notes = notesFor(reply);
      const id = deps.newId();
      const autoplay = () => shouldAutoplay(gestureAt, deps.now());

      if (provider === "local") {
        this.stage(job, "rendering", { progress: 0 });
        const audio = await runLocal(
          plan.config,
          {
            signal: job.abort.signal,
            onProgress: (fraction) => {
              if (this.alive(job))
                this.kernel.dispatch({
                  type: "job/update",
                  job: job.id,
                  patch: { progress: fraction },
                });
            },
          },
          { renderMusic: deps.renderMusic },
        );
        if (!this.alive(job)) return false;
        const project = buildProject({
          id,
          now: this.kernel.iso(),
          plan,
          base,
          provider,
          chat,
          audioDuration: audio.duration,
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
          autoplay: autoplay(),
          clearPins: !base,
        });
        if (await this.saveNew(project))
          this.kernel.toast("创作完成，已保存到「我的作品」");
        return true;
      }

      const bridge = deps.desktop;
      if (!bridge) throw new Error("云端 AI 音乐服务只在 Windows 桌面版中可用。");
      this.stage(job, "cloud");
      const prompt = plan.cloudPrompt ?? buildCloudPrompt(plan.config);
      const model = settings.providers[provider]?.model;
      let project = buildProject({
        id,
        now: this.kernel.iso(),
        plan,
        base,
        provider,
        chat,
        cloud: { prompt, ...(model ? { model } : {}) },
      });
      let saveError: unknown = null;
      const result = await runCloud(
        { provider, prompt, duration: plan.config.duration },
        {
          // From here on the audio is paid for: the job cannot be cancelled,
          // and the bytes are stored before anything tries to decode them.
          onReceived: () => this.stage(job, "saving", { cancellable: false }),
          persist: async ({ blob }) => {
            project = { ...project, audioBlob: blob };
            try {
              await this.kernel.store(project);
              return true;
            } catch (error) {
              saveError = error;
              return false;
            }
          },
          onDecoding: () =>
            this.stage(job, "decoding", { cancellable: false }),
          wanted: () => this.alive(job),
        },
        {
          generateMusic: bridge.generateMusic,
          decode: deps.decode,
          ...(deps.mixPeaks ? { mixPeaks: deps.mixPeaks } : {}),
        },
      );
      if (result.saved) {
        this.kernel.dispatch({ type: "library/upsert", project });
        this.kernel.afterSave();
      }
      if (!this.alive(job)) {
        // Cancelled while the answer was already on its way: the paid audio
        // is kept in the library, the current work is not touched.
        if (result.saved)
          this.kernel.toast("云端结果在取消后到达，已保存到「我的作品」。");
        else
          this.kernel.toast(
            `云端结果在取消后到达，但没能保存到作品库：${errorText(saveError, WRITE_FAILED)}`,
            "error",
          );
        return false;
      }
      if (result.audio) {
        project = { ...project, audioDuration: result.audio.duration };
        if (result.saved) {
          this.kernel.dispatch({ type: "library/upsert", project });
          // Only the length is new; if this write fails the next open repeats it.
          void this.kernel.store(project).catch(() => {});
        }
      }
      this.commit(job, {
        project,
        audio: result.audio,
        audioError: result.audio ? null : DECODE_FAILED,
        thread: chat,
        notes,
        reason: "generated",
        saveState: result.saved ? "saved" : "failed",
        autoplay: autoplay(),
        clearPins: !base,
      });
      if (!result.saved)
        this.kernel.toast(
          `音乐已生成，但保存失败：${errorText(saveError, WRITE_FAILED)}请先在「导出」里保存原始音频。`,
          "error",
        );
      else if (!result.audio) this.kernel.toast(DECODE_FAILED, "error");
      else this.kernel.toast("创作完成，已保存到「我的作品」");
      return true;
    } catch (error) {
      if (this.alive(job)) {
        const message = errorText(
          error,
          provider === "local"
            ? "本地引擎出错了，请换个描述或参数再试。"
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
                `这次没有生成成功：${message}`,
              ),
            ],
          });
        this.kernel.toast(`生成失败：${message}`, "error");
        this.giveBackText(job);
      }
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
        audio = await runLocal(
          item.config,
          {
            signal: job.abort.signal,
            onProgress: (fraction) => {
              if (this.alive(job))
                this.kernel.dispatch({
                  type: "job/update",
                  job: job.id,
                  patch: { progress: fraction },
                });
            },
          },
          { renderMusic: deps.renderMusic },
        );
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
      const latest = now.library.projects.find((work) => work.id === id) ?? item;
      const fix =
        audio && durationChanged(latest.audioDuration, audio.duration);
      const project: Project =
        audio && fix ? { ...latest, audioDuration: audio.duration } : latest;
      const engines = engineOptions(deps.platform, now.settings);
      this.commit(job, {
        project,
        audio,
        audioError,
        thread: project.chat ?? [],
        reason: options.reason,
        saveState: "idle",
        autoplay:
          options.autoplay && !!audio && shouldAutoplay(gestureAt, deps.now()),
        // Refinements continue on the work's own engine when it is usable.
        provider: engineProblem(project.provider, engines)
          ? "local"
          : project.provider,
      });
      if (audioError) this.kernel.toast(audioError, "error");
      if (fix) {
        this.kernel.dispatch({
          type: "project/patch",
          id,
          patch: { audioDuration: project.audioDuration },
        });
        void this.kernel.store(project).catch(() => {});
      }
      return true;
    } catch (error) {
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

  readonly setVolume: AppActions["setVolume"] = (track, value) => {
    const before = this.kernel.state.studio.project;
    this.kernel.dispatch({
      type: "mix/volume",
      track,
      value: clampVolume(value),
    });
    if (this.kernel.state.studio.project === before) return;
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
    const { project, audio } = this.kernel.state.studio;
    if (!project) return;
    const stamped: Project = { ...project, updatedAt: this.kernel.iso() };
    this.kernel.dispatch({
      type: "project/patch",
      id: project.id,
      patch: { updatedAt: stamped.updatedAt },
    });
    if (audio?.kind === "stems") {
      try {
        this.kernel.dispatch({
          type: "studio/peaks",
          id: project.id,
          peaks: this.kernel.deps.stemsOutline(audio, stamped.config.volumes),
        });
      } catch {
        /* the outline is decoration; the save matters */
      }
    }
    await this.saveCurrent(stamped, "混音");
  }

  /* ---------------- saving ---------------- */

  /** First save of a freshly generated local work. */
  private async saveNew(project: Project): Promise<boolean> {
    try {
      await this.kernel.store(project);
    } catch (error) {
      this.kernel.dispatch({
        type: "studio/saveState",
        id: project.id,
        saveState: "failed",
      });
      this.kernel.toast(
        `音乐已生成，但保存失败：${errorText(error, WRITE_FAILED)}请先导出音频。`,
        "error",
      );
      return false;
    }
    // The work may have changed while it was written (a fader, the title).
    this.kernel.dispatch({
      type: "library/upsert",
      project: this.kernel.find(project.id) ?? project,
    });
    this.kernel.dispatch({
      type: "studio/saveState",
      id: project.id,
      saveState: "saved",
    });
    this.kernel.afterSave();
    return true;
  }

  /** Save a changed version of the current work (faders). */
  private async saveCurrent(project: Project, what: string): Promise<boolean> {
    const { id } = project;
    const report = (saveState: SaveState) =>
      this.kernel.dispatch({ type: "studio/saveState", id, saveState });
    report("saving");
    try {
      await this.kernel.store(project);
    } catch (error) {
      report("failed");
      this.kernel.toast(
        `${what}没有保存：${errorText(error, WRITE_FAILED)}`,
        "error",
      );
      return false;
    }
    const removing = this.kernel.state.library.removing.some(
      (entry) => entry.project.id === id,
    );
    if (!removing)
      this.kernel.dispatch({
        type: "library/upsert",
        project: this.kernel.find(id) ?? project,
      });
    // A newer change may already be waiting; its own write reports again.
    if (this.mixSchedule.dueAt === null) report("saved");
    this.kernel.afterSave();
    return true;
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
      if (result.saved)
        this.kernel.toast(
          this.kernel.deps.platform.isDesktop
            ? "已导出到选定位置"
            : `已开始下载「${result.name}」`,
        );
      return result.saved;
    } catch (error) {
      this.kernel.toast(errorText(error, "导出失败，请重试。"), "error");
      return false;
    } finally {
      this.kernel.dispatch({ type: "studio/exporting", exporting: false });
    }
  };
}
