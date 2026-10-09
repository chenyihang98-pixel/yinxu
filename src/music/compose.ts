/**
 * compose(config) → Score: the symbolic composer.
 *
 *   config → style + key/mode → tempo & length → form → harmony
 *          → lead / counter / arp / comp / pad / bass / drums on the beat grid
 *          → one swing + humanisation pass into seconds → validated Score
 *
 * Pure and deterministic: the same config always yields the same Score.
 * config.volumes never influences the result.
 */
import type { ArrangementHints, MusicConfig } from "../types";
import { instrumentLabel, parseKey, styleInfo, styleLabel } from "./catalog";
import { clampConfig } from "./defaults";
import {
  describeForm,
  planFormWithNote,
  planTiming,
  type SectionPlan,
  type Timing,
} from "./form";
import {
  chordSpans,
  composeComp,
  composePad,
  planHarmony,
  type Ctx,
  type HarmonyPlan,
} from "./harmony";
import {
  composeArp,
  composeCounter,
  composeLead,
  type TuneNote,
} from "./melody";
import { seededRandom, type Rng } from "./random";
import {
  SWUNG_FEELS,
  composeBass,
  composeDrums,
  composePerc,
  makeTimeMap,
  resolveDrums,
  type BeatHit,
  type TimeMap,
} from "./rhythm";
import {
  DEFAULT_PART_MIX,
  SAMPLE_RATE,
  type ArrangementSummary,
  type DrumEvent,
  type DrumKitId,
  type NoteEvent,
  type Part,
  type PartMix,
  type PartRole,
  type Score,
  type Section,
  type SpaceSettings,
  type TrackName,
  type VoiceId,
} from "./score";
import { getStyle } from "./styles";
import type {
  ArpDef,
  CounterDef,
  ModeDef,
  PadDef,
  PercDef,
  StyleDef,
} from "./styles/types";
import {
  SCALE_LABELS,
  VOICE_LABELS,
  VOICE_RANGES,
  clamp,
  foldIntoRange,
  lowIntervalClash,
  makeKey,
  type BeatNote,
  type KeyContext,
} from "./theory";

/**
 * The mixer group of each role. An arpeggio decorates the tune and normally
 * shares its fader; in a style whose arpeggio IS the harmony (no comp and no
 * pad, e.g. chiptune) it moves to the chords group, so that fader is not dead.
 */
const ROLE_TRACK: Record<PartRole, TrackName> = {
  lead: "melody",
  counter: "melody",
  arp: "melody",
  comp: "chords",
  pad: "chords",
  bass: "bass",
  kit: "drums",
  perc: "drums",
};

const ROLE_MIX: Record<PartRole, Partial<PartMix>> = {
  lead: { gain: 0.8, width: 0.9, reverb: 0.28, delay: 0.1 },
  counter: { gain: 0.42, pan: 0.28, reverb: 0.35 },
  arp: { gain: 0.38, pan: -0.3, width: 1.1, reverb: 0.3, delay: 0.18 },
  comp: { gain: 0.55, pan: -0.1, reverb: 0.22 },
  pad: { gain: 0.4, width: 1.3, reverb: 0.4, chorus: 0.3, lowCut: 150 },
  bass: { gain: 0.78, width: 0, reverb: 0.02 },
  kit: { gain: 0.8, reverb: 0.12 },
  // small percussion peaks 10 dB under a kick at the same velocity (see
  // DRUM_PEAKS): at unity it is a layer about 20 LU under the mix
  perc: { gain: 1, pan: 0.22, width: 1.2, reverb: 0.2 },
};

/** Largest PartMix.gain a style may ask for (validate.ts allows the same). */
export const MAX_PART_GAIN = 3;

/** Used when a hint switches on a layer the style does not define itself. */
const FALLBACK_PAD: PadDef = { voice: ["pad", "airpad"], from: 2 };
const FALLBACK_ARP: ArpDef = {
  voice: ["pluck", "bell"],
  from: 2,
  pattern: ["updown"],
  rate: { low: 4, mid: 2, high: 2 },
};
const FALLBACK_COUNTER: CounterDef = {
  voice: ["strings", "flute"],
  from: 2,
  mode: "guide",
};
const FALLBACK_PERC: PercDef = {
  from: 2,
  grooves: [{ shaker: "x.o.X.o.x.o.X.o." }],
};

const KIT_LABELS: Record<DrumKitId, string> = {
  pop: "流行鼓组",
  lofi: "Lo-fi 鼓组",
  electro: "电子鼓机",
  acoustic: "原声鼓组",
  brush: "爵士刷鼓",
  cinematic: "电影打击乐",
  chip: "噪声鼓",
  soft: "轻打击乐",
};

const round = (value: number, digits: number) => {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
};

function partMix(
  style: StyleDef,
  role: PartRole,
  extra?: Partial<PartMix>,
): PartMix {
  const mix = {
    ...DEFAULT_PART_MIX,
    ...ROLE_MIX[role],
    ...style.mix[role],
    ...extra,
  };
  return {
    gain: clamp(mix.gain, 0, MAX_PART_GAIN),
    pan: clamp(mix.pan, -1, 1),
    width: clamp(mix.width, 0, 1.5),
    reverb: clamp(mix.reverb, 0, 1),
    delay: clamp(mix.delay, 0, 1),
    chorus: clamp(mix.chorus, 0, 1),
    lowCut: Math.max(0, mix.lowCut),
    highCut: Math.max(0, mix.highCut),
    drive: clamp(mix.drive, 0, 1),
    duck: clamp(mix.duck, 0, 1),
  };
}

