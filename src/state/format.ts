/** Small display helpers shared by any UI built on the state layer. Pure. */
import { keyLabel } from "../agent/cloudPrompt";
import { instrumentLabel, styleInfo, styleLabel } from "../music/catalog";
import type { StyleId } from "../music/catalog";
import { providerName } from "../providers";
import type { MusicConfig, Project } from "../types";
import { fittedTiming } from "./score";
import { projectDuration } from "./works";

/** 72.4 → "1:12" */
export function formatTime(seconds: number): string {
  const total =
    Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** 1536 → "1.5 KB" */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(
    units.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024)),
  );
  const value = bytes / 1024 ** index;
  return `${value >= 100 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
}

/** ISO timestamp → "10月9日 14:05" (local time); "" when unreadable. */
export function formatDate(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** CSS-only cover art from the style's two palette colours. */
export function coverGradient(mood: StyleId): string {
  const [from, to] = styleInfo(mood).palette;
  return `linear-gradient(135deg, ${from}, ${to})`;
}

/** 117.33 → "117.3", 144 → "144": a tempo as it is, without false precision. */
export function formatBpm(bpm: number): string {
  const rounded = Math.round(bpm);
  return Math.abs(bpm - rounded) < 0.05 ? String(rounded) : bpm.toFixed(1);
}

/** 18 → "18", 29.33 → "29.3": a length in seconds. */
export function formatSeconds(seconds: number): string {
  const rounded = Math.round(seconds);
  return Math.abs(seconds - rounded) < 0.05
    ? String(rounded)
    : seconds.toFixed(1);
}

/** "循环片段" / "完整结尾": the one pair of names for a work's structure. */
export function structureLabel(loop: boolean): string {
  return loop ? "循环片段" : "完整结尾";
}

/** What the audio of a work really is, next to what was asked for. */
export interface WorkTiming {
  /**
   * Tempo of the audio. null for a cloud work: the service was given a
   * description, and nothing measures what it played.
   */
  bpm: number | null;
  /** seconds of audio */
  duration: number;
  /** the tempo in the settings, when the audio's differs from it */
  askedBpm?: number;
  /** the length in the settings, when the audio's differs from it */
  askedDuration?: number;
}

/**
 * The tempo and length to show for a work. `actual` is what its loaded audio
 * says (the arrangement's tempo, the buffer's length); without it the answer
 * comes from the composer's own planning for a current local work, and from
 * the stored length otherwise.
 */
export function workTiming(
  project: Project,
  actual?: { bpm?: number; duration?: number } | null,
): WorkTiming {
  const { config } = project;
  const local = project.provider === "local";
  const fitted = local && config.engine === 2 ? fittedTiming(config) : null;
  const bpm = !local ? null : (actual?.bpm ?? fitted?.bpm ?? config.bpm);
  const duration =
    actual?.duration ??
    project.audioDuration ??
    fitted?.duration ??
    config.duration;
  return {
    bpm,
    duration,
    ...(bpm !== null && formatBpm(bpm) !== String(config.bpm)
      ? { askedBpm: config.bpm }
      : {}),
    ...(Math.abs(duration - config.duration) >= 0.05
      ? { askedDuration: config.duration }
      : {}),
  };
}

/**
 * "国风古韵 · 76.8 BPM · D 大调 · 古筝 · 循环片段" — what the work is. The tempo
 * is the audio's own. A cloud work was generated from a description, so its
 * line is worded as that request and carries no tempo claim of its own.
 */
export function metaLine(
  project: Project,
  actual?: { bpm?: number; duration?: number } | null,
): string {
  const { config } = project;
  const timing = workTiming(project, actual);
  const parts = [
    styleLabel(config.mood),
    timing.bpm === null
      ? `约 ${config.bpm} BPM`
      : `${formatBpm(timing.bpm)} BPM`,
    keyLabel(config.key),
    instrumentLabel(config.instrument),
    structureLabel(config.loop),
  ].join(" · ");
  return timing.bpm === null ? `生成要求：${parts}` : parts;
}

/** Badge text for the engine that made a work. */
export function engineBadge(project: Project): string {
  if (project.provider !== "local") return providerName(project.provider);
  return project.config.engine === 1 ? "旧版引擎" : "本地作曲";
}

/**
 * "国风古韵 · 76.8 BPM · 0:30 · 本地作曲" — one line for a library card, with
 * the tempo and length of the audio. A cloud work has no known tempo.
 */
export function cardLine(project: Project): string {
  const timing = workTiming(project);
  return [
    styleLabel(project.config.mood),
    ...(timing.bpm === null ? [] : [`${formatBpm(timing.bpm)} BPM`]),
    formatTime(projectDuration(project)),
    engineBadge(project),
  ].join(" · ");
}

/** Text for the save indicator next to the title. */
export function saveStateLabel(state: "idle" | "saving" | "saved" | "failed") {
  switch (state) {
    case "saving":
      return "保存中…";
    case "failed":
      return "保存失败 · 请先导出";
    default:
      return "已保存";
  }
}

/**
 * The settings behind a work whose audio differs from them — secondary to the
 * real values in the meta line. A loop is fitted to whole bars: either the
 * tempo moves a little so the asked length closes on a bar line, or the tempo
 * is kept and the length does. null when the audio is exactly as asked.
 */
export function fitNotice(
  project: Project,
  actual?: { bpm?: number; duration?: number } | null,
): string | null {
  const { config } = project;
  const timing = workTiming(project, actual);
  const asked: string[] = [];
  if (timing.askedBpm !== undefined) asked.push(`${timing.askedBpm} BPM`);
  if (timing.askedDuration !== undefined)
    asked.push(`${timing.askedDuration} 秒`);
  if (!asked.length) return null;
  const now: string[] = [];
  if (timing.askedBpm !== undefined && timing.bpm !== null)
    now.push(`${formatBpm(timing.bpm)} BPM`);
  if (timing.askedDuration !== undefined)
    now.push(`${formatSeconds(timing.duration)} 秒`);
  const set = `设定 ${asked.join("、")}`;
  const real = now.join("、");
  if (project.provider !== "local")
    return `${set}；云端生成的音频实际是 ${real}`;
  return config.loop
    ? `${set}；循环片段按整小节对齐，实际是 ${real}`
    : `${set}；实际是 ${real}`;
}

/**
 * For the inspector: what a draft's tempo and length will really be when it
 * is applied by the local engine, when that differs from the numbers in the
 * fields. Empty for a draft that comes out exactly as set.
 */
export function draftFit(config: MusicConfig): {
  bpm?: string;
  duration?: string;
} {
  if (config.engine !== 2) return {};
  const fitted = fittedTiming(config);
  return {
    ...(formatBpm(fitted.bpm) !== String(config.bpm)
      ? { bpm: `循环片段按整小节对齐：实际 ${formatBpm(fitted.bpm)} BPM` }
      : {}),
    ...(Math.abs(fitted.duration - config.duration) >= 0.05
      ? {
          duration: `循环片段按整小节对齐：实际 ${formatSeconds(fitted.duration)} 秒（${fitted.bars} 小节）`,
        }
      : {}),
  };
}

export function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}
