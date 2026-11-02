// Fakes for the app core tests: clock, storage, player, engine, desktop bridge.
import { producePlan } from "../../src/agent/brain";
import { encodeWav, mixStems } from "../../src/audio/engine";
import { DEFAULT_CONFIG } from "../../src/music/defaults";
import { TRACKS } from "../../src/music/score";
import type { Platform } from "../../src/platform";
import type { FileFormat } from "../../src/platform";
import {
  exportProject,
  importProject,
  normalizeProject,
} from "../../src/storage";
import type { DamagedRecord, ProjectPatch } from "../../src/storage";
import { AppCore } from "../../src/state/core";
import { memoryModeStore } from "../../src/state/mode";
import type { UiMode } from "../../src/state/mode";
import type { CoreDeps, PlayerPort, StoragePort } from "../../src/state/ports";
import {
  EMPTY_SESSION,
  parseSession,
  serializeSession,
} from "../../src/state/session";
import type { Session } from "../../src/state/session";
import type { SyncMessage, TabSync } from "../../src/state/sync";
import type {
  CloudProvider,
  DesktopAPI,
  DesktopSettings,
  MusicConfig,
  Project,
  RenderResult,
  TrackName,
} from "../../src/types";

/** Enough of AudioBuffer for the engine's mixStems / encodeWav and the exporter. */
export class FakeAudioBuffer {
  readonly length: number;
  readonly sampleRate: number;
  readonly numberOfChannels: number;
  readonly duration: number;
  private readonly channels: Float32Array[];
  constructor(options: {
    length: number;
    sampleRate: number;
    numberOfChannels: number;
  }) {
    this.length = options.length;
    this.sampleRate = options.sampleRate;
    this.numberOfChannels = options.numberOfChannels;
    this.duration = options.length / options.sampleRate;
    this.channels = Array.from(
      { length: options.numberOfChannels },
      () => new Float32Array(options.length),
    );
  }
  getChannelData(channel: number): Float32Array {
    return this.channels[channel];
  }
}

export function installAudioBuffer(): void {
  Object.defineProperty(globalThis, "AudioBuffer", {
    value: FakeAudioBuffer,
    configurable: true,
    writable: true,
  });
}

export function buffer(
  seconds: number,
  value: number,
  sampleRate = 48000,
): AudioBuffer {
  const result = new FakeAudioBuffer({
    length: Math.round(seconds * sampleRate),
    sampleRate,
    numberOfChannels: 2,
  });
  result.getChannelData(0).fill(value);
  result.getChannelData(1).fill(-value);
  return result as unknown as AudioBuffer;
}

/** Constant, distinct levels per stem so any mix can be recognised. */
export const STEM_LEVELS: Record<TrackName, number> = {
  melody: 0.1,
  chords: 0.2,
  bass: 0.05,
  drums: 0.4,
};

export function stems(
  seconds = 0.01,
  sampleRate = 48000,
): Record<TrackName, AudioBuffer> {
  return Object.fromEntries(
    TRACKS.map((track) => [
      track,
      buffer(seconds, STEM_LEVELS[track], sampleRate),
    ]),
  ) as Record<TrackName, AudioBuffer>;
}

export function renderResult(
  config: MusicConfig,
  seconds = 0.01,
): RenderResult {
  const legacy = config.engine === 1;
  return {
    stems: stems(seconds, legacy ? 32000 : 48000),
    peaks: [0.2, 1, 0.4],
    stemPeaks: Object.fromEntries(
      TRACKS.map((track) => [track, [0.5, 1]]),
    ) as Record<TrackName, number[]>,
    duration: seconds,
    sampleRate: legacy ? 32000 : 48000,
    ...(legacy
      ? {}
      : {
          arrangement: {
            bpm: config.bpm,
            bars: 8,
            duration: seconds,
            keyLabel: "C 大调",
            sections: [],
            chords: [],
            instruments: ["柔和钢琴"],
            notes: ["测试编曲"],
          },
        }),
  };
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export function defer<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let every already-resolved promise continuation run. */
export async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

export class FakeClock {
  time = Date.UTC(2026, 9, 9, 8, 0, 0);
  private seq = 0;
  private pending: { id: number; at: number; callback: () => void }[] = [];
  readonly now = (): number => this.time;
  readonly timers = {
    set: (callback: () => void, ms: number): unknown => {
      const id = ++this.seq;
      this.pending.push({ id, at: this.time + Math.max(0, ms), callback });
      return id;
    },
    clear: (handle: unknown): void => {
      this.pending = this.pending.filter((timer) => timer.id !== handle);
    },
  };
  /** Move time forward, firing timers in order. */
  advance(ms: number): void {
    const target = this.time + ms;
    for (;;) {
      const next = this.pending
        .filter((timer) => timer.at <= target)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!next) break;
      this.pending = this.pending.filter((timer) => timer !== next);
      this.time = Math.max(this.time, next.at);
      next.callback();
    }
    this.time = target;
  }
}

