/**
 * Export of the current work. Files are always built from the committed
 * work — `project.config.volumes` for the full mix, one named stem at its
 * fader, the stored bytes of a cloud result, or the recipe as JSON. What the
 * player happens to be doing (solo, listening volume, audition loop) is not
 * an input here at all.
 */
import { encodeWav, fadeChannels, mixStems } from "../audio/engine";
import type { MixdownSource } from "../audio/engine";
import { TRACKS } from "../music/score";
import { saveFile } from "../platform";
import type { FileFormat } from "../platform";
import { originalFormat, originalFormatLabel } from "../providers";
import { exportProject } from "../storage";
import type { AudioFormat, Project, TrackName } from "../types";
import type { ExportRequest, LoadedAudio } from "../state/types";

export const STEM_LABELS: Record<TrackName, string> = {
  melody: "旋律",
  chords: "和声",
  bass: "贝斯",
  drums: "鼓组",
};

export const LOOP_REPEATS = [1, 2, 4] as const;
const WAV_HEADER_BYTES = 44;
/** WAV sizes are 32-bit; stay well inside what the desktop save IPC accepts. */
const MAX_WAV_BYTES = 250 * 1024 * 1024;

export interface ExportDeps {
  mixStems: typeof mixStems;
  encodeWav: (buffer: AudioBuffer) => ArrayBuffer;
  saveFile: typeof saveFile;
  exportProject: typeof exportProject;
  /**
   * Awaited before each heavy step of a WAV export (mixing, encoding,
   * repeating), so the interface can show "正在准备文件…" and stay responsive:
   * two minutes of audio are several hundred milliseconds of work on the main
   * thread. Optional — without it the export runs in one go.
   */
  breathe?: () => Promise<void>;
  /**
   * The finished WAV (mixed, clipped, faded, encoded) built off the UI thread
   * — the engine's mixdownInWorker. Resolves null when that is not possible
   * right now; the file is then built here with mixStems and encodeWav, and
   * is the same bytes. Optional.
   */
  mixdown?: (
    source: MixdownSource,
    fade?: boolean,
  ) => Promise<ArrayBuffer | null>;
}

const defaults: ExportDeps = { mixStems, encodeWav, saveFile, exportProject };

export type ExportOptionId =
  "mix" | `stem-${TrackName}` | "original" | "project";

export interface ExportOption {
  /** data-testid: export-option-<id> */
  id: ExportOptionId;
  request: ExportRequest;
  title: string;
  detail: string;
}

export interface ExportChoices {
  options: ExportOption[];
  /** 循环次数 1 / 2 / 4 applies to the full mix */
  canRepeat: boolean;
  /** the v0.2 1 s fade in/out applies to the full mix */
  canFade: boolean;
}

/**
 * What can be exported for this work, in display order. A cloud work whose
 * audio could not be decoded still offers its original file.
 */
export function exportChoices(
  project: Project | null,
  audio: LoadedAudio | null,
): ExportChoices {
  const none: ExportChoices = { options: [], canRepeat: false, canFade: false };
  if (!project) return none;
  const options: ExportOption[] = [];
  const local = project.provider === "local";
  const loop = project.config.loop;
  if (audio)
    options.push({
      id: "mix",
      request: { kind: "mix" },
      title: "完整混音 WAV",
      detail: `${Math.round(audio.sampleRate / 100) / 10} kHz · 16-bit · 立体声${
        audio.kind === "stems" ? " · 按当前推子混音" : ""
      }`,
    });
  if (audio?.kind === "stems")
    for (const track of TRACKS)
      options.push({
        id: `stem-${track}`,
        request: { kind: "stem", track },
        title: `${STEM_LABELS[track]}分轨 WAV`,
        detail: "单独一轨，保留当前推子音量",
      });
  if (project.audioBlob)
    options.push({
      id: "original",
      request: { kind: "original" },
      title: "原始音频",
      detail: `${originalFormatLabel(project.audioBlob.type)} · 服务商返回的原始文件，不做任何处理`,
    });
  if (local)
    options.push({
      id: "project",
      request: { kind: "project" },
      title: "工程文件 JSON",
      detail: "保存编曲设置、旋律和对话，可重新导入继续调整",
    });
  return {
    options,
    canRepeat: !!audio && audio.kind === "stems" && loop,
    canFade: !!audio && !loop && (audio.kind === "mix" || audio.engine === 1),
  };
}

