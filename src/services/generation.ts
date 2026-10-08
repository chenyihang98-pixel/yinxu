/**
 * Turning a configuration into audio. No React and no app state: the caller
 * passes what is needed and gets a result back, so every path can be tested
 * with a fake engine, a fake desktop bridge and a fake decoder.
 */
import { computePeaks, renderMusic } from "../audio/engine";
import { TRACKS } from "../music/score";
import { originalFormat } from "../providers";
import type {
  AudioFormat,
  CloudProvider,
  DesktopAPI,
  MusicConfig,
  RenderResult,
} from "../types";
import type { MixAudio, StemsAudio } from "../state/types";

/** Engine 2 renders at this rate; cloud audio is decoded to it as well. */
export const DECODE_SAMPLE_RATE = 48000;

export type RenderMusic = (
  config: MusicConfig,
  options?: { onProgress?: (fraction: number) => void; signal?: AbortSignal },
) => Promise<RenderResult>;

/** Decode an encoded audio file (mp3 / wav / flac / m4a) into PCM. */
export type DecodeAudio = (data: ArrayBuffer) => Promise<AudioBuffer>;

/** Raw mix outline of one buffer, 0..peak (not normalised). */
export type MixPeaks = (buffer: AudioBuffer) => number[];

function abortError(): DOMException {
  return new DOMException("已取消生成", "AbortError");
}

/**
 * Local composition + synthesis. `config.engine` selects the engine, so a
 * v0.2 work (engine 1) is rebuilt by the frozen legacy synthesizer. Rejects
 * with an AbortError when `signal` aborts.
 */
export async function runLocal(
  config: MusicConfig,
  options: { signal?: AbortSignal; onProgress?: (fraction: number) => void },
  deps: { renderMusic: RenderMusic } = { renderMusic },
): Promise<StemsAudio> {
  const { signal, onProgress } = options;
  if (signal?.aborted) throw abortError();
  const result = await deps.renderMusic(config, {
    signal,
    onProgress: (fraction) => {
      if (!signal?.aborted)
        onProgress?.(Math.max(0, Math.min(1, Number(fraction) || 0)));
    },
  });
  if (signal?.aborted) throw abortError();
  if (
    !result ||
    !TRACKS.every((track) => result.stems?.[track]) ||
    !(result.duration > 0)
  )
    throw new Error("本地引擎没有生成可用的音频，请调整参数后重试。");
  return {
    kind: "stems",
    stems: result.stems,
    engine: config.engine === 1 ? 1 : 2,
    peaks: result.peaks,
    stemPeaks: result.stemPeaks,
    duration: result.duration,
    sampleRate: result.sampleRate,
    ...(result.arrangement ? { arrangement: result.arrangement } : {}),
  };
}

/** 0..1 outline, loudest bin = 1. */
export function normalisePeaks(peaks: readonly number[]): number[] {
  const max = Math.max(0.001, ...peaks);
  return peaks.map((value) => Math.max(0, value) / max);
}

const defaultMixPeaks: MixPeaks = (buffer) =>
  computePeaks([{ buffer, gain: 1 }]);

/** Wrap a decoded buffer the way the studio keeps a cloud work. */
export function describeMix(
  buffer: AudioBuffer,
  mixPeaks: MixPeaks = defaultMixPeaks,
): MixAudio {
  if (
    !buffer ||
    !Number.isFinite(buffer.duration) ||
    buffer.duration <= 0 ||
    !(buffer.sampleRate > 0)
  )
    throw new Error("音频内容为空，无法播放。");
  return {
    kind: "mix",
    buffer,
    peaks: normalisePeaks(mixPeaks(buffer)),
    duration: buffer.duration,
    sampleRate: buffer.sampleRate,
  };
}

/**
 * The browser's decoder through an OfflineAudioContext: needs no user gesture
 * and no output device, and always resamples to 48 kHz so cloud and local
 * works share one player context and one export rate.
 */
