/**
 * The offline producer brain: reads one request with the lexicon, resolves
 * negation and level words, scores every style, and returns a complete plan.
 * Pure and deterministic — no network, no clock, no randomness.
 */
import type { ArrangementHints, MusicConfig, TrackName } from "../types";
import {
  LIMITS,
  STYLE_IDS,
  instrumentLabel,
  styleInfo,
  styleLabel,
  type InstrumentId,
  type StyleId,
} from "../music/catalog";
import {
  DEFAULT_VOLUMES,
  clamp,
  clampConfig,
  stylePreset,
} from "../music/defaults";
import type { AgentPlan, AgentRequest } from "./types";
import {
  TRACK_LABELS,
  buildCloudPrompt,
  describeChanges,
  keyLabel,
} from "./cloudPrompt";
import {
  STYLE_COORDS,
  STYLE_LEADS,
  analyse,
  gapBetween,
  withMode,
  type Analysis,
  type Dim,
  type Lex,
  type Target,
  type Token,
} from "./lexicon";

const TRACKS: TrackName[] = ["melody", "chords", "bass", "drums"];
const isTrack = (target: Target): target is TrackName =>
  (TRACKS as string[]).includes(target);
/** Styles that suit a request whose style could not be told. */
const NEUTRAL: StyleId[] = [
  "bright",
  "acoustic",
  "chill",
  "focus",
  "cinematic",
  "dreamy",
  "romantic",
  "sad",
];
const WEAK = 1.2;
/** Styles defined by their lead sound: it survives when another style wins. */
const SIGNATURE_LEADS: [StyleId, InstrumentId][] = [
  ["guofeng", "guzheng"],
  ["chiptune", "chip"],
];
const DURATION_STEPS = [15, 30, 45, 60, 90, 120];
const STEP: Record<Dim, number> = {
  energy: 0.2,
  complexity: 0.25,
  reverb: 0.25,
  tempo: 12,
};

interface Word extends Token {
  neg?: "hard" | "too";
  /** "太…" in front, or inside "不要太…" */
  too?: boolean;
  /** has "一点 / 更 / 再 / 稍微 / 很多" attached: a relative request */
  compared?: boolean;
  very?: boolean;
  scale: number;
  changed?: boolean;
  suffixed?: boolean;
  flavour?: boolean;
  added?: boolean;
  /** "把 X 换成 Y": X is what gets replaced */
  replaced?: boolean;
  /** an instrument word that only carried a volume request ("钢琴太响了") */
  leveled?: boolean;
  solo?: boolean;
  /** already consumed as the level word of a mixer target */
  used?: boolean;
}

const isContent = (lex: Lex) =>
  !!(
    lex.w ||
    lex.inst ||
    lex.target ||
    lex.loop !== undefined ||
    lex.arr ||
    lex.dim ||
    lex.mode ||
    lex.seed ||
    lex.unsupported ||
    lex.length ||
    lex.percent !== undefined
  );
/** single characters such as 快 / 重 / 亮 only count next to a modifier */
const needsModifier = (word: Word) =>
  word.text.length === 1 && !!(word.lex.dim || word.lex.mode || word.lex.length);
const modified = (word: Word) =>
  !!(word.compared || word.too || word.neg || word.very);

/** What the request asks for, before it is applied to a configuration. */
interface Intent {
  analysis: Analysis;
  words: Word[];
  lexical: Record<StyleId, number>;
  /** evidence from genre / scene / usage words only (drives style changes when refining) */
  strong: Record<StyleId, number>;
  explicitStyle: Set<StyleId>;
  flavourStyle: Set<StyleId>;
  evidence: Map<StyleId, string[]>;
  valence: number;
  arousal: number;
  /** arousal of emotion words only, for refinements that keep the style */
  feeling: number;
  leads: InstrumentId[];
  excluded: Set<InstrumentId>;
  soloLead: boolean;
  padFromStrings: boolean;
  trackOps: ((volumes: Record<TrackName, number>) => void)[];
  touchedDrums: boolean;
  delta: Record<Dim, number>;
  absolute: Partial<Record<Exclude<Dim, "tempo">, 1 | -1>>;
  tempoPos?: number;
  scenePos?: number;
  reverbSet?: number;
  modeExplicit?: "major" | "minor";
  modeVotes: Set<"major" | "minor">;
  loop?: boolean;
  impliedLoop?: boolean;
  newSeed: boolean;
  /** "换个风格": a full style change is wanted even if the style word is hedged */
  restyle: boolean;
  arrangement: ((hints: ArrangementHints) => void)[];
  lengthStep: number;
  short: boolean;
  noDrums: boolean;
  dnb: boolean;
  notes: string[];
  tags: string[];
}