/**
 * The container of an audio file by its first bytes, for a Blob whose MIME
 * type is missing or unknown: paid audio is still saved under a name that
 * opens. null when the bytes are none of the four formats.
 */
export function sniffAudioFormat(data: ArrayBuffer): AudioFormat | null {
  const bytes = new Uint8Array(data, 0, Math.min(12, data.byteLength));
  const ascii = (from: number, text: string) =>
    bytes.length >= from + text.length &&
    [...text].every(
      (char, index) => bytes[from + index] === char.charCodeAt(0),
    );
  if (ascii(0, "RIFF") && ascii(8, "WAVE")) return "wav";
  if (ascii(0, "fLaC")) return "flac";
  if (ascii(4, "ftyp")) return "m4a";
  // ID3 tag, or an MPEG audio frame sync
  if (ascii(0, "ID3")) return "mp3";
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)
    return "mp3";
  return null;
}

/** File name without extension: title, version (from v2 on) and what it is. */
export function exportName(project: Project, request: ExportRequest): string {
  const base = `${project.title}${project.revision > 1 ? ` v${project.revision}` : ""}`;
  switch (request.kind) {
    case "stem":
      return `${base}-${STEM_LABELS[request.track]}`;
    case "mix":
      return (request.repeats ?? 1) > 1
        ? `${base}-循环x${request.repeats}`
        : base;
    default:
      return base;
  }
}

/** The v0.2 fade: up to 1 s in and out, never more than a third of the audio. */
export function applyFade(buffer: AudioBuffer): void {
  const channels: Float32Array[] = [];
  for (let channel = 0; channel < buffer.numberOfChannels; channel++)
    channels.push(buffer.getChannelData(channel));
  fadeChannels(channels, buffer.length, buffer.sampleRate);
}

/**
 * Repeat the audio of a 16-bit PCM WAV file `times` times, sample-exact and
 * without any gap or crossfade: a loop rendered to wrap seamlessly stays
 * seamless at every joint.
 */
export function repeatWav(wav: ArrayBuffer, times: number): ArrayBuffer {
  const count = Math.max(1, Math.floor(times));
  if (count === 1) return wav;
  const source = new Uint8Array(wav);
  const dataBytes = source.byteLength - WAV_HEADER_BYTES;
  if (dataBytes <= 0) return wav;
  const total = WAV_HEADER_BYTES + dataBytes * count;
  if (total > MAX_WAV_BYTES)
    throw new Error("循环后的文件过大，请减少循环次数。");
  const result = new Uint8Array(total);
  result.set(source.subarray(0, WAV_HEADER_BYTES), 0);
  for (let i = 0; i < count; i++)
    result.set(
      source.subarray(WAV_HEADER_BYTES),
      WAV_HEADER_BYTES + i * dataBytes,
    );
  const view = new DataView(result.buffer);
  view.setUint32(4, 36 + dataBytes * count, true);
  view.setUint32(40, dataBytes * count, true);
  return result.buffer;
}

function copyBuffer(buffer: AudioBuffer): AudioBuffer {
  const copy = new AudioBuffer({
    length: buffer.length,
    numberOfChannels: buffer.numberOfChannels,
    sampleRate: buffer.sampleRate,
  });
  for (let channel = 0; channel < buffer.numberOfChannels; channel++)
    copy.getChannelData(channel).set(buffer.getChannelData(channel));
  return copy;
}

export interface ExportFile {
  name: string;
  data: ArrayBuffer;
  format: FileFormat;
}

