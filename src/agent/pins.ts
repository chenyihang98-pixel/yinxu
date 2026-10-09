/**
 * Pins: what the user fixed by hand in the UI for one message (a style chip,
 * a duration, the loop switch…). Both brains read them through this module,
 * and both let them win over anything inferred from the text.
 */
import type { MusicConfig } from "../types";
import {
  LIMITS,
  instrumentLabel,
  isInstrumentId,
  isKey,
  isStyleId,
  styleLabel,
} from "../music/catalog";
import { clamp } from "../music/defaults";
import type { AgentRequest } from "./types";
import { keyLabel } from "./cloudPrompt";

export type Pins = NonNullable<AgentRequest["pins"]>;

/**
 * Starts the line that tells a language model about the pins. The system
 * prompt in electron/agent/plan-schema.cjs explains this line by the same mark.
 */
export const PIN_MARK = "【界面选定】";

/**
 * Only well-formed pins, read from own properties; numbers are clamped into
 * the engine's ranges.
 */
export function readPins(request: AgentRequest): Pins {
  const raw: unknown = request?.pins;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const get = (name: keyof Pins): unknown =>
    Object.prototype.hasOwnProperty.call(raw, name)
      ? (raw as Record<string, unknown>)[name]
      : undefined;
  const whole = (value: unknown, [low, high]: [number, number]) =>
    typeof value === "number" && Number.isFinite(value)
      ? Math.round(clamp(value, low, high))
      : undefined;
  const pins: Pins = {};
  const mood = get("mood");
  if (isStyleId(mood)) pins.mood = mood;
  const instrument = get("instrument");
  if (isInstrumentId(instrument)) pins.instrument = instrument;
  const key = get("key");
  if (isKey(key)) pins.key = key;
  const bpm = whole(get("bpm"), LIMITS.bpm);
  if (bpm !== undefined) pins.bpm = bpm;
  const duration = whole(get("duration"), LIMITS.duration);
  if (duration !== undefined) pins.duration = duration;
  const loop = get("loop");
  if (typeof loop === "boolean") pins.loop = loop;
  return pins;
}

/** `config` with every pinned value in place (the pins must come from readPins). */
export function withPins(config: MusicConfig, pins: Pins): MusicConfig {
  return { ...config, ...pins };
}

/** How the reasoning mentions the pinned choices; [] without pins. */
export function describePins(pins: Pins): string[] {
  const lines: string[] = [];
  if (pins.mood) lines.push(`按你选的「${styleLabel(pins.mood)}」风格来编`);
  const fixed = [
    ...(pins.instrument ? [`${instrumentLabel(pins.instrument)}主奏`] : []),
    ...(pins.key ? [keyLabel(pins.key)] : []),
    ...(pins.bpm !== undefined ? [`${pins.bpm} BPM`] : []),
    ...(pins.duration !== undefined ? [`${pins.duration} 秒`] : []),
    ...(pins.loop !== undefined ? [pins.loop ? "循环片段" : "完整结尾"] : []),
  ];
  if (fixed.length) lines.push(`按你的设定：${fixed.join("、")}`);
  return lines;
}

/** One line for a language model, in the field names of its plan; "" without pins. */
export function pinNote(pins: Pins): string {
  const parts = [
    ...(pins.mood ? [`style=${pins.mood}（${styleLabel(pins.mood)}）`] : []),
    ...(pins.instrument
      ? [`instrument=${pins.instrument}（${instrumentLabel(pins.instrument)}）`]
      : []),
    ...(pins.key ? [`key=${pins.key}`] : []),
    ...(pins.bpm !== undefined ? [`bpm=${pins.bpm}`] : []),
    ...(pins.duration !== undefined ? [`duration=${pins.duration}`] : []),
    ...(pins.loop !== undefined ? [`loop=${pins.loop}`] : []),
  ];
  return parts.length ? `${PIN_MARK}${parts.join("；")}` : "";
}