export const decodeAudio: DecodeAudio = async (data) => {
  const scope = globalThis as typeof globalThis & {
    webkitOfflineAudioContext?: typeof OfflineAudioContext;
  };
  const Offline = scope.OfflineAudioContext ?? scope.webkitOfflineAudioContext;
  if (!Offline) throw new Error("当前环境不支持音频解码。");
  const context = new Offline(2, 1, DECODE_SAMPLE_RATE);
  // decodeAudioData detaches its input; the caller keeps the original bytes.
  return await context.decodeAudioData(data.slice(0));
};

/** Decode a stored or freshly generated audio file into a playable mix. */
export async function decodeBlob(
  blob: Blob,
  deps: { decode: DecodeAudio; mixPeaks?: MixPeaks } = { decode: decodeAudio },
): Promise<MixAudio> {
  const bytes = await blob.arrayBuffer();
  if (!bytes.byteLength) throw new Error("音频文件是空的。");
  return describeMix(await deps.decode(bytes), deps.mixPeaks);
}

export interface CloudRequest {
  provider: CloudProvider;
  /** the exact prompt for the music service (AgentPlan.cloudPrompt) */
  prompt: string;
  /** target seconds */
  duration: number;
}

export interface CloudHooks {
  /** the service answered and the bytes are here; from now on nothing is lost */
  onReceived?: () => void;
  /**
   * Make the paid result durable. Called exactly once, BEFORE any decoding,
   * with the audio exactly as the service sent it. Resolve false (or throw)
   * when it could not be stored — the result is still returned.
   */
  persist: (audio: {
    blob: Blob;
    mimeType: string;
    format: AudioFormat | null;
  }) => Promise<boolean>;
  /** storing is done (either way); decoding starts */
  onDecoding?: () => void;
  /** false = the job was cancelled meanwhile: keep the stored result, skip decoding */
  wanted?: () => boolean;
}

export interface CloudResult {
  blob: Blob;
  mimeType: string;
  /** null for a MIME type this build cannot name: export WAV instead */
  format: AudioFormat | null;
  /** the result is in the library */
  saved: boolean;
  /** decoded audio; null when decoding failed or was skipped */
  audio: MixAudio | null;
  /** why `audio` is null although it was wanted */
  decodeError: unknown;
}

/**
 * One cloud generation. Order matters for money: request → receive → store
 * the bytes (hooks.persist) → only then decode. A file the browser cannot
 * decode, or a result that arrives after the user stopped waiting, is
 * therefore already in the library and can be exported as it is.
 *
 * Rejects only when the service gave no usable audio (its own error text, or
 * a cancellation). Never retries: a retry would be a second paid request.
 */
export async function runCloud(
  request: CloudRequest,
  hooks: CloudHooks,
  deps: {
    generateMusic: DesktopAPI["generateMusic"];
    decode: DecodeAudio;
    mixPeaks?: MixPeaks;
  },
): Promise<CloudResult> {
  const answer = await deps.generateMusic({
    provider: request.provider,
    prompt: request.prompt,
    duration: request.duration,
  });
  const bytes = answer?.audio;
  if (!(bytes instanceof ArrayBuffer) || bytes.byteLength === 0)
    throw new Error("音乐服务没有返回音频，请稍后重试。");
  const mimeType =
    typeof answer.mimeType === "string" && answer.mimeType
      ? answer.mimeType
      : "application/octet-stream";
  const blob = new Blob([bytes], { type: mimeType });
  const format = originalFormat(mimeType);
  hooks.onReceived?.();

  let saved = false;
  try {
    saved = (await hooks.persist({ blob, mimeType, format })) === true;
  } catch {
    saved = false;
  }

  if (hooks.wanted && !hooks.wanted())
    return { blob, mimeType, format, saved, audio: null, decodeError: null };
  hooks.onDecoding?.();
  try {
    const audio = describeMix(await deps.decode(bytes.slice(0)), deps.mixPeaks);
    return { blob, mimeType, format, saved, audio, decodeError: null };
  } catch (error) {
    return {
      blob,
      mimeType,
      format,
      saved,
      audio: null,
      decodeError: error ?? new Error("decode failed"),
    };
  }
}