function annotate(analysis: Analysis, mode: "new" | "refine"): Word[] {
  const { lower } = analysis;
  const words: Word[] = analysis.tokens
    .filter((token) => Object.keys(token.lex).length > 0)
    .map((token) => ({ ...token, scale: 1 }));
  const near = (a: number, b: number, max: number) =>
    a >= 0 &&
    b < words.length &&
    gapBetween(lower, words[a].end, words[b].start, max) !== null;

  // modifiers: "太", "更", "一点", "很多" …
  words.forEach((word, i) => {
    if (!isContent(word.lex)) return;
    const mods: Lex["mod"][] = [];
    for (let k = i - 1; k >= 0 && near(k, k + 1, 0); k--) {
      const lex = words[k].lex;
      if (lex.neg === "too") mods.push("too");
      else if (lex.mod) mods.push(lex.mod);
      else break;
    }
    for (let k = i + 1; k < words.length && near(k - 1, k, 0); k++) {
      if (!words[k].lex.mod) break;
      mods.push(words[k].lex.mod);
    }
    const complaint =
      mods.includes("somewhat") &&
      mode === "refine" &&
      !!(word.lex.dim || word.lex.op);
    if (mods.includes("too") || complaint) word.too = true;
    if (mods.includes("very")) word.very = true;
    if (
      mods.some((mod) => mod === "more" || mod === "slight" || mod === "lot") ||
      (mods.includes("somewhat") && !complaint)
    )
      word.compared = true;
    word.scale = mods.includes("lot")
      ? 1.75
      : mods.includes("slight") || (mods.includes("somewhat") && !complaint)
        ? 0.5
        : 1;
  });

  // negation scope: the first thing after the cue, plus anything listed with it
  words.forEach((cue, i) => {
    if (!cue.lex.neg) return;
    let kind = cue.lex.neg;
    let marked = false;
    for (let j = i + 1; j < words.length && near(j - 1, j, 2); j++) {
      const lex = words[j].lex;
      if (lex.brk || lex.change || lex.neg) break;
      if (lex.mod) {
        if (lex.mod === "too") kind = "too";
        continue;
      }
      if (!isContent(lex)) continue;
      words[j].neg = kind;
      marked = true;
      let last = j;
      while (
        words[last + 1]?.lex.link &&
        words[last + 2] &&
        isContent(words[last + 2].lex) &&
        near(last, last + 1, 1) &&
        near(last + 1, last + 2, 1)
      ) {
        last += 2;
        words[last].neg = kind;
      }
      break;
    }
    // "鼓不要了", "钢琴去掉": the cue closes its clause, so it refers backwards
    const rest = lower.slice(cue.end).split(/[,.;!?。；！？\n]/)[0];
    const closes =
      gapBetween(rest, 0, rest.length, 1) !== null &&
      !(words[i + 1] && words[i + 1].start < cue.end + rest.length);
    if (!marked && closes && i > 0 && near(i - 1, i, 1)) {
      const previous = words[i - 1];
      if (isContent(previous.lex) && !previous.neg) previous.neg = kind;
    }
  });

  // what stands directly around a word
  words.forEach((word, i) => {
    let before = i - 1;
    while (before >= 0 && words[before].lex.mod && near(before, before + 1, 0)) {
      if (words[before].lex.flavour) word.flavour = true;
      before--;
    }
    const previous = before >= 0 && near(before, before + 1, 2) ? words[before] : undefined;
    const next = near(i, i + 1, 1) ? words[i + 1] : undefined;
    if (previous?.lex.change) word.changed = true;
    if (next?.lex.change) word.replaced = true;
    if (previous?.lex.flavour || next?.lex.flavour) word.flavour = true;
    if (previous?.lex.op === "add" || previous?.lex.op === "unmute")
      word.added = true;
    if (next?.lex.suffix) word.suffixed = true;
    if (
      (previous?.lex.solo && near(before, before + 1, 0)) ||
      (next?.lex.solo && near(i, i + 1, 0))
    )
      word.solo = true;
  });
  return words;
}

function emptyScores(): Record<StyleId, number> {
  return Object.fromEntries(STYLE_IDS.map((id) => [id, 0])) as Record<
    StyleId,
    number
  >;
}