export interface FakeStorage extends StoragePort {
  records: Map<string, Project>;
  damaged: DamagedRecord[];
  raw: Map<string, string>;
  /** audio bytes of damaged records, by id */
  rawAudio: Map<string, Blob>;
  /** every record as it was written (whole saves and merged patches) */
  saves: Project[];
  /** field-level writes, as they were asked for */
  patches: { id: string; patch: ProjectPatch }[];
  deletes: string[];
  /** chronological record of what happened, shared with other fakes */
  log: string[];
  /** every write fails with this */
  failSave: Error | null;
  /** only the next n writes fail */
  failNext: { count: number; error: Error } | null;
  /**
   * Writes and deletes never complete — what a database request does when
   * it is started while the page is being torn down.
   */
  stall: boolean;
  /** while set, writes and deletes wait for it (a slow disk); reads do not */
  hold: Deferred<void> | null;
  failList: Error | null;
  persistenceRequests: number;
}

const laterOf = (a: string, b: string | undefined) =>
  b !== undefined && Date.parse(b) > Date.parse(a) ? b : a;

export function fakeStorage(log: string[] = []): FakeStorage {
  const pass = () =>
    storage.stall
      ? new Promise<never>(() => {})
      : (storage.hold?.promise ?? Promise.resolve());
  const refuse = () => {
    if (storage.failSave) throw storage.failSave;
    if (storage.failNext && storage.failNext.count > 0) {
      storage.failNext.count--;
      throw storage.failNext.error;
    }
  };
  const storage: FakeStorage = {
    records: new Map(),
    damaged: [],
    raw: new Map(),
    rawAudio: new Map(),
    saves: [],
    patches: [],
    deletes: [],
    log,
    failSave: null,
    failNext: null,
    stall: false,
    hold: null,
    failList: null,
    persistenceRequests: 0,
    async listProjects() {
      if (storage.failList) throw storage.failList;
      return {
        projects: [...storage.records.values()].sort((a, b) =>
          b.updatedAt.localeCompare(a.updatedAt),
        ),
        damaged: [...storage.damaged],
      };
    },
    async saveProject(project, options) {
      await pass();
      refuse();
      // The real validator: whatever the core saves must be a valid record.
      normalizeProject(project);
      if (options?.ifMissing && storage.records.has(project.id)) {
        log.push(`kept:${project.id}`);
        return false;
      }
      log.push(`save:${project.id}`);
      storage.saves.push(project);
      storage.records.set(project.id, project);
      return true;
    },
    // Same contract as storage.updateProject: merge into what is stored,
    // null when the record is gone.
    async updateProject(id, patch, options) {
      await pass();
      refuse();
      const current = storage.records.get(id);
      if (!current) {
        log.push(`gone:${id}`);
        return null;
      }
      if (
        options?.unlessNewer &&
        patch.updatedAt !== undefined &&
        Date.parse(current.updatedAt) > Date.parse(patch.updatedAt)
      )
        return current;
      const defined = Object.fromEntries(
        Object.entries(patch.volumes ?? {}).filter(
          ([, value]) => value !== undefined,
        ),
      );
      const merged: Project = {
        ...current,
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.favorite !== undefined ? { favorite: patch.favorite } : {}),
        ...(patch.audioDuration !== undefined
          ? { audioDuration: patch.audioDuration }
          : {}),
        updatedAt: laterOf(current.updatedAt, patch.updatedAt),
        config: {
          ...current.config,
          volumes: { ...current.config.volumes, ...defined },
        },
      };
      normalizeProject(merged);
      log.push(`save:${id}`);
      storage.saves.push(merged);
      storage.patches.push({ id, patch });
      storage.records.set(id, merged);
      return merged;
    },
    async readProject(id) {
      return storage.records.get(id) ?? null;
    },
    async deleteProject(id) {
      await pass();
      log.push(`delete:${id}`);
      storage.deletes.push(id);
      storage.records.delete(id);
      storage.damaged = storage.damaged.filter((item) => item.id !== id);
    },
    async readRawRecord(id) {
      return storage.raw.get(id) ?? null;
    },
    async readRawAudio(id) {
      return storage.rawAudio.get(id) ?? null;
    },
    importProject,
    async storageInfo() {
      return { usage: 1024, quota: 1024 * 1024, persisted: false };
    },
    async requestPersistence() {
      storage.persistenceRequests++;
      return true;
    },
  };
  return storage;
}

