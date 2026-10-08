/**
 * Style registry: one StyleDef per catalog style. To add a style, write
 * `src/music/styles/<id>.ts` exporting a StyleDef (see types.ts) and register
 * it here; `Record<StyleId, …>` makes the compiler insist that every catalog
 * id has one.
 */
import type { StyleId } from "../catalog";
import { acoustic } from "./acoustic";
import { ambient } from "./ambient";
import { battle } from "./battle";
import { bright } from "./bright";
import { chill } from "./chill";
import { chiptune } from "./chiptune";
import { cinematic } from "./cinematic";
import { corporate } from "./corporate";
import { cute } from "./cute";
import { dance } from "./dance";
import { dreamy } from "./dreamy";
import { epic } from "./epic";
import { festive } from "./festive";
import { focus } from "./focus";
import { guofeng } from "./guofeng";
import { hiphop } from "./hiphop";
import { jazz } from "./jazz";
import { retro } from "./retro";
import { rock } from "./rock";
import { romantic } from "./romantic";
import { sad } from "./sad";
import { tension } from "./tension";
import type { StyleDef } from "./types";

export const STYLE_DEFS: Record<StyleId, StyleDef> = {
  bright,
  chill,
  cinematic,
  dreamy,
  focus,
  retro,
  epic,
  chiptune,
  guofeng,
  jazz,
  acoustic,
  tension,
  cute,
  battle,
  ambient,
  corporate,
  sad,
  dance,
  hiphop,
  rock,
  romantic,
  festive,
};

/** The StyleDef that renders a catalog style (never throws: unknown ids fall back to bright). */
export function getStyle(id: StyleId): StyleDef {
  return STYLE_DEFS[id] ?? bright;
}

export type { StyleDef } from "./types";