const firstVoice = (voice: VoiceId | VoiceId[], lead: VoiceId): VoiceId => {
  const list = Array.isArray(voice) ? voice : [voice];
  return list.find((item) => item !== lead) ?? list[0];
};

/**
 * Low-interval limit across the bass and the chordal layers: where two notes
 * sound a muddy interval low down (see lowIntervalClash), the note of the
 * more movable layer goes up an octave, or is dropped when that octave is
 * already sounding there or out of range. `layers` are in order of
 * precedence: the first one keeps its notes, and a `fixed` layer (the bass)
 * is never touched.
 */
function clearLowIntervals(
  layers: { notes: BeatNote[]; high: number; fixed?: boolean }[],
): void {
  interface Low {
    note: BeatNote;
    layer: number;
    gone?: boolean;
  }
  const low: Low[] = [];
  layers.forEach((layer, index) => {
    for (const note of layer.notes)
      if (note.midi < 56) low.push({ note, layer: index });
  });
  if (low.length < 2) return;
  low.sort((a, b) => a.note.beat - b.note.beat);
  const lift = (item: Low) => {
    const layer = layers[item.layer];
    const raised = item.note.midi + 12;
    const doubled = layer.notes.some(
      (other) =>
        other !== item.note &&
        other.midi === raised &&
        other.beat < item.note.beat + item.note.len &&
        other.beat + other.len > item.note.beat,
    );
    if (raised > layer.high || doubled) item.gone = true;
    else item.note.midi = raised;
  };
  for (let i = 0; i < low.length; i++) {
    const a = low[i];
    for (let j = i + 1; j < low.length; j++) {
      const b = low[j];
      if (b.note.beat >= a.note.beat + a.note.len - 0.05) break;
      if (a.gone || b.gone) continue;
      if (a.layer === b.layer && layers[a.layer].fixed) continue;
      const [under, over] = a.note.midi <= b.note.midi ? [a, b] : [b, a];
      if (!lowIntervalClash(under.note.midi, over.note.midi)) continue;
      // the later layer gives way; inside one layer the upper note does
      lift(under.layer > over.layer ? under : over);
    }
  }
  const gone = new Set(
    low.filter((item) => item.gone).map((item) => item.note),
  );
  if (gone.size)
    for (const layer of layers) {
      const kept = layer.notes.filter((note) => !gone.has(note));
      layer.notes.length = 0;
      layer.notes.push(...kept);
    }
}

interface Humanize {
  /** seconds */
  timing: number;
  velocity: number;
}

/**
 * Beat-grid notes → seconds, humanised, clipped to the piece and free of
 * same-pitch overlaps. `mono` (the bass) lets no two notes sound together at
 * all: whatever the humanisation did, a note ends before the next one starts.
 */
function finishNotes(
  source: BeatNote[],
  voice: VoiceId,
  time: TimeMap,
  timing: Timing,
  human: Humanize,
  rng: Rng,
  mono = false,
): NoteEvent[] {
  const [low, high] = VOICE_RANGES[voice];
  const limit = timing.loop ? timing.duration : timing.endTime;
  const ordered = source
    .slice()
    .sort((a, b) => a.beat - b.beat || a.midi - b.midi);
  const jitterAt = new Map<number, number>();
  const events: NoteEvent[] = [];
  for (const note of ordered) {
    // notes struck together share one timing offset so chords stay tight
    const slot = Math.round(note.beat * 96);
    let jitter = jitterAt.get(slot);
    if (jitter === undefined) {
      jitter = (rng.next() * 2 - 1) * human.timing;
      jitterAt.set(slot, jitter);
    }
    const start = time.seconds(note.beat);
    let t = Math.max(0, start + jitter + (note.late ?? 0));
    let d = time.seconds(note.beat + note.len) - start;
    if (t >= limit - 0.02) continue;
    if (t + d > limit) d = limit - t;
    if (!(d >= 0.03)) continue;
    const vel = clamp(
      note.vel * (1 + (rng.next() * 2 - 1) * human.velocity),
      0.05,
      1,
    );
    t = round(t, 5);
    const event: NoteEvent = {
      t,
      // rounded down so the note can never poke past the end
      d: Math.floor(Math.min(d, limit - t) * 1e5) / 1e5,
      midi: foldIntoRange(note.midi, low, high),
      vel: round(vel, 3),
    };
    if (note.bend) event.bend = clamp(note.bend, -12, 12);
    events.push(event);
  }
  events.sort((a, b) => a.t - b.t || a.midi - b.midi);
  // a pitch never sounds twice at once inside one part
  const sounding = new Map<number, NoteEvent>();
  const dropped = new Set<NoteEvent>();
  for (const event of events) {
    const earlier = sounding.get(event.midi);
    if (earlier && earlier.t + earlier.d > event.t - 0.004) {
      const shortened = round(event.t - earlier.t - 0.004, 5);
      if (shortened >= 0.03) earlier.d = shortened;
      else if (event.t - earlier.t < 0.03) {
        // struck (almost) together: keep the longer one
        if (event.d > earlier.d) dropped.add(earlier);
        else {
          dropped.add(event);
          continue;
        }
      } else dropped.add(earlier);
    }
    sounding.set(event.midi, event);
  }
  const kept = events.filter((event) => !dropped.has(event) && event.d > 0);
  if (!mono) return kept;
  const single: NoteEvent[] = [];
  for (const event of kept) {
    const earlier = single[single.length - 1];
    if (earlier && earlier.t + earlier.d > event.t - 0.004) {
      const shortened = round(event.t - earlier.t - 0.004, 5);
      if (shortened >= 0.03) earlier.d = shortened;
      else single.pop();
    }
    single.push(event);
  }
  return single;
}