function interpret(text: string, mode: "new" | "refine"): Intent {
  const analysis = analyse(text);
  const words = annotate(analysis, mode);
  const { lower } = analysis;
  const intent: Intent = {
    analysis,
    words,
    lexical: emptyScores(),
    strong: emptyScores(),
    explicitStyle: new Set(),
    flavourStyle: new Set(),
    evidence: new Map(),
    valence: 0,
    arousal: 0,
    feeling: 0,
    leads: [],
    excluded: new Set(),
    soloLead: false,
    padFromStrings: false,
    trackOps: [],
    touchedDrums: false,
    delta: { energy: 0, complexity: 0, reverb: 0, tempo: 0 },
    absolute: {},
    modeVotes: new Set(),
    newSeed: false,
    restyle: words.some(
      (word, i) =>
        word.lex.change &&
        !!words[i + 1]?.lex.suffix &&
        gapBetween(lower, word.end, words[i + 1].start, 1) !== null,
    ),
    arrangement: [],
    lengthStep: 0,
    short: false,
    noDrums: false,
    dnb: false,
    notes: [],
    tags: [],
  };
  const note = (message: string) => {
    if (!intent.notes.includes(message)) intent.notes.push(message);
  };
  const near = (a: number, b: number, max: number) =>
    a >= 0 &&
    b < words.length &&
    gapBetween(lower, words[a].end, words[b].start, max) !== null;

  /* ----- mixer targets and the level words attached to them ----- */
  interface Level {
    kind: NonNullable<Lex["op"]> | "set" | "dim";
    dir: 1 | -1;
    scale: number;
    value?: number;
    pos?: number;
    compared: boolean;
  }
  /**
   * The level word attached to words[index]. Adjectives only count when they
   * describe `dim`; `strict` (instrument words) accepts plain volume words only.
   */
  const levelNear = (
    index: number,
    direction: 1 | -1,
    dim: Dim,
    strict = false,
  ): Level | undefined => {
    let invert = false;
    let scale = 1;
    let compared = false;
    for (
      let k = index + direction;
      k >= 0 && k < words.length;
      k += direction
    ) {
      if (!(direction > 0 ? near(k - 1, k, 2) : near(k, k + 1, 2))) break;
      const word = words[k];
      const lex = word.lex;
      if (lex.mod || lex.neg === "too") {
        const complaint = lex.mod === "somewhat" && mode === "refine";
        if (lex.mod === "too" || lex.neg === "too" || complaint) invert = true;
        if (lex.mod === "lot") scale = 1.75;
        if (lex.mod === "slight" || (lex.mod === "somewhat" && !complaint))
          scale = 0.5;
        if (lex.mod && lex.mod !== "too" && lex.mod !== "very" && !complaint)
          compared = true;
        continue;
      }
      if (word.used) break;
      const flip = (dir: 1 | -1): 1 | -1 =>
        (invert && !lex.fixed ? -dir : dir) as 1 | -1;
      // "重低音", "太多鼓": a one-character weight word in front of the track
      if (direction < 0 && word.text.length === 1 && near(k, k + 1, 0)) {
        const dir =
          lex.dim === "energy" && dim === "energy"
            ? lex.dir
            : word.text === "多"
              ? 1
              : word.text === "少"
                ? -1
                : undefined;
        if (dir) {
          word.used = true;
          // look further left for "太" / "不要这么"
          for (let t = k - 1; t >= 0 && near(t, t + 1, 0); t--) {
            const mod = words[t].lex;
            if (mod.mod === "too" || mod.neg === "too") invert = true;
            else if (!mod.mod) break;
          }
          return { kind: "dim", dir: flip(dir), scale, compared };
        }
      }
      // modifiers that follow the level word ("重一点", "大很多")
      const trailing = () => {
        for (let t = k + 1; t < words.length && near(t - 1, t, 0); t++) {
          const mod = words[t].lex.mod;
          if (!mod) break;
          if (mod === "lot") scale = 1.75;
          if (mod === "slight") scale = 0.5;
          if (mod !== "too" && mod !== "very") compared = true;
        }
      };
      if (lex.percent !== undefined && direction > 0) {
        word.used = true;
        return { kind: "set", dir: 1, scale, value: lex.percent / 100, compared };
      }
      const sideOk =
        lex.side === "both" || lex.side === (direction > 0 ? "post" : "pre");
      if (lex.op && sideOk && !(strict && (lex.op === "add" || lex.op === "unmute" || lex.op === "only"))) {
        word.used = true;
        if (direction > 0) trailing();
        const dir = lex.op === "down" ? -1 : 1;
        return {
          kind: lex.op,
          dir: lex.op === "up" || lex.op === "down" ? flip(dir) : dir,
          scale,
          compared,
        };
      }
      if (
        lex.dim === dim &&
        direction > 0 &&
        lex.dir &&
        !(strict && word.text.length > 1 && !lex.fixed)
      ) {
        word.used = true;
        trailing();
        return {
          kind: "dim",
          dir: flip(lex.dir),
          scale,
          pos: lex.pos,
          compared,
        };
      }
      break;
    }
    return undefined;
  };

  for (let i = 0; i < words.length; i++) {
    if (!words[i].lex.target || words[i].used) continue;
    const group = [i];
    let last = i;
    while (
      words[last + 1]?.lex.link &&
      words[last + 2]?.lex.target &&
      near(last, last + 1, 1) &&
      near(last + 1, last + 2, 1)
    ) {
      last += 2;
      group.push(last);
    }
    for (const index of group) words[index].used = true;
    const targets = group.map((index) => words[index].lex.target as Target);
    const negated = group.some((index) => words[index].neg === "hard");
    const only = group.some((index) => words[index].solo);
    const dimOf = (target: Target): Dim => (isTrack(target) ? "energy" : target);
    const level = negated
      ? undefined
      : (levelNear(group[0], -1, dimOf(targets[0])) ??
        levelNear(last, 1, dimOf(targets[targets.length - 1])));

    if (
      !negated &&
      !level &&
      !only &&
      targets.join() === "drums,bass" &&
      (mode === "new" || words[i].changed)
    ) {
      intent.dnb = true;
      continue;
    }
    if (!negated && !level && !only) continue;

    for (const target of targets) {
      if (isTrack(target)) {
        if (target === "drums") intent.touchedDrums = true;
        intent.trackOps.push((volumes) => {
          const base = DEFAULT_VOLUMES[target];
          const current = volumes[target];
          if (negated || level?.kind === "mute") volumes[target] = 0;
          else if (only || level?.kind === "only") {
            for (const other of TRACKS)
              if (!targets.includes(other)) volumes[other] = 0;
            if (current === 0) volumes[target] = base;
          } else if (level?.kind === "set")
            volumes[target] = clamp(level.value ?? current, 0, 1);
          else if (level?.kind === "unmute") {
            volumes[target] = Math.max(current, base);
            if (current >= base) note(`${TRACK_LABELS[target]}本来就是打开的`);
          }
          else if (level?.kind === "add")
            volumes[target] =
              current === 0 ? base : clamp(current + 0.15 * level.scale, 0, 1);
          else if (level)
            volumes[target] = clamp(
              current + level.dir * 0.2 * level.scale,
              0,
              1,
            );
          volumes[target] = Math.round(volumes[target] * 100) / 100;
        });
        continue;
      }
      if (target === "reverb" && (negated || level?.kind === "mute")) {
        intent.reverbSet = 0;
        continue;
      }
      if (!level || level.kind === "only" || level.kind === "mute") continue;
      if (level.kind === "set") {
        if (target === "reverb") intent.reverbSet = clamp(level.value ?? 0, 0, 1);
        continue;
      }
      if (target === "tempo" && level.pos !== undefined && !level.compared)
        intent.tempoPos = level.pos;
      else intent.delta[target] += level.dir * STEP[target] * level.scale;
    }
  }

  // "钢琴太响了", "吉他小一点": the lead instrument stands for the melody fader
  words.forEach((word, i) => {
    if (!word.lex.inst || word.lex.cat || word.neg || word.used) return;
    const level = levelNear(i, 1, "energy", true);
    if (!level) return;
    word.leveled = true;
    intent.trackOps.push((volumes) => {
      const current = volumes.melody;
      volumes.melody =
        level.kind === "mute"
          ? 0
          : level.kind === "set"
            ? clamp(level.value ?? current, 0, 1)
            : Math.round(clamp(current + level.dir * 0.2 * level.scale, 0, 1) * 100) / 100;
    });
  });

  /* ----- everything else, word by word ----- */
  words.forEach((word, i) => {
    const lex = word.lex;
    if (word.used && !lex.w) return;
    const gated = needsModifier(word) && !modified(word);
    const negative = word.neg === "hard";

    if (lex.unsupported && !word.neg) note(lex.unsupported);
    if (lex.note && lex.inst && !word.neg) note(`${word.text}：${lex.note}`);
    if (lex.tag && !word.neg) intent.tags.push(lex.tag);
    if (lex.seed && !word.neg) intent.newSeed = true;
    if (lex.short && !word.neg) intent.short = true;
    if (lex.noDrums && !word.neg) intent.noDrums = true;

    if (lex.loop !== undefined) {
      const value = negative ? !lex.loop : lex.loop;
      if (lex.w) intent.impliedLoop = value;
      else intent.loop = value;
    }

    if (lex.arr) {
      const hint = lex.arr;
      const swing = word.scale > 1 ? 0.62 : word.scale < 1 ? 0.3 : 0.5;
      intent.arrangement.push((hints) => {
        for (const layer of ["pad", "arp", "counter", "perc"] as const)
          if (hint[layer] !== undefined)
            hints.layers = { ...hints.layers, [layer]: !negative };
        if (hint.swing !== undefined) hints.swing = negative ? 0 : swing;
        if (hint.drums && !negative) hints.drums = hint.drums;
        if (hint.bass && !negative) hints.bass = hint.bass;
        if (hint.register && !negative)
          hints.melody = { ...hints.melody, register: hint.register };
        if (hint.motion && !negative)
          hints.melody = { ...hints.melody, motion: hint.motion };
      });
    }

    if (lex.length && !gated && !word.neg) {
      const previous = words[i - 1];
      if (previous?.lex.section && near(i - 1, i, 1))
        note("暂时不能单独调整某一段的长度");
      else intent.lengthStep += lex.length;
    }
    if (lex.section) note("暂时不能只修改某一个段落，已按整首处理");

    if (lex.mode && !gated) {
      const flipped = negative || word.too || word.neg === "too";
      if (!lex.w && !lex.dim)
        intent.modeExplicit = !flipped
          ? lex.mode
          : lex.mode === "major"
            ? "minor"
            : "major";
      else if (!flipped) intent.modeVotes.add(lex.mode);
    }

    if (lex.dim && lex.dir && !word.used && !gated) {
      const inverted = (word.too || !!word.neg) && !lex.fixed;
      const dir = (inverted ? -lex.dir : lex.dir) as 1 | -1;
      if (lex.dim === "tempo") {
        if (lex.pos !== undefined && !inverted && !word.compared)
          intent.tempoPos = lex.pos;
        else intent.delta.tempo += dir * STEP.tempo * word.scale;
      } else if (
        mode === "new" &&
        !word.compared &&
        !inverted &&
        !lex.fixed
      )
        intent.absolute[lex.dim] = dir;
      else intent.delta[lex.dim] += dir * STEP[lex.dim] * word.scale;
    }

    if (lex.inst) {
      // when refining, "钢琴太响了" is about loudness, not a request to change the lead
      const volumeOnly = word.leveled && mode === "refine";
      if (negative) intent.excluded.add(lex.inst);
      else if (word.added && lex.inst === "strings") intent.padFromStrings = true;
      else if (!word.neg && !word.replaced && !volumeOnly) {
        if (word.changed) intent.leads.unshift(lex.inst);
        else {
          if (intent.leads.length && lex.inst === "strings" && !lex.cat)
            intent.padFromStrings = true;
          intent.leads.push(lex.inst);
        }
        if (word.solo) intent.soloLead = true;
      }
    }

    if (lex.w) {
      // an excluded instrument says nothing about the style
      const factor =
        (lex.inst && !lex.cat && word.neg) || word.replaced
          ? 0
          : negative
            ? -1.5
            : word.neg === "too" || word.too
              ? -0.5
              : 1;
      const sign = factor >= 1 ? 1 : factor <= -1 ? -1 : factor < 0 ? -0.5 : 0;
      for (const [id, weight] of Object.entries(lex.w) as [StyleId, number][]) {
        intent.lexical[id] += weight * factor;
        if (factor > 0) {
          const list = intent.evidence.get(id) ?? [];
          if (!list.includes(word.text)) list.push(word.text);
          intent.evidence.set(id, list);
          const partial = word.flavour || (word.compared && !word.changed);
          const genre = !!lex.cat && lex.cat !== "emotion";
          if (partial && genre && !lex.arr) intent.flavourStyle.add(id);
          else if (!partial && genre) intent.strong[id] += weight;
          if (lex.cat && (word.changed || word.suffixed) && !word.flavour)
            intent.explicitStyle.add(id);
        }
      }
      intent.valence += (lex.v ?? 0) * sign;
      intent.arousal += (lex.a ?? 0) * sign;
      if (lex.cat === "emotion" && !lex.dim)
        intent.feeling += (lex.a ?? 0) * sign;
      if (lex.pos !== undefined && !lex.dim && factor > 0)
        intent.scenePos = lex.pos;
    } else if (lex.a && !gated && !word.used) {
      intent.arousal += lex.a * (word.too || word.neg ? -1 : 1);
    }
  });

  if (intent.dnb) {
    intent.lexical.dance += 4;
    intent.strong.dance += 4;
    intent.lexical.battle += 1.5;
    intent.evidence.set("dance", ["鼓打贝斯 (Drum & Bass)"]);
    intent.arrangement.push((hints) => {
      hints.drums = "breakbeat";
    });
  }
  if (intent.soloLead && /piano/.test(intent.leads[0] ?? "")) {
    intent.lexical.focus += 1.9;
    intent.lexical.romantic += 1.3;
    intent.lexical.cinematic += 1.2;
  }
  // several words pulling the same way do not add up without limit
  for (const dim of ["energy", "complexity", "reverb"] as const)
    intent.delta[dim] = clamp(intent.delta[dim], -0.4, 0.4);
  intent.delta.tempo = clamp(intent.delta.tempo, -30, 30);
  intent.valence = clamp(intent.valence, -1, 1);
  intent.arousal = clamp(intent.arousal, -1, 1);
  intent.feeling = clamp(intent.feeling, -1, 1);
  return intent;
}

