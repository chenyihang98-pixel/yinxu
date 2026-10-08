export type Mood =
  | "bright"
  | "chill"
  | "cinematic"
  | "dreamy"
  | "focus"
  | "retro";
export type Instrument = "piano" | "guitar" | "synth" | "bell";
export type TrackName = "melody" | "chords" | "bass" | "drums";
export interface MusicConfig {
  prompt: string;
  mood: Mood;
  bpm: number;
  duration: number;
  key: string;
  instrument: Instrument;
  energy: number;
  complexity: number;
  reverb: number;
  seed: number;
  loop: boolean;
  volumes: Record<TrackName, number>;
}
export interface CompositionPlan {
  title: string;
  description: string;
  config: MusicConfig;
  tags: string[];
  reasoning: string[];
}
export interface RenderResult {
  buffer: AudioBuffer;
  stems: Record<TrackName, AudioBuffer>;
  peaks: number[];
}
export type CloudProvider = 'tencent' | 'volcengine' | 'aliyun' | 'elevenlabs';
export type Provider = 'local' | CloudProvider;
export type AudioFormat = 'wav' | 'mp3' | 'm4a' | 'flac';
export interface ProviderStatus { configured: boolean; model?: string; workspaceId?: string; billingMode?: string; }
export type ProviderStatuses = Record<CloudProvider, ProviderStatus>;
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
}
export interface DesktopAPI {
  getSettings(): Promise<{ hasApiKey: boolean; providers: ProviderStatuses; dataPath: string }>;
  saveApiKey(key: string): Promise<void>;
  deleteApiKey(): Promise<void>;
  saveProviderCredentials(provider: CloudProvider, credentials: Record<string,string>): Promise<void>;
  deleteProviderCredentials(provider: CloudProvider): Promise<void>;
  generateMusic(input: {
    provider?: CloudProvider;
    prompt: string;
    duration: number;
    model?: string;
  }): Promise<{ audio: ArrayBuffer; mimeType: string }>;
  cancelGeneration(): Promise<void>;
  saveAudio(input: {
    name: string;
    data: ArrayBuffer;
    format: AudioFormat | "json";
  }): Promise<{ saved: boolean; path?: string }>;
  openExternal(url: string): Promise<void>;
}
declare global {
  interface Window {
    museDesktop?: DesktopAPI;
  }
}