/** Build the bytes of one export. Throws a ready-to-show Error when impossible. */
export async function buildExport(
  project: Project,
  audio: LoadedAudio | null,
  request: ExportRequest,
  deps: Pick<
    ExportDeps,
    "mixStems" | "encodeWav" | "exportProject" | "breathe" | "mixdown"
  > = defaults,
): Promise<ExportFile> {
  const name = exportName(project, request);
  const breathe = async () => {
    await deps.breathe?.();
  };
  /** The file from the worker, or null: then it is built on this thread. */
  const offThread = async (source: MixdownSource, fade = false) => {
    try {
      return (await deps.mixdown?.(source, fade)) ?? null;
    } catch {
      return null;
    }
  };
  switch (request.kind) {
    case "project": {
      if (project.provider !== "local")
        throw new Error(
          "云端作品的工程文件不包含音频，无法单独恢复。请导出音频。",
        );
      const text = deps.exportProject(project);
      return {
        name,
        data: new TextEncoder().encode(text).buffer as ArrayBuffer,
        format: "json",
      };
    }
    case "original": {
      const blob = project.audioBlob;
      if (!blob) throw new Error("这首作品没有可导出的原始音频。");
      // Exact bytes: no fade, no re-encoding.
      const data = await blob.arrayBuffer();
      const format = originalFormat(blob.type) ?? sniffAudioFormat(data);
      if (format) return { name, data, format };
      // Not a container this build can name. With decoded audio a WAV is the
      // better file; without it these bytes are all there is, and they are
      // handed over as they are rather than withheld.
      if (audio) throw new Error("无法识别原始音频的格式，请改为导出 WAV。");
      return { name: `${name}-未知格式`, data, format: "mp3" };
    }
    case "stem": {
      if (audio?.kind !== "stems")
        throw new Error("这首作品没有分轨，只能导出完整音频。");
      if (!TRACKS.includes(request.track)) throw new Error("没有这条音轨。");
      await breathe();
      const made = await offThread({
        kind: "stems",
        stems: audio.stems,
        volumes: project.config.volumes,
        engine: audio.engine,
        only: request.track,
      });
      if (made) return { name, data: made, format: "wav" };
      const stem = deps.mixStems(
        audio.stems,
        project.config.volumes,
        audio.engine,
        request.track,
      );
      await breathe();
      return { name, data: deps.encodeWav(stem), format: "wav" };
    }
    case "mix": {
      if (!audio) throw new Error("音频还没有准备好，无法导出 WAV。");
      const choices = exportChoices(project, audio);
      const fade = !!request.fade && choices.canFade;
      await breathe();
      let wav = await offThread(
        audio.kind === "stems"
          ? {
              kind: "stems",
              stems: audio.stems,
              volumes: project.config.volumes,
              engine: audio.engine,
            }
          : { kind: "buffer", buffer: audio.buffer },
        fade,
      );
      if (!wav) {
        let mix =
          audio.kind === "stems"
            ? deps.mixStems(audio.stems, project.config.volumes, audio.engine)
            : audio.buffer;
        if (fade) {
          // mixStems returns a fresh buffer; a decoded cloud mix must be copied.
          if (audio.kind === "mix") mix = copyBuffer(mix);
          applyFade(mix);
        }
        await breathe();
        wav = deps.encodeWav(mix);
      }
      const repeats =
        choices.canRepeat && LOOP_REPEATS.includes(request.repeats ?? 1)
          ? (request.repeats ?? 1)
          : 1;
      if (repeats > 1) await breathe();
      return {
        name: exportName(project, { kind: "mix", repeats }),
        data: repeatWav(wav, repeats),
        format: "wav",
      };
    }
  }
}

/** Build one export and hand it to the user (save dialog or download). */
export async function exportWork(
  project: Project,
  audio: LoadedAudio | null,
  request: ExportRequest,
  deps: ExportDeps = defaults,
): Promise<{ saved: boolean; path?: string; name: string }> {
  const file = await buildExport(project, audio, request, deps);
  const result = await deps.saveFile(file);
  return { ...result, name: file.name };
}