/** Plain code-unit order: the same on every machine, whatever its locale (localeCompare is not). */
const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function finishHits(
  source: BeatHit[],
  time: TimeMap,
  timing: Timing,
  human: Humanize,
  rng: Rng,
): DrumEvent[] {
  const limit = timing.loop
    ? timing.duration
    : timing.finalBar * timing.barSeconds + 0.05;
  const ordered = source
    .slice()
    .sort((a, b) => a.beat - b.beat || byName(a.kind, b.kind));
  const loudest = new Map<string, DrumEvent>();
  for (const hit of ordered) {
    const jitter =
      hit.kind === "cymbalSwell" ? 0 : (rng.next() * 2 - 1) * human.timing;
    const t = round(
      Math.max(0, time.seconds(hit.beat) + (hit.late ?? 0) + jitter),
      5,
    );
    const vel = round(
      clamp(hit.vel * (1 + (rng.next() * 2 - 1) * human.velocity), 0.04, 1),
      3,
    );
    if (t >= limit - 0.001) continue;
    const key = `${hit.kind}:${Math.round(t * 250)}`;
    const existing = loudest.get(key);
    if (!existing || vel > existing.vel)
      loudest.set(key, { t, kind: hit.kind, vel });
  }
  return [...loudest.values()].sort(
    (a, b) => a.t - b.t || byName(a.kind, b.kind),
  );
}

function spaceFor(
  style: StyleDef,
  config: MusicConfig,
  timing: Timing,
): SpaceSettings {
  const reference = Math.max(0.05, styleInfo(config.mood).reverb);
  const ratio = config.reverb / reference;
  const spread = Math.min(ratio, 2.5);
  return {
    size: round(clamp(style.space.size * (0.75 + 0.25 * spread), 0, 1), 3),
    decay: round(clamp(style.space.decay * (0.8 + 0.2 * spread), 0.2, 10), 3),
    damping: clamp(style.space.damping, 0, 1),
    preDelay: clamp(style.space.preDelay, 0, 0.2),
    level: round(clamp(style.space.level * ratio, 0, 1), 3),
    delayTime: round(
      clamp(style.space.delayBeats * timing.beatSeconds, 0.03, 1.5),
      5,
    ),
    delayFeedback: clamp(style.space.delayFeedback, 0, 0.8),
  };
}

/** How many chords of a hinted progression clampConfig did not keep (malformed, or beyond the limit). */
function unusedChords(
  raw: unknown,
  kept: readonly string[] | undefined,
): number {
  const arrangement = (raw as { arrangement?: unknown } | null | undefined)
    ?.arrangement;
  const list = (arrangement as { progression?: unknown } | null | undefined)
    ?.progression;
  if (!Array.isArray(list)) return 0;
  return Math.max(0, list.length - (kept?.length ?? 0));
}

/** The mode a piece is in: one of the style's scales for the key's tonality. */
function pickMode(cfg: MusicConfig, style: StyleDef, rng: Rng): ModeDef {
  const modes =
    style.harmony.modes[parseKey(cfg.key).minor ? "minor" : "major"];
  return rng.fork("mode").weighted(
    modes,
    // a mode may be reserved for, or kept away from, certain lead instruments
    modes.map((item) => item.leads?.[cfg.instrument] ?? item.weight ?? 1),
  );
}

/**
 * Whether the tune has no harmony layer under it in a section: it is then
 * the stand-in itself and carries the music alone (see composeLead).
 */
const leadAlone = (plays: Record<PartRole, boolean[]>, index: number) =>
  plays.lead[index] &&
  !plays.comp[index] &&
  !plays.pad[index] &&
  !plays.arp[index];

interface LayerPlan {
  /** which sections each layer plays in (indexed by section) */
  plays: Record<PartRole, boolean[]>;
  drumSetup: ReturnType<typeof resolveDrums>;
  bassFeel: Exclude<NonNullable<ArrangementHints["bass"]>, "auto"> | undefined;
  padDef: PadDef | undefined;
  arpDef: ArpDef | undefined;
  counterDef: CounterDef | undefined;
  percDef: PercDef | undefined;
}

/**
 * Which layers play where. Every layer enters at its own energy, and hints
 * switch layers on and off — but no section is ever left empty or to a part
 * that cannot fill it: see the stand-in rule at the end.
 */
