/**
 * Everything the app core needs from the outside world, as interfaces. The
 * real ones are wired in app.ts; tests pass fakes.
 */
import type { AgentPlan, AgentRequest } from "../agent/types";
import type { Platform } from "../platform";
import type { PlayerMix, PlayerSource } from "../player/usePlayer";
import type { ExportDeps } from "../services/exporter";
import type {
  DecodeAudio,
  MixPeaks,
  RenderMusic,
} from "../services/generation";
import type { DamagedRecord, ProjectPatch } from "../storage";
import type { DesktopAPI, Project, TrackName } from "../types";
import type { SessionStore } from "./session";
import type { TabSync } from "./sync";
import type { StemsAudio, StorageUsage } from "./types";

export interface StoragePort {
  listProjects(): Promise<{ projects: Project[]; damaged: DamagedRecord[] }>;
  /**
   * Store a whole work (a new one). With `ifMissing` the record is written
   * only when its key is free — putting a deleted work back — and false is
   * resolved when something was already there.
   */
  saveProject(
    project: Project,
    options?: { ifMissing?: boolean },
  ): Promise<boolean | void>;
  /**
   * Change fields of a stored work, merging with what is stored. Resolves
   * with the stored result, or null when the record no longer exists.
   */
  updateProject(
    id: string,
    patch: ProjectPatch,
    options?: { unlessNewer?: boolean },
  ): Promise<Project | null>;
  /** One stored work; null when missing or unreadable. */
  readProject(id: string): Promise<Project | null>;
  deleteProject(id: string): Promise<void>;
  readRawRecord(id: string): Promise<string | null>;
  /** The audio bytes of any stored record, damaged or not; null without audio. */
  readRawAudio(id: string): Promise<Blob | null>;
  importProject(text: string): Project;
  storageInfo(): Promise<StorageUsage | null>;
  requestPersistence(): Promise<boolean>;
}

/** The part of the Player the core drives. Methods must be stable. */
export interface PlayerPort {
  load(
    source: PlayerSource,
    mix: PlayerMix,
    options?: { autoplay?: boolean; keepPosition?: boolean },
  ): void;
  unload(): void;
  play(): Promise<void>;
  pause(): void;
  setMix(gains: Record<TrackName, number>, solo: TrackName | null): void;
  unlock(): void;
  /** 循环试听 on or off; optional so a stand-in player need not have it */
  setLoop?(loop: boolean): void;
}

/**
 * What the local engine says about a render before its first progress
 * (audio/engine.ts RenderOptions.onPhase): "starting" while it has to wait
 * for its render worker to come up, "rendering" once music is being made.
 */
export type EnginePhaseListener = (phase: "starting" | "rendering") => void;

export interface Timers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface CoreDeps {
  platform: Platform;
  /** the Electron bridge; undefined on the web */
  desktop: DesktopAPI | undefined;
  storage: StoragePort;
  /**
   * The local engine. Besides progress it may report its phase to an
   * `onPhase` option (EnginePhaseListener): the core passes one along.
   */
  renderMusic: RenderMusic;
  decode: DecodeAudio;
  /** raw outline of a decoded mix; default: the engine's computePeaks */
  mixPeaks?: MixPeaks;
  /** 0..1 outline of the stems at the given faders (main waveform) */
  stemsOutline(audio: StemsAudio, volumes: Record<TrackName, number>): number[];
  producePlan(
    request: AgentRequest,
    options?: { llm?: DesktopAPI["agentPlan"] },
  ): Promise<AgentPlan>;
  exporter: ExportDeps;
  openExternal(url: string): Promise<boolean>;
  newId(): string;
  randomSeed(): number;
  /** epoch milliseconds */
  now(): number;
  timers: Timers;
  session: SessionStore;
  /** what other tabs of this origin are told and tell; default: nothing */
  sync?: TabSync;
  /** undo window of a soft delete; default 8 s */
  undoMs?: number;
}

/** Until the app's player is attached, playback requests go nowhere. */
export const NO_PLAYER: PlayerPort = {
  load() {},
  unload() {},
  play: async () => {},
  pause() {},
  setMix() {},
  unlock() {},
};