/* ---------- choosing the style ---------- */

interface Choice {
  /** best style with real evidence, if any */
  best?: StyleId;
  /** a second style that is practically as likely */
  tied?: StyleId;
  /** closest neutral style when only a mood could be read */
  neutral?: StyleId;
}

function chooseStyle(intent: Intent): Choice {
  const hasMood = Math.abs(intent.valence) + Math.abs(intent.arousal) >= 0.4;
  const affinity = (id: StyleId) =>
    hasMood
      ? 0.6 *
        (intent.valence * STYLE_COORDS[id][0] +
          intent.arousal * STYLE_COORDS[id][1])
      : 0;
  const total = (id: StyleId) => intent.lexical[id] + affinity(id);
  const rank = (ids: StyleId[], score: (id: StyleId) => number) =>
    [...ids].sort(
      (a, b) =>
        score(b) - score(a) ||
        intent.lexical[b] - intent.lexical[a] ||
        STYLE_IDS.indexOf(a) - STYLE_IDS.indexOf(b),
    );
  const candidates = rank(
    STYLE_IDS.filter((id) => intent.lexical[id] >= WEAK),
    total,
  );
  if (candidates.length) {
    const [best, second] = candidates;
    return {
      best,
      tied: second && total(best) - total(second) < 0.25 ? second : undefined,
    };
  }
  if (!hasMood) return {};
  const open = NEUTRAL.filter((id) => intent.lexical[id] > -0.5);
  return {
    neutral: rank(open.length ? open : NEUTRAL, (id) =>
      affinity(id) + 0.3 * intent.lexical[id],
    )[0],
  };
}

