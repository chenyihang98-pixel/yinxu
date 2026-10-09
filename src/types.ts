import type {
  BassFeel,
  DrumFeel,
  InstrumentId,
  SectionType,
  StyleId,
} from "./music/catalog";
import type { ArrangementSummary, TrackName } from "./music/score";
import type {
  AgentPlanInput,
  AgentPlanOutput,
  AgentTurn,
  LlmSettingsInput,
  LlmStatus,
} from "./agent/types";

export type { TrackName };
/** Historic name: a "mood" is a style id from the shared catalog. */
export type Mood = StyleId;
export type Instrument = InstrumentId;

/**
 * Optional, fully validated arrangement overrides. The offline brain rarely
 * sets them; an LLM producer can use them to shape the piece. Anything missing
 * (or invalid) falls back to the style's own choice.
 */
export interface ArrangementHints {
  /** roman numerals, one chord per bar, cycled — e.g. ["I","V","vi","IV"] (max 16) */
  progression?: string[];
  /** explicit section plan (max 12); bars are multiples of 1, energy 0..1 */
  form?: { type: SectionType; bars: number; energy: number }[];
  drums?: DrumFeel;
  bass?: BassFeel;
  /** 0..0.66 */
  swing?: number;
  layers?: { pad?: boolean; arp?: boolean; counter?: boolean; perc?: boolean };
  melody?: {
    /** 0..1 */
    density?: number;
    register?: "low" | "mid" | "high";
    motion?: "stepwise" | "leaps" | "arpeggio";
  };
}

export interface MusicConfig {
  prompt: string;
  mood: Mood;
  /** 50..200 */
  bpm: number;
  /** requested seconds, 15..120 (loops may snap to whole bars; see RenderResult.duration) */
  duration: number;
  /** one of KEYS in music/catalog, e.g. "F# minor" */
  key: string;
  instrument: Instrument;
  energy: number;
  complexity: number;
  reverb: number;
  seed: number;
  loop: boolean;
  volumes: Record<TrackName, number>;
  /** 1 = frozen v0.2 synthesizer (old works), 2 = current engine */
  engine: 1 | 2;
  arrangement?: ArrangementHints;
}

/** Result of a local render. Stems are final (already mastered); mixing is just gains. */
export interface RenderResult {
  stems: Record<TrackName, AudioBuffer>;
  /** waveform of the default mix, 0..1 */
  peaks: number[];
  /** waveform per stem, 0..1 relative to the loudest stem */
  stemPeaks: Record<TrackName, number[]>;
  /** exact audio length in seconds */
  duration: number;
  sampleRate: number;
  /** sections, chords and instrumentation (engine 2 only) */
  arrangement?: ArrangementSummary;
}

export type CloudProvider = "tencent" | "volcengine" | "aliyun" | "elevenlabs";
export type Provider = "local" | CloudProvider;
export type AudioFormat = "wav" | "mp3" | "m4a" | "flac";
export interface ProviderStatus {
  configured: boolean;
  /** stored but unreadable (e.g. encrypted by another Windows account): ask the user to save again */
  damaged?: boolean;
  model?: string;
  workspaceId?: string;
  billingMode?: string;
}
export type ProviderStatuses = Record<CloudProvider, ProviderStatus>;

export interface CloudMeta {
  /** the exact prompt that was sent to the music service */
  prompt: string;
  model?: string;
}

export interface Project {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  config: MusicConfig;
  provider: Provider;
  favorite: boolean;
  revision: number;
  tags: string[];
  audioBlob?: Blob;
  audioDuration?: number;
  /** the work this one was derived from (variation / refinement) */
  parentId?: string;
  /** conversation with the producer agent that led to this work (most recent last) */
  chat?: AgentTurn[];
  cloud?: CloudMeta;
}

export interface DesktopSettings {
  providers: ProviderStatuses;
  llm: LlmStatus;
  dataPath: string;
  version: string;
}

export interface DesktopAPI {
  getSettings(): Promise<DesktopSettings>;
  saveProviderCredentials(
    provider: CloudProvider,
    credentials: Record<string, string>,
  ): Promise<void>;
  deleteProviderCredentials(provider: CloudProvider): Promise<void>;
  generateMusic(input: {
    provider?: CloudProvider;
    prompt: string;
    duration: number;
    model?: string;
  }): Promise<{ audio: ArrayBuffer; mimeType: string }>;
  cancelGeneration(): Promise<void>;
  /**
   * Fetch the last finished result of this service again after its download
   * failed: nothing is submitted, nothing is billed. Rejects when no result
   * is waiting (another generation was started since, or the app restarted).
   */
  retryLastDownload(
    provider: CloudProvider,
  ): Promise<{ audio: ArrayBuffer; mimeType: string }>;
  /**
   * Tell the shell whether closing the window now would lose paid work (a
   * cloud request under way, a paid result that is not stored yet). While
   * true, closing asks first.
   */
  setUnsavedWork(value: boolean): Promise<void>;
  saveAudio(input: {
    name: string;
    data: ArrayBuffer;
    format: AudioFormat | "json";
  }): Promise<{ saved: boolean; path?: string }>;
  openExternal(url: string): Promise<void>;
  /* producer agent (large language model) */
  saveLlmSettings(settings: LlmSettingsInput): Promise<void>;
  deleteLlmSettings(): Promise<void>;
  agentPlan(input: AgentPlanInput): Promise<AgentPlanOutput>;
  cancelAgent(): Promise<void>;
}
declare global {
  interface Window {
    museDesktop?: DesktopAPI;
  }
}