export interface FakePlayer extends PlayerPort {
  loads: {
    source: Parameters<PlayerPort["load"]>[0];
    mix: Parameters<PlayerPort["load"]>[1];
    options: Parameters<PlayerPort["load"]>[2];
  }[];
  mixes: { gains: Record<TrackName, number>; solo: TrackName | null }[];
  unloads: number;
  plays: number;
  unlocks: number;
}

export function fakePlayer(): FakePlayer {
  const player: FakePlayer = {
    loads: [],
    mixes: [],
    unloads: 0,
    plays: 0,
    unlocks: 0,
    load(source, mix, options) {
      player.loads.push({
        source,
        mix: { ...mix, gains: { ...mix.gains } },
        options,
      });
    },
    unload() {
      player.unloads++;
    },
    async play() {
      player.plays++;
    },
    pause() {},
    setMix(gains, solo) {
      player.mixes.push({ gains: { ...gains }, solo });
    },
    unlock() {
      player.unlocks++;
    },
  };
  return player;
}

export interface SavedFile {
  name: string;
  data: ArrayBuffer;
  format: FileFormat;
}

export function platformOf(kind: "web" | "desktop"): Platform {
  const desktop = kind === "desktop";
  return {
    isDesktop: desktop,
    isWeb: !desktop,
    isEmbedded: false,
    version: "0.4.0-test",
    canUseCloud: desktop,
    canUseLlm: desktop,
    downloadUrl: "https://example.test/download",
  };
}

export function desktopSettings(
  patch: Partial<DesktopSettings> = {},
): DesktopSettings {
  return {
    providers: {
      tencent: { configured: true, model: "minimax-music-v3.0" },
      volcengine: { configured: true },
      aliyun: { configured: false },
      elevenlabs: { configured: false },
    },
    llm: { configured: false },
    dataPath: "C:\\Users\\test\\AppData\\Roaming\\Muse BGM",
    version: "0.4.0-test",
    ...patch,
  };
}

export interface FakeBridge extends Omit<DesktopAPI, "discardPendingResult"> {
  /**
   * Give up the paid result the "main process" holds. Absent by default:
   * the fake then stands for a bridge without the call, which the page has
   * to cope with — a test that needs the call sets it.
   */
  discardPendingResult?: DesktopAPI["discardPendingResult"];
  /** every value setUnsavedWork was called with */
  risk: boolean[];
  calls: string[];
  settings: DesktopSettings;
  /** replace to control what the "service" answers */
  generate: DesktopAPI["generateMusic"];
  /** replace to control what 重新下载 gets; by default nothing is waiting */
  download: DesktopAPI["retryLastDownload"];
  plan: DesktopAPI["agentPlan"];
}

export const MP3_BYTES = new Uint8Array([
  0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 1, 7,
]);

