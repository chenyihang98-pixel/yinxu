/** Small display helpers shared by any UI built on the state layer. Pure. */
import { keyLabel } from "../agent/cloudPrompt";
import { instrumentLabel, styleInfo, styleLabel } from "../music/catalog";
import type { StyleId } from "../music/catalog";
import { providerName } from "../providers";
import type { Project } from "../types";
import { projectDuration } from "./works";

/** 72.4 → "1:12" */
export function formatTime(seconds: number): string {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
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

/** "国风古韵 · 78 BPM · D 大调 · 古筝" */
export function metaLine(project: Project): string {
  const { config } = project;
  return [
    styleLabel(config.mood),
    `${config.bpm} BPM`,
    keyLabel(config.key),
    instrumentLabel(config.instrument),
  ].join(" · ");
}

/** Badge text for the engine that made a work. */
export function engineBadge(project: Project): string {
  if (project.provider !== "local") return providerName(project.provider);
  return project.config.engine === 1 ? "旧版引擎" : "本地作曲";
}

/** "国风古韵 · 78 BPM · 0:30 · 本地作曲" — one line for a library card. */
export function cardLine(project: Project): string {
  return [
    styleLabel(project.config.mood),
    `${project.config.bpm} BPM`,
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
 * Why the audio is not exactly what was asked: loops snap to whole bars and
 * the composer may settle on a slightly different tempo. null when it matches.
 */
export function fitNotice(
  project: Project,
  actual: { bpm?: number; duration: number } | null | undefined,
): string | null {
  if (!actual) return null;
  const { config } = project;
  const parts: string[] = [];
  if (actual.bpm !== undefined && Math.round(actual.bpm) !== config.bpm)
    parts.push(`实际速度 ${Math.round(actual.bpm)} BPM（设定 ${config.bpm}）`);
  if (Math.abs(actual.duration - config.duration) >= 0.5)
    parts.push(
      `实际时长 ${actual.duration.toFixed(1)} 秒（设定 ${config.duration} 秒${
        config.loop && project.provider === "local" ? "，循环按整小节取整" : ""
      }）`,
    );
  return parts.length ? parts.join("；") : null;
}

export function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}