/* ---------- applying the request ---------- */

const LOW = { energy: 0.4, complexity: 0.3, reverb: 0.15 };
const HIGH = { energy: 0.72, complexity: 0.7, reverb: 0.6 };
const round3 = (value: number) => Math.round(value * 1000) / 1000;

function copyConfig(config: MusicConfig): MusicConfig {
  return {
    ...config,
    volumes: { ...config.volumes },
    ...(config.arrangement
      ? {
          arrangement: JSON.parse(
            JSON.stringify(config.arrangement),
          ) as ArrangementHints,
        }
      : {}),
  };
}

/**
 * Apply everything except the style itself. `fresh` is true when the style
 * was just (re)chosen, so scene hints may shape tempo, length and looping.
 */
function applyParameters(
  config: MusicConfig,
  intent: Intent,
  mode: "new" | "refine",
  fresh: boolean,
  notes: string[],
) {
  const { analysis } = intent;
  const [slow, fast] = styleInfo(config.mood).bpmRange;
  const at = (pos: number) => Math.round(slow + (fast - slow) * pos);

  if (analysis.bpm !== undefined) {
    config.bpm = clamp(analysis.bpm, ...LIMITS.bpm);
    if (config.bpm !== analysis.bpm)
      notes.push(
        `速度范围是 ${LIMITS.bpm[0]}–${LIMITS.bpm[1]} BPM，已取 ${config.bpm}`,
      );
  } else {
    if (intent.tempoPos !== undefined) config.bpm = at(intent.tempoPos);
    else if (fresh && intent.dnb) config.bpm = 170;
    else if (fresh && intent.scenePos !== undefined && config.bpm < 140)
      config.bpm = Math.min(
        config.bpm + 24,
        Math.max(config.bpm, at(intent.scenePos)),
      );
    config.bpm += Math.round(intent.delta.tempo);
  }

  if (analysis.duration !== undefined) {
    const wanted = Math.round(analysis.duration);
    config.duration = clamp(wanted, ...LIMITS.duration);
    if (config.duration !== wanted)
      notes.push(
        `时长范围是 ${LIMITS.duration[0]}–${LIMITS.duration[1]} 秒，已取 ${config.duration} 秒`,
      );
  } else if (intent.lengthStep) {
    const longer = intent.lengthStep > 0;
    const next = longer
      ? DURATION_STEPS.find((step) => step > config.duration)
      : [...DURATION_STEPS].reverse().find((step) => step < config.duration);
    if (next) config.duration = next;
    else notes.push(longer ? "已经是最长的 120 秒" : "已经是最短的 15 秒");
  } else if (fresh && mode === "new" && intent.short) config.duration = 15;

  if (analysis.key) config.key = analysis.key;
  else if (intent.modeExplicit)
    config.key = withMode(config.key, intent.modeExplicit);
  else if (intent.modeVotes.size === 1)
    config.key = withMode(config.key, [...intent.modeVotes][0]);

  for (const dim of ["energy", "complexity", "reverb"] as const) {
    let value = config[dim];
    const hint = intent.absolute[dim];
    if (hint === -1) value = Math.max(0.05, Math.min(value - 0.12, LOW[dim]));
    if (hint === 1) value = Math.max(value + 0.12, HIGH[dim]);
    value += intent.delta[dim];
    if (dim === "energy" && mode === "refine" && !fresh)
      value += 0.16 * intent.feeling;
    if (mode === "new" && dim !== "reverb")
      value = Math.max(value, Math.min(config[dim], 0.12));
    config[dim] = round3(clamp(value, 0, 1));
  }
  if (intent.reverbSet !== undefined) config.reverb = intent.reverbSet;

  if (intent.leads.length) config.instrument = intent.leads[0];
  if (intent.excluded.has(config.instrument)) {
    const replacement = STYLE_LEADS[config.mood].find(
      (id) => !intent.excluded.has(id),
    );
    if (replacement) config.instrument = replacement;
  } else if (mode === "refine" && intent.excluded.size && !intent.leads.length)
    notes.push(
      `当前主奏是${instrumentLabel(config.instrument)}，本来就没有用${[...intent.excluded].map(instrumentLabel).join("、")}`,
    );

  for (const op of intent.trackOps) op(config.volumes);
  if (!intent.touchedDrums && (intent.soloLead || (fresh && intent.noDrums)))
    config.volumes.drums = 0;

  if (intent.loop !== undefined) config.loop = intent.loop;
  else if (fresh && intent.impliedLoop !== undefined)
    config.loop = intent.impliedLoop;
  else if (fresh && mode === "new" && intent.short) config.loop = false;

  const hints: ArrangementHints = config.arrangement
    ? (JSON.parse(JSON.stringify(config.arrangement)) as ArrangementHints)
    : {};
  for (const edit of intent.arrangement) edit(hints);
  if (intent.padFromStrings) hints.layers = { ...hints.layers, pad: true };
  if (intent.touchedDrums && config.volumes.drums > 0 && hints.drums === "none")
    delete hints.drums;
  config.arrangement = hints;
}