function planLayers(
  cfg: MusicConfig,
  style: StyleDef,
  sections: readonly SectionPlan[],
): LayerPlan {
  const hints: ArrangementHints = cfg.arrangement ?? {};
  const layerHints = hints.layers ?? {};
  const drumSetup = resolveDrums(style.drums, hints.drums);
  const bassFeel = hints.bass && hints.bass !== "auto" ? hints.bass : undefined;
  const padDef = style.pad ?? (layerHints.pad ? FALLBACK_PAD : undefined);
  const arpDef = style.arp ?? (layerHints.arp ? FALLBACK_ARP : undefined);
  const counterDef =
    style.counter ?? (layerHints.counter ? FALLBACK_COUNTER : undefined);
  const percDef = style.perc ?? (layerHints.perc ? FALLBACK_PERC : undefined);
  const hasBody = sections.some((section) => section.type !== "intro");
  const enters = (
    section: Section,
    def: { from: number; mute?: string[] } | undefined,
    forced?: boolean,
    shift = 0,
  ) => {
    if (!def || forced === false) return false;
    if (forced) return true;
    return (
      section.energy >= def.from - shift && !def.mute?.includes(section.type)
    );
  };
  const plays: Record<PartRole, boolean[]> = {
    lead: sections.map(
      (section) =>
        section.type !== "intro" || !!style.melody.introLead || !hasBody,
    ),
    comp: sections.map((section) => enters(section, style.comp)),
    pad: sections.map((section) => enters(section, padDef, layerHints.pad)),
    arp: sections.map((section) => enters(section, arpDef, layerHints.arp)),
    // counter-lines arrive earlier as complexity rises
    counter: sections.map((section) =>
      enters(
        section,
        counterDef,
        layerHints.counter,
        (cfg.complexity - 0.5) * 0.3,
      ),
    ),
    bass: sections.map(
      (section) => bassFeel !== "none" && enters(section, style.bass),
    ),
    kit: sections.map((section) => !!drumSetup && enters(section, drumSetup)),
    perc: sections.map((section) =>
      hints.drums === "none" && !layerHints.perc
        ? false
        : enters(section, percDef, layerHints.perc),
    ),
  };

  // A section needs something that holds the harmony. Silence, a drum or a
  // bass line on its own, or a tune with nothing under it (its rests would
  // be holes in the music) is not a section. Where the energy and the hints
  // leave none of the harmony layers, the one the style brings in earliest
  // steps in — never one a hint has switched off — and where a style has no
  // such layer left at all, the tune at least plays — and then holds the
  // piece together by itself: composeLead gives it a note in every bar and
  // no long rests there, whatever density a hint asks for.
  const standIns = (
    [
      ["comp", style.comp],
      ["pad", layerHints.pad === false ? undefined : style.pad],
      ["arp", layerHints.arp === false ? undefined : style.arp],
    ] as [PartRole, { from: number } | undefined][]
  )
    .filter((entry): entry is [PartRole, { from: number }] => !!entry[1])
    .sort((a, b) => a[1].from - b[1].from);
  sections.forEach((_, index) => {
    if (plays.comp[index] || plays.pad[index] || plays.arp[index]) return;
    plays[standIns.length ? standIns[0][0] : "lead"][index] = true;
  });
  return { plays, drumSetup, bassFeel, padDef, arpDef, counterDef, percDef };
}

/** Everything that is settled before a note is written: key, time, form, harmony, layers. */
interface Draft {
  cfg: MusicConfig;
  style: StyleDef;
  hints: ArrangementHints;
  rng: Rng;
  key: KeyContext;
  timing: Timing;
  sections: SectionPlan[];
  formNote: string | undefined;
  harmony: HarmonyPlan;
  layers: LayerPlan;
  swing: number;
  swingGrid: 8 | 16;
  ctx: Ctx;
}

function draft(config: MusicConfig): Draft {
  const cfg = clampConfig((config ?? {}) as Partial<MusicConfig>);
  const style = getStyle(cfg.mood);
  const hints: ArrangementHints = cfg.arrangement ?? {};
  const rng = seededRandom(cfg.seed);

  const mode = pickMode(cfg, style, rng);
  const key = makeKey(cfg.key, mode.scale);
  const timing = planTiming(cfg, style);
  const { sections, note: formNote } = planFormWithNote(cfg, style, timing);
  const harmony = planHarmony({
    config: cfg,
    style,
    key,
    mode,
    timing,
    sections,
    rng,
  });

  /* ---- which layers play where ---- */
  const layers = planLayers(cfg, style, sections);

  /* ---- time feel: one swing value for everything ---- */
  const feelSwing = hints.drums ? SWUNG_FEELS[hints.drums] : undefined;
  const swing = clamp(
    hints.swing ??
      (feelSwing !== undefined && style.swing < 0.3 ? feelSwing : style.swing),
    0,
    0.66,
  );
  const swingGrid = feelSwing !== undefined ? 8 : (style.swingGrid ?? 8);
  const ctx: Ctx = {
    config: cfg,
    style,
    key,
    timing,
    sections,
    harmony,
    rng,
    plays: layers.plays,
    feel: { swing, grid: swingGrid },
  };
  return {
    cfg,
    style,
    hints,
    rng,
    key,
    timing,
    sections,
    formNote,
    harmony,
    layers,
    swing,
    swingGrid,
    ctx,
  };
}