export function fakeBridge(log: string[] = []): FakeBridge {
  const call = (name: string) => {
    bridge.calls.push(name);
    log.push(`bridge:${name}`);
  };
  const bridge: FakeBridge = {
    risk: [],
    async setUnsavedWork(value) {
      bridge.risk.push(value);
    },
    calls: [],
    settings: desktopSettings(),
    generate: async () => ({
      audio: MP3_BYTES.slice().buffer,
      mimeType: "audio/mpeg",
    }),
    download: async () => {
      throw new Error(
        "没有等待重新下载的音乐。如需这首音乐，请到服务控制台查找，或重新生成。",
      );
    },
    plan: async () => {
      throw new Error("还没有配置大模型。请先在设置中填写大模型的连接信息。");
    },
    async getSettings() {
      call("getSettings");
      return bridge.settings;
    },
    async saveProviderCredentials(provider) {
      call(`saveProvider:${provider}`);
      bridge.settings = {
        ...bridge.settings,
        providers: {
          ...bridge.settings.providers,
          [provider]: { configured: true },
        },
      };
    },
    async deleteProviderCredentials(provider) {
      call(`deleteProvider:${provider}`);
      bridge.settings = {
        ...bridge.settings,
        providers: {
          ...bridge.settings.providers,
          [provider]: { configured: false },
        },
      };
    },
    generateMusic(input) {
      call(`generateMusic:${input.provider}`);
      return bridge.generate(input);
    },
    async cancelGeneration() {
      call("cancelGeneration");
    },
    retryLastDownload(provider) {
      call(`retryLastDownload:${provider}`);
      return bridge.download(provider);
    },
    async saveAudio() {
      return { saved: true };
    },
    async openExternal() {},
    async saveLlmSettings(settings) {
      call("saveLlm");
      bridge.settings = {
        ...bridge.settings,
        llm: {
          configured: true,
          kind: settings.kind,
          preset: settings.preset,
          model: settings.model,
        },
      };
    },
    async deleteLlmSettings() {
      call("deleteLlm");
      bridge.settings = { ...bridge.settings, llm: { configured: false } };
    },
    agentPlan(input) {
      call("agentPlan");
      return bridge.plan(input);
    },
    async cancelAgent() {
      call("cancelAgent");
    },
  };
  return bridge;
}

/**
 * What several tabs of one origin share: the library, localStorage (the
 * session) and the channel they talk on. Pass the same object to two
 * harnesses to get two tabs.
 */
export interface SharedOrigin {
  storage: FakeStorage;
  log: string[];
  /** the session as it is stored: serialised, like localStorage holds it */
  session: { raw: string; writes: Session[] };
  /** every message any tab posted */
  posted: SyncMessage[];
  /** one endpoint per tab; a tab does not hear itself */
  connect(): TabSync;
}

export function sharedOrigin(session: Partial<Session> = {}): SharedOrigin {
  const log: string[] = [];
  const posted: SyncMessage[] = [];
  const tabs: Set<(message: SyncMessage) => void>[] = [];
  return {
    storage: fakeStorage(log),
    log,
    session: {
      // read and written on the fake clock, like everything else in a test
      raw: serializeSession(
        { ...EMPTY_SESSION, ...session },
        new FakeClock().time,
      ),
      writes: [],
    },
    posted,
    connect() {
      const mine = new Set<(message: SyncMessage) => void>();
      tabs.push(mine);
      return {
        post(message) {
          posted.push(message);
          // delivered later, like a real channel: never inside the sender's call
          for (const tab of tabs)
            if (tab !== mine)
              for (const listener of [...tab])
                void Promise.resolve().then(() => listener(message));
        },
        subscribe(listener) {
          mine.add(listener);
          return () => {
            mine.delete(listener);
          };
        },
      };
    },
  };
}

export interface Harness {
  core: AppCore;
  clock: FakeClock;
  storage: FakeStorage;
  player: FakePlayer;
  bridge: FakeBridge | undefined;
  log: string[];
  files: SavedFile[];
  renders: MusicConfig[];
  /** set to make the next renders wait until released */
  gate: { current: Deferred<void> | null };
  /** `value` is the stored session, parsed the way the next launch reads it */
  session: { readonly value: Session; writes: Session[] };
  /** the origin this tab belongs to (its own, unless one was passed in) */
  origin: SharedOrigin;
  plans: { llm: boolean; text: string; mode: string }[];
  decodes: number;
  /** make decode fail */
  decodeError: { current: Error | null };
  /** set to make decoding wait (it cannot be aborted, like the real one) */
  decodeGate: { current: Deferred<void> | null };
  renderError: { current: Error | null };
  seeds: number[];
  /** where the interface mode is remembered */
  modeStore: { value: UiMode };
}