/* ---------- words for the user ---------- */

const quote = (text: string) =>
  [...text].length > 18 ? `${[...text].slice(0, 18).join("")}…` : text;

/** Use the user's own words as the title when they are a short, clean phrase. */
function titleFromWords(prompt: string): string | undefined {
  const first = prompt.split(/[,，。.;；!！?？\n]/)[0].trim();
  const head = first
    .replace(
      /^(?:请)?(?:帮我|给我|我想要|我想|想要|需要)?(?:来|做|写|生成|创作|制作)?(?:一首|一段|一个|一曲|首|段)/,
      "",
    )
    .replace(/^(?:适合|用于|关于)/, "")
    .trim();
  const phrase = head
    .replace(/的?(?:背景音乐|配乐|纯音乐|音乐|曲子|歌曲|bgm)$/i, "")
    .trim();
  if (!phrase || /\d/.test(phrase)) return undefined;
  const cjk = /[一-鿿]/.test(phrase);
  const length = [...phrase].length;
  if (cjk ? length < 4 || length > 10 : length < 4 || length > 24)
    return undefined;
  if (!cjk && phrase.split(/\s+/).length > 3) return undefined;
  const read = analyse(phrase);
  if (read.bpm !== undefined || read.duration !== undefined || read.key)
    return undefined;
  const instruction = read.tokens.some(
    ({ lex }) =>
      lex.neg ||
      lex.op ||
      lex.target ||
      lex.change ||
      lex.seed ||
      (lex.loop !== undefined && !lex.w) ||
      lex.mod === "too" ||
      lex.mod === "more" ||
      lex.mod === "slight" ||
      lex.mod === "lot",
  );
  if (instruction || !read.tokens.some(({ lex }) => lex.w || lex.inst))
    return undefined;
  // "做饭视频的轻松(音乐)": an adjective left dangling is not a title
  const lastWord = read.tokens[read.tokens.length - 1]?.lex;
  if (phrase !== head && (lastWord?.cat === "emotion" || lastWord?.dim))
    return undefined;
  return cjk
    ? phrase
    : phrase.replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

function pickTitle(prompt: string, style: StyleId, seed: number): string {
  const titles = styleInfo(style).titles;
  return titleFromWords(prompt) ?? titles[(seed >>> 0) % titles.length];
}

const PRAISE =
  /好听|不错|很棒|真棒|喜欢|完美|可以了|就这样|挺好|很好|谢谢|感谢|thanks|thank you|great|perfect|nice|love it|awesome/i;
const EXAMPLES = "“鼓轻一点”“换成古筝”“慢一点”“改成爵士风格”“换个旋律”";

/**
 * Plan one request without any network access. "new" starts from the best
 * matching style; "refine" changes only what the message asks for.
 */
export function planWithRules(request: AgentRequest): AgentPlan {
  const text = (typeof request.text === "string" ? request.text : "")
    .trim()
    .slice(0, LIMITS.promptChars);
  const mode = request.mode === "refine" ? "refine" : "new";
  const current = clampConfig(request.current ?? {});
  const intent = interpret(text, mode);
  const choice = chooseStyle(intent);
  const notes: string[] = [];
  const styleNotes: string[] = [];
  const because = (id: StyleId) => {
    const words = (intent.evidence.get(id) ?? []).slice(0, 3);
    return words.length ? `（听到：${words.join("、")}）` : "";
  };

  let config = copyConfig(current);
  let fresh = false;
  let guessed = false;

  if (mode === "new") {
    const adopt = (id: StyleId) => {
      config = {
        ...config,
        ...stylePreset(id),
        duration: current.duration,
        loop: current.loop,
        volumes: { ...current.volumes },
      };
      delete config.arrangement;
      fresh = true;
    };
    if (!text) styleNotes.push("没有收到描述，按当前参数制作");
    else if (choice.best) {
      adopt(choice.best);
      styleNotes.push(
        `风格定为「${styleLabel(choice.best)}」${because(choice.best)}`,
      );
      if (choice.tied)
        styleNotes.push(
          `「${styleLabel(choice.tied)}」也很接近，想换可以直接告诉我`,
        );
    } else if (choice.neutral) {
      adopt(choice.neutral);
      guessed = true;
      styleNotes.push(
        `没有听出明确的风格词，按情绪选了最接近的「${styleLabel(choice.neutral)}」`,
      );
    } else {
      guessed = true;
      styleNotes.push(
        `没有从“${quote(text)}”里听出风格，沿用当前的「${styleLabel(current.mood)}」`,
      );
    }
  } else if (choice.best) {
    const best = choice.best;
    const wanted =
      intent.explicitStyle.has(best) ||
      intent.strong[best] >= 3 ||
      intent.restyle;
    if (wanted && best === current.mood)
      styleNotes.push(`已经是「${styleLabel(best)}」风格`);
    else if (wanted && choice.tied && choice.tied !== current.mood)
      styleNotes.push(
        `「${styleLabel(best)}」和「${styleLabel(choice.tied)}」都沾边，先保持当前的「${styleLabel(current.mood)}」，请再说明确一点`,
      );
    else if (wanted) {
      config = { ...config, ...stylePreset(best) };
      delete config.arrangement;
      fresh = true;
    } else if (intent.flavourStyle.has(best) && best !== current.mood) {
      // "加点爵士味": borrow the style's colour without replacing the piece
      config.instrument = stylePreset(best).instrument;
      if (best === "jazz")
        intent.arrangement.unshift((hints) => {
          hints.swing = hints.swing ?? 0.5;
        });
      if (best === "dance")
        intent.arrangement.unshift((hints) => {
          hints.drums = hints.drums ?? "fourfloor";
        });
      styleNotes.push(
        `保持「${styleLabel(current.mood)}」的底子，借用「${styleLabel(best)}」的主奏音色`,
      );
    }
  }

  if (mode === "refine" && intent.restyle && !fresh && !styleNotes.length)
    styleNotes.push("想换成什么风格？可以说“改成爵士风格”或“换成国风”");
  const baseline = copyConfig(config);
  if (fresh && !intent.leads.length)
    for (const [id, lead] of SIGNATURE_LEADS)
      if (id !== config.mood && intent.lexical[id] >= 3) {
        config.instrument = lead;
        styleNotes.push(
          `保留「${styleLabel(id)}」的色彩：主奏用${instrumentLabel(lead)}`,
        );
        break;
      }
  applyParameters(config, intent, mode, fresh, notes);
  if (mode === "refine" && !fresh) {
    const { bpm, duration, key } = intent.analysis;
    if (bpm !== undefined && config.bpm === current.bpm)
      notes.push(`速度已经是 ${current.bpm} BPM`);
    if (duration !== undefined && config.duration === current.duration)
      notes.push(`时长已经是 ${current.duration} 秒`);
    if (key && key === current.key) notes.push(`调性已经是 ${keyLabel(key)}`);
    if (!key && intent.modeExplicit && config.key === current.key)
      notes.push(`调性已经是 ${keyLabel(current.key)}`);
    if (intent.loop !== undefined && config.loop === current.loop)
      notes.push(current.loop ? "已经是无缝循环的版本" : "已经是带结尾的完整版本");
  }
  config.seed =
    mode === "new" || intent.newSeed ? request.nextSeed : current.seed;
  config.prompt = mode === "new" && text ? text : current.prompt;
  config = clampConfig(config, current);
  notes.push(...intent.notes);

  const changes = describeChanges(
    mode === "new" ? { ...clampConfig(baseline, current), seed: config.seed } : current,
    config,
  );
  const unchanged = mode === "refine" && changes.length === 0;

  const titleOverride = (request as { title?: unknown }).title;
  const title =
    mode === "new"
      ? pickTitle(text, config.mood, config.seed)
      : typeof titleOverride === "string" && titleOverride.trim()
        ? titleOverride.trim().slice(0, 60)
        : config.mood === current.mood
          ? pickTitle(current.prompt, current.mood, current.seed)
          : pickTitle("", config.mood, current.seed);

  const label = styleLabel(config.mood);
  const summary = `${config.bpm} BPM、${keyLabel(config.key)}、${instrumentLabel(config.instrument)}主奏`;
  let reply: string;
  if (mode === "new")
    reply =
      `好的，做一段「${label}」风格的音乐：${summary}，${config.duration} 秒，${config.loop ? "可无缝循环" : "带完整结尾"}。` +
      (guessed && text
        ? "这次没听出明确的风格，可以再告诉我场景、情绪或想要的乐器。"
        : notes.length
          ? `${notes[0]}。`
          : "");
  else if (unchanged)
    reply =
      (styleNotes[0] ?? notes[0]
        ? `${styleNotes[0] ?? notes[0]}。`
        : PRAISE.test(text)
          ? "很高兴你喜欢，"
          : "这句话里我没有听出要调整什么，") +
      `作品保持不变。${PRAISE.test(text) ? "想再调整" : ""}可以试试：${EXAMPLES}。`;
  else
    reply =
      `好的：${changes.slice(0, 3).join("，")}${changes.length > 3 ? " 等" : ""}。` +
      (config.seed === current.seed ? "旋律素材保持不变。" : "") +
      (notes.length ? `${notes[0]}。` : "");

  const reasoning = [
    ...styleNotes,
    ...changes.slice(0, 8),
    ...notes,
    ...(unchanged && !styleNotes.length && !notes.length
      ? [`没有从“${quote(text)}”里识别到可执行的调整`]
      : []),
  ];
  const tags = [
    label,
    `${config.bpm} BPM`,
    instrumentLabel(config.instrument),
    ...intent.tags,
    ...(config.volumes.drums === 0 ? ["无鼓"] : []),
    ...(TRACKS.every((track) => track === "melody" || config.volumes[track] === 0)
      ? [`只有${TRACK_LABELS.melody}`]
      : []),
  ].slice(0, 6);

  return {
    config,
    title,
    reply,
    reasoning,
    tags: [...new Set(tags)],
    unchanged,
    brain: "rules",
    ...(request.provider !== "local"
      ? { cloudPrompt: buildCloudPrompt(config, mode === "refine" ? text : undefined) }
      : {}),
  };
}