export function compose(config: MusicConfig): Score {
  const {
    cfg,
    style,
    rng,
    key,
    timing,
    sections,
    formNote,
    harmony,
    layers,
    swing,
    swingGrid,
    ctx,
  } = draft(config);
  const lead: VoiceId = cfg.instrument;
  const { plays, drumSetup, bassFeel, padDef, arpDef, counterDef, percDef } =
    layers;
  const time = makeTimeMap(
    timing,
    swing,
    swingGrid,
    style.rubato ?? 0,
    // the tune's phrases: four bars from the start of each section
    sections.map((section) => ({
      startBar: section.startBar,
      bars: section.playBars,
    })),
  );
  const human: Humanize = {
    timing: clamp(style.humanize.timing, 0, 30) / 1000,
    velocity: clamp(style.humanize.velocity, 0, 0.3),
  };

  /* ---- parts ---- */
  const parts: Part[] = [];
  const addNotes = (
    id: string,
    role: Exclude<PartRole, "kit" | "perc">,
    voice: VoiceId,
    source: BeatNote[],
    extraMix?: Partial<PartMix>,
    tight = 1,
    track: TrackName = ROLE_TRACK[role],
  ) => {
    const notes = finishNotes(
      source,
      voice,
      time,
      timing,
      { timing: human.timing * tight, velocity: human.velocity },
      rng.fork(`human:${id}`),
      role === "bass",
    );
    if (!notes.length) return;
    parts.push({
      kind: "notes",
      id,
      track,
      role,
      voice,
      mix: partMix(style, role, extraMix),
      notes,
    });
  };

  const leadNotes = composeLead(ctx);
  addNotes("lead", "lead", lead, leadNotes, style.lead?.[cfg.instrument]);
  const layerVoice = (
    def: { voice: VoiceId | VoiceId[] } | undefined,
    role: PartRole,
  ) =>
    def && plays[role].some(Boolean) ? firstVoice(def.voice, lead) : undefined;
  const counterVoice = layerVoice(counterDef, "counter");
  const arpVoice = layerVoice(arpDef, "arp");
  const compVoice = layerVoice(style.comp, "comp");
  const padVoice = layerVoice(padDef, "pad");
  const counterNotes = counterVoice
    ? composeCounter(ctx, counterDef!, counterVoice, leadNotes)
    : [];
  const arpNotes = arpVoice ? composeArp(ctx, arpDef!, arpVoice) : [];
  const compNotes = compVoice ? composeComp(ctx, style.comp!, compVoice) : [];
  const padNotes = padVoice ? composePad(ctx, padDef!, padVoice) : [];
  let kickSteps = new Map<number, number[]>();
  let kitHits: BeatHit[] = [];
  let loopFill = false;
  if (drumSetup && plays.kit.some(Boolean)) {
    const drums = composeDrums(ctx, drumSetup);
    kickSteps = drums.kickSteps;
    kitHits = drums.hits;
    loopFill = drums.loopFill;
  }
  const bassNotes =
    style.bass && plays.bass.some(Boolean)
      ? composeBass(ctx, style.bass, bassFeel, kickSteps)
      : [];
  clearLowIntervals([
    { notes: bassNotes, high: 127, fixed: true },
    ...(
      [
        [compNotes, compVoice],
        [arpNotes, arpVoice],
        [counterNotes, counterVoice],
        [padNotes, padVoice],
      ] as [BeatNote[], VoiceId | undefined][]
    )
      .filter(([, voice]) => voice !== undefined)
      .map(([notes, voice]) => ({ notes, high: VOICE_RANGES[voice!][1] })),
  ]);
  if (counterVoice) addNotes("counter", "counter", counterVoice, counterNotes);
  // nothing else on the chords fader: the arpeggio is the harmony and takes it
  const chordal =
    (compVoice && compNotes.length > 0) || (padVoice && padNotes.length > 0);
  if (arpVoice)
    addNotes(
      "arp",
      "arp",
      arpVoice,
      arpNotes,
      undefined,
      0.5,
      chordal ? "melody" : "chords",
    );
  if (compVoice) addNotes("comp", "comp", compVoice, compNotes);
  if (padVoice) addNotes("pad", "pad", padVoice, padNotes, undefined, 0);
  if (style.bass && bassNotes.length)
    addNotes("bass", "bass", style.bass.voice, bassNotes, undefined, 0.6);
  const drumHuman = { timing: human.timing * 0.6, velocity: human.velocity };
  const kit = finishHits(
    kitHits,
    time,
    timing,
    drumHuman,
    rng.fork("human:kit"),
  );
  if (drumSetup && kit.length)
    parts.push({
      kind: "drums",
      id: "kit",
      track: "drums",
      role: "kit",
      kit: drumSetup.kit,
      mix: partMix(style, "kit"),
      hits: kit,
    });
  if (percDef && plays.perc.some(Boolean)) {
    const hits = finishHits(
      composePerc(ctx, percDef, style.drums?.remap),
      time,
      timing,
      drumHuman,
      rng.fork("human:perc"),
    );
    if (hits.length)
      parts.push({
        kind: "drums",
        id: "perc",
        track: "drums",
        role: "perc",
        kit: percDef.kit ?? drumSetup?.kit ?? "soft",
        mix: partMix(style, "perc"),
        hits,
      });
  }

  /* ---- arrangement notes ---- */
  const publicSections: Section[] = sections.map((section) => ({
    type: section.type,
    label: section.label,
    startBar: section.startBar,
    bars: section.bars,
    start: round(section.start, 6),
    end: round(section.end, 6),
    energy: round(section.energy, 3),
  }));
  publicSections[publicSections.length - 1].end = timing.duration;
  // the tempo as it is played: a fitted loop may sit a fraction off a whole number
  const bpmText =
    Math.abs(timing.bpm - Math.round(timing.bpm)) < 0.05
      ? String(Math.round(timing.bpm))
      : timing.bpm.toFixed(1);
  const notes: string[] = [
    `${styleLabel(cfg.mood)}：${style.summary}。${key.label}（${SCALE_LABELS[key.scaleName]}），${bpmText} BPM，4/4 拍。`,
    // a hinted form that had to change says so on the same line (never cut by the six-line limit)
    `${timing.loop ? "循环曲式" : "曲式"}：${describeForm(publicSections)}。${
      formNote ? `${formNote}。` : ""
    }`,
    // a tune left on its own says so: it does not thin out or fall silent then
    `配器：${instrumentNames(parts, cfg).join("、")}。${
      sections.some((_, index) => leadAlone(plays, index))
        ? "和声声部都已关闭，主旋律独自演奏，会保持连贯、不留长空拍。"
        : ""
    }`,
  ];
  const outline = harmony.outline;
  const body = outline.verse ?? outline.chorus ?? outline.bridge;
  // hinted chords that did not survive validation are never dropped silently
  const unused = unusedChords(config, cfg.arrangement?.progression);
  const unusedNote = unused ? `提示的和声中有 ${unused} 个和弦未被采用。` : "";
  if (harmony.overridden && cfg.arrangement?.progression) {
    const chosen = cfg.arrangement.progression;
    let shown = chosen.length;
    while (shown > 4 && chosen.slice(0, shown).join(" – ").length > 120)
      shown--;
    notes.push(
      `和声按指定的进行：${chosen.slice(0, shown).join(" – ")}${
        shown < chosen.length ? ` …（共 ${chosen.length} 个和弦）` : ""
      }。${unusedNote}`,
    );
  } else if (body) {
    // each progression under the name of the section it really belongs to
    const labelOf = (type: Section["type"]) =>
      sections.find((section) => section.type === type && !section.ending)
        ?.label ??
      sections.find((section) => section.type === type)?.label ??
      "";
    const bodyType = outline.verse
      ? "verse"
      : outline.chorus
        ? "chorus"
        : "bridge";
    notes.push(
      `和声：${labelOf(bodyType)} ${body.join(" – ")}${
        outline.chorus && outline.verse
          ? `；${labelOf("chorus")} ${outline.chorus.join(" – ")}`
          : ""
      }。${unusedNote}`,
    );
  } else if (unusedNote) notes.push(unusedNote);
  // a loop is whole bars: the tempo gives way only by a hair (see planTiming),
  // otherwise it is kept and the length moves to the nearest bars
  if (timing.adjusted === "tempo")
    notes.push(
      `为了无缝循环，速度微调为 ${bpmText} BPM（设定 ${cfg.bpm}），${timing.bars} 小节正好 ${cfg.duration} 秒。`,
    );
  else if (timing.adjusted === "duration")
    notes.push(
      `为了无缝循环，速度保持 ${cfg.bpm} BPM，时长取整为 ${timing.bars} 小节，共 ${round(timing.duration, 1)} 秒（设定 ${cfg.duration} 秒）。`,
    );
  if (timing.loop) {
    // only what was really written: a turnaround chord, a drum fill, both or neither
    notes.push(
      harmony.turnaround
        ? loopFill
          ? "末小节用转回和弦与鼓的过门接回开头。"
          : "末小节用转回和弦接回开头，可以无缝循环。"
        : loopFill
          ? "末小节用鼓的过门接回开头，可以无缝循环。"
          : harmony.overridden
            ? "首尾相接，可以无缝循环。"
            : "首尾和声相接，可以无缝循环。",
    );
  } else notes.push("结尾回到主和弦并保持，留出自然衰减的余韵。");

  return {
    version: 2,
    style: cfg.mood,
    lead: cfg.instrument,
    seed: cfg.seed,
    sampleRate: SAMPLE_RATE,
    bpm: timing.bpm,
    beatsPerBar: timing.beatsPerBar,
    bars: timing.bars,
    duration: timing.duration,
    loop: timing.loop,
    key: {
      tonic: key.tonic,
      minor: key.minor,
      label: key.label,
      scale: key.pcs.slice(),
    },
    swing,
    sections: publicSections,
    chords: chordSpans(harmony, timing),
    parts,
    space: spaceFor(style, cfg, timing),
    master: { ...style.master },
    notes: notes.slice(0, 6),
  };
}