export function harness(
  options: {
    kind?: "web" | "desktop";
    session?: Partial<Session>;
    records?: Project[];
    undoMs?: number;
    /** another tab of the same origin: shares library, session and channel */
    origin?: SharedOrigin;
    /** share the clock of another tab */
    clock?: FakeClock;
    /**
     * The interface the app starts in. Default 专业模式: the suites written
     * for v0.3 test its behaviour; 简单模式 tests ask for it.
     */
    mode?: UiMode;
  } = {},
): Harness {
  installAudioBuffer();
  const origin = options.origin ?? sharedOrigin(options.session);
  const { log, storage } = origin;
  const clock = options.clock ?? new FakeClock();
  for (const record of options.records ?? [])
    storage.records.set(record.id, record);
  const player = fakePlayer();
  const kind = options.kind ?? "web";
  const bridge = kind === "desktop" ? fakeBridge(log) : undefined;
  const files: SavedFile[] = [];
  const renders: MusicConfig[] = [];
  const gate: Harness["gate"] = { current: null };
  const session: Harness["session"] = {
    get value() {
      return parseSession(origin.session.raw, clock.now());
    },
    writes: origin.session.writes,
  };
  const plans: Harness["plans"] = [];
  const decodeError: Harness["decodeError"] = { current: null };
  const decodeGate: Harness["decodeGate"] = { current: null };
  const renderError: Harness["renderError"] = { current: null };
  const seeds: number[] = [];
  const modeStore = memoryModeStore(options.mode ?? "pro");
  let ids = 0;
  let seed = 1000;
  const state = { decodes: 0 };

  const deps: CoreDeps = {
    platform: platformOf(kind),
    // the page is built against the contract; see FakeBridge.discardPendingResult
    desktop: bridge as DesktopAPI | undefined,
    storage,
    async renderMusic(config, renderOptions) {
      renders.push(config);
      log.push(`render:engine${config.engine}`);
      renderOptions?.onProgress?.(0.5);
      if (gate.current) await gate.current.promise;
      if (renderOptions?.signal?.aborted)
        throw new DOMException("已取消生成", "AbortError");
      if (renderError.current) throw renderError.current;
      return renderResult(config);
    },
    async decode() {
      state.decodes++;
      log.push("decode");
      if (decodeGate.current) await decodeGate.current.promise;
      if (decodeError.current) throw decodeError.current;
      return buffer(0.02, 0.25);
    },
    mixPeaks: () => [0.1, 0.5, 0.25],
    stemsOutline: (_audio, volumes) => TRACKS.map((track) => volumes[track]),
    async producePlan(request, planOptions) {
      plans.push({
        llm: !!planOptions?.llm,
        text: request.text,
        mode: request.mode,
      });
      return producePlan(request, planOptions);
    },
    exporter: {
      mixStems,
      encodeWav,
      exportProject,
      async saveFile(file) {
        files.push(file);
        return { saved: true };
      },
    },
    openExternal: async () => true,
    newId: () => `id-${++ids}`,
    randomSeed: () => {
      seeds.push(++seed);
      return seed;
    },
    now: clock.now,
    timers: clock.timers,
    session: {
      read: () => parseSession(origin.session.raw, clock.now()),
      write: (value) => {
        origin.session.raw = serializeSession(value, clock.now());
        origin.session.writes.push(
          parseSession(origin.session.raw, clock.now()),
        );
      },
    },
    sync: origin.connect(),
    ...(options.undoMs !== undefined ? { undoMs: options.undoMs } : {}),
    mode: modeStore,
  };
  const core = new AppCore(deps);
  core.attachPlayer(player);
  return {
    core,
    clock,
    storage,
    player,
    bridge,
    log,
    files,
    renders,
    gate,
    session,
    origin,
    plans,
    get decodes() {
      return state.decodes;
    },
    decodeError,
    decodeGate,
    renderError,
    seeds,
    modeStore,
  };
}

export function localProject(
  id: string,
  patch: Partial<Project> = {},
  config: Partial<MusicConfig> = {},
): Project {
  return {
    id,
    title: "夏日小事",
    createdAt: "2026-10-01T08:00:00.000Z",
    updatedAt: "2026-10-01T08:00:00.000Z",
    config: {
      ...DEFAULT_CONFIG,
      volumes: { ...DEFAULT_CONFIG.volumes },
      prompt: "夏日海边",
      seed: 4242,
      ...config,
    },
    provider: "local",
    favorite: false,
    revision: 1,
    tags: ["青春欢快", "112 BPM", "柔和钢琴"],
    ...patch,
  };
}
