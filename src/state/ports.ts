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
import type { DamagedRecord } from "../storage";
import type { DesktopAPI, Project, TrackName } from "../types";
import type { SessionStore } from "./session";
import type { StemsAudio, StorageUsage } from "./types";

export interface StoragePort {
  listProjects(): Promise<{ projects: Project[]; damaged: DamagedRecord[] }>;
  saveProject(project: Project): Promise<void>;
  deleteProject(id: string): Promise<void>;
  readRawRecord(id: string): Promise<string | null>;
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
}

export interface Timers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface CoreDeps {
  platform: Platform;
  /** the Electron bridge; undefined on the web */
  desktop: DesktopAPI | undefined;
  storage: StoragePort;
  renderMusic: RenderMusic;
  decode: DecodeAudio;
  /** raw outline of a decoded mix; default: the engine's computePeaks */
  mixPeaks?: MixPeaks;
  /** 0..1 outline of the stems at the given faders (main waveform) */
  stemsOutline(
    audio: StemsAudio,
    volumes: Record<TrackName, number>,
  ): number[];
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