function instrumentNames(
  parts: readonly Part[],
  config: Pick<MusicConfig, "instrument">,
): string[] {
  const names: string[] = [];
  for (const part of parts) {
    // an accompaniment played on the lead's own instrument (a pianist's left hand) is not a second instrument
    if (
      part.kind === "notes" &&
      part.role !== "lead" &&
      part.voice === config.instrument
    )
      continue;
    const name =
      part.kind === "drums"
        ? part.role === "perc"
          ? "打击乐点缀"
          : KIT_LABELS[part.kit]
        : part.role === "lead"
          ? instrumentLabel(config.instrument)
          : VOICE_LABELS[part.voice];
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/** What a change of settings does to the tune (see melodyContinuity). */
export type MelodyContinuity = "identical" | "adapted" | "rhythm" | "new";

/** Steps per bar of the grid two tunes are compared on (thirty-seconds: a grace note has a place of its own). */
const TUNE_GRID = 32;

/** The tune of one section on that grid: the scale degrees written at each step. */
interface TuneSection {
  /** "verse#0", "chorus#1" …: the same section in another form of the piece */
  name: string;
  type: Section["type"];
  bars: number;
  /** step from the start of the section → semitones above the tonic of the notes struck there */
  notes: Map<number, number[]>;
}
interface Tune {
  sections: TuneSection[];
  /** notes of the tune as written (a tremolo is one note) */
  total: number;
  /** every note as it is struck, the strokes of a tremolo included: equal for two leads that play the same thing */
  struck: string;
}

const tuneCache = new Map<string, Tune>();

/** The lead of a piece as the composer writes it, section by section (cached: the agent asks about the same piece again and again). */
function tuneOf(cfg: MusicConfig): Tune {
  // (the faders, the reverb and the description never reach a note)
  const id = JSON.stringify({
    ...cfg,
    prompt: undefined,
    volumes: undefined,
    reverb: undefined,
  });
  const cached = tuneCache.get(id);
  if (cached) {
    // (most recently used last)
    tuneCache.delete(id);
    tuneCache.set(id, cached);
    return cached;
  }
  const { ctx, key, timing, sections } = draft(cfg);
  const line: TuneNote[] = [];
  const played = composeLead(ctx, line);
  const seen = new Map<string, number>();
  const tune: Tune = {
    sections: sections.map((section) => {
      const occurrence = seen.get(section.type) ?? 0;
      seen.set(section.type, occurrence + 1);
      return {
        name: `${section.type}#${occurrence}`,
        type: section.type,
        bars: section.bars,
        notes: new Map<number, number[]>(),
      };
    }),
    total: line.length,
    struck: "",
  };
  const last = sections.length - 1;
  /** a note's section, its step on the grid from the start of that section, and its scale degree */
  const place = (note: TuneNote) => {
    const bar = Math.floor(note.beat / timing.beatsPerBar + 1e-6);
    let index = sections.findIndex(
      (section) =>
        bar >= section.startBar && bar < section.startBar + section.bars,
    );
    if (index < 0) index = last;
    const step = Math.round(
      ((note.beat - sections[index].startBar * timing.beatsPerBar) *
        TUNE_GRID) /
        timing.beatsPerBar,
    );
    return { index, step, degree: (((note.midi - key.tonic) % 12) + 12) % 12 };
  };
  for (const note of line) {
    const { index, step, degree } = place(note);
    const at = tune.sections[index].notes;
    at.set(step, [...(at.get(step) ?? []), degree]);
  }
  tune.struck = played
    .map((note) => {
      const { index, step, degree } = place(note);
      return `${tune.sections[index].name}@${step}:${degree}`;
    })
    .sort()
    .join(" ");
  if (tuneCache.size >= 32)
    tuneCache.delete(tuneCache.keys().next().value as string);
  tuneCache.set(id, tune);
  return tune;
}

/** Notes of `a` that `b` has too, in the bars both sections have: by place alone, and by place and scale degree. */
function sharedNotes(a: TuneSection, b: TuneSection, maxBars = Infinity) {
  const steps = Math.min(a.bars, b.bars, maxBars) * TUNE_GRID;
  const inside = (section: TuneSection) => {
    let count = 0;
    for (const [step, degrees] of section.notes)
      if (step >= 0 && step < steps) count += degrees.length;
    return count;
  };
  let onsets = 0;
  let notes = 0;
  for (const [step, degrees] of a.notes) {
    if (step < 0 || step >= steps) continue;
    const other = b.notes.get(step);
    if (!other) continue;
    const left = other.slice();
    for (const degree of degrees) {
      if (!left.length) break;
      onsets++;
      const match = left.indexOf(degree);
      if (match >= 0) {
        notes++;
        left.splice(match, 1);
      } else left.pop();
    }
  }
  const counts = [inside(a), inside(b)];
  return {
    onsets,
    notes,
    most: Math.max(...counts),
    least: Math.min(...counts),
  };
}

/** The section two versions of a piece are compared on first: the verse where both have one. */
const FIRST_SECTION: Section["type"][] = [
  "verse",
  "chorus",
  "bridge",
  "build",
  "breakdown",
  "outro",
  "intro",
];

/** Shares of the tune that two versions of a piece have in common (see melodyRetention). */
export interface MelodyRetention {
  /** of all notes of the lead, those that keep their place in their section and their scale degree */
  whole: number;
  /** every note is struck at the same place on the same degree, the strokes of a tremolo included */
  same: boolean;
  /** the same inside the bars both versions have (sections matched by kind and order) */
  common: number;
  /** the same inside the first verse (at most eight bars; the first kind of section both have) */
  verse: number;
  /** of the first verse's notes, those that keep their place, whatever their pitch */
  rhythm: number;
  /**
   * Of the notes of the SPARSER first verse, those the busier one has too
   * (place and scale degree): near 1 when a tune was only thinned or filled,
   * however many notes that took away or added.
   */
  contained: number;
}

/**
 * How much of the tune a change of settings keeps, measured on the two leads
 * as the composer writes them (a note re-struck as a tremolo is one note). A
 * share is counted against the busier of the two versions, so notes that
 * were taken away or added count as changed.
 * Scale degrees are counted from the tonic and by pitch class: a tune that
 * is transposed, or played in another octave, keeps every one of them.
 */
export function melodyRetention(
  before: MusicConfig,
  after: MusicConfig,
): MelodyRetention {
  const a = tuneOf(clampConfig((before ?? {}) as Partial<MusicConfig>));
  const b = tuneOf(clampConfig((after ?? {}) as Partial<MusicConfig>));
  let notes = 0;
  let most = 0;
  for (const section of a.sections) {
    const other = b.sections.find((item) => item.name === section.name);
    if (!other) continue;
    const shared = sharedNotes(section, other);
    notes += shared.notes;
    most += shared.most;
  }
  const total = Math.max(a.total, b.total);
  const whole = total ? notes / total : 1;
  const common = most ? notes / most : 1;
  const first = (tune: Tune, type: Section["type"]) =>
    tune.sections.find((section) => section.type === type);
  const type =
    FIRST_SECTION.find((item) => first(a, item) && first(b, item)) ?? "verse";
  const left = first(a, type);
  const right = first(b, type);
  const same = a.struck === b.struck;
  if (!left || !right)
    return { whole, same, common, verse: 0, rhythm: 0, contained: 0 };
  const shared = sharedNotes(left, right, 8);
  return shared.most
    ? {
        whole,
        same,
        common,
        verse: shared.notes / shared.most,
        rhythm: shared.onsets / shared.most,
        contained: shared.least ? shared.notes / shared.least : 0,
      }
    : { whole, same, common, verse: 1, rhythm: 1, contained: 1 };
}

/**
 * What each answer of melodyContinuity promises about the two composed
 * pieces, as shares of notes: "identical" of the whole lead (place and scale
 * degree), "adapted" of the first verse (place and scale degree), "rhythm"
 * of the first verse (place alone). The composer answers from stricter
 * thresholds than these, so that a measurement on the finished scores —
 * humanised, swung, a tremolo counted as one note or as many — still finds
 * the promise kept.
 */
export const MELODY_PROMISE = { identical: 0.99, adapted: 0.6, rhythm: 0.85 };

/**
 * What a change of settings does to the tune. The answer is not predicted
 * from the settings: both leads are written and compared (melodyRetention),
 * so it is true of the two pieces whatever combination of controls and hints
 * lies between them.
 *   "identical" every note keeps its place and its scale degree: the same
 *               tune, possibly in another key or octave (a note the
 *               instrument cannot reach is played an octave nearer), at
 *               another tempo or with other dynamics. Reverb, faders, drum
 *               and bass feel, layers, a nudge of tempo or energy, another
 *               key of the same mode.
 *   "adapted"   the same motifs, fitted to the new settings: at least two
 *               thirds of the first verse's notes keep both place and scale
 *               degree. Thinned or filled a little, ornamented, laid over
 *               another form, settled on a chord that changed, a chorus
 *               lifted more or less for another lead.
 *   "rhythm"    the rhythm of the tune survives and the pitches are written
 *               again: nine tenths of the first verse's notes keep their
 *               place, but not their degree. Major to minor, a register or
 *               progression hint, a lead for which the style keeps another
 *               scale.
 *   "new"       another tune: a new seed, another style, or settings so far
 *               apart that neither the notes nor the rhythm are kept to that
 *               measure; also the frozen v0.2 engine on either side. (A tune
 *               thinned to half its notes by a density hint counts here too,
 *               by the letter of the measure: MelodyRetention.contained
 *               tells that case from a tune that was drawn again.)
 * tests/music-continuity.test.ts holds every answer against composed scores.
 */
export function melodyContinuity(
  before: MusicConfig,
  after: MusicConfig,
): MelodyContinuity {
  if ((before?.engine ?? 2) !== 2 || (after?.engine ?? 2) !== 2) return "new";
  const a = clampConfig((before ?? {}) as Partial<MusicConfig>);
  const b = clampConfig((after ?? {}) as Partial<MusicConfig>);
  // another seed or style draws other motifs, however alike two sparse tunes may come out
  if (a.seed !== b.seed || a.mood !== b.mood) return "new";
  const kept = melodyRetention(a, b);
  if (kept.whole >= 0.999 && kept.same) return "identical";
  if (kept.verse >= 2 / 3) return "adapted";
  if (kept.rhythm >= 0.9) return "rhythm";
  return "new";
}

/** The light summary the UI keeps next to the audio. */
export function summarize(score: Score): ArrangementSummary {
  return {
    bpm: score.bpm,
    bars: score.bars,
    duration: score.duration,
    keyLabel: score.key.label,
    sections: score.sections.map((section) => ({ ...section })),
    chords: score.chords.map((chord) => ({
      ...chord,
      pitchClasses: chord.pitchClasses.slice(),
    })),
    instruments: instrumentNames(score.parts, { instrument: score.lead }),
    notes: score.notes.slice(),
  };
}
