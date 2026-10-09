/**
 * The offline producer brain. One request is read clause by clause
 * (reading.ts); every clause yields instructions — set / raise / lower /
 * remove / restore / keep, each with the thing it is about (style, tempo,
 * length, key, lead, the three inspector sliders, the four mixer tracks, the
 * arrangement layers, the melody) and an amount (absolute with a unit,
 * relative with a unit, or vague). The instructions are applied to the
 * configuration, and everything the user is told is derived from what
 * actually changed. Pure and deterministic — no network, no clock, no
 * randomness.
 */
import type { ArrangementHints, MusicConfig, TrackName } from "../types";
import {
  LIMITS,
  STYLES,
  STYLE_IDS,
  instrumentLabel,
  parseKey,
  styleInfo,
  styleLabel,
  type DrumFeel,
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
  AMOUNT_LABELS,
  TRACK_LABELS,
  buildCloudPrompt,
  describeChanges,
  describeChoices,
  keyLabel,
  melodyNote,
} from "./cloudPrompt";
import {
  STYLE_COORDS,
  STYLE_LEADS,
  gapBetween,
  keyName,
  withMode,
  type Analysis,
  type Dim,
  type Lex,
  type Target,
} from "./lexicon";
import { describePins, readPins, withPins } from "./pins";
import { read, type Clause, type Mode, type Word } from "./reading";

const TRACKS: TrackName[] = ["melody", "chords", "bass", "drums"];
const isTrack = (target: Target): target is TrackName =>
  (TRACKS as string[]).includes(target);
type Amount = Exclude<Dim, "tempo">;
const AMOUNTS: Amount[] = ["energy", "complexity", "reverb"];
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
  complexity: 0.2,
  reverb: 0.15,
  tempo: 12,
};
/** One step of a mixer fader. */
const FADER_STEP = 0.2;
/** A new piece: a hedged word ("带一点忧伤") colours the piece, it does not choose the style. */
const HEDGED = 0.4;
const COMPARED = 0.75;
/** What the music is (genre) outranks where it will be used (scene). */
const GENRE_BOOST = 1.25;
const SCENE_BESIDE_GENRE = 0.6;

/**
 * What makes a piece sound like a style, in terms the engine can turn up or
 * down. "少点爵士味" moves away from these, "来点爵士味" towards them.
 */
const TRAITS: Partial<
  Record<
    StyleId,
    {
      energy?: 1 | -1;
      complexity?: 1 | -1;
      reverb?: 1 | -1;
      tempo?: 1 | -1;
      swing?: true;
      drums?: DrumFeel;
    }
  >
> = {
  jazz: { complexity: 1, swing: true },
  dance: { energy: 1, drums: "fourfloor" },
  rock: { energy: 1 },
  epic: { energy: 1 },
  battle: { energy: 1, tempo: 1 },
  cute: { energy: 1 },
  festive: { energy: 1 },
  bright: { energy: 1 },
  sad: { energy: -1, tempo: -1 },
  chill: { energy: -1, tempo: -1 },
  romantic: { energy: -1 },
  focus: { energy: -1, complexity: -1 },
  ambient: { energy: -1, reverb: 1 },
  dreamy: { reverb: 1 },
  cinematic: { reverb: 1 },
};

/**
 * "小调" is also a ditty ("口哨小调", "一首欢快的小调") and "大调" sits inside
 * other words, so the bare word changes the key only where it can be nothing
 * but an instruction: after a verb that sets something ("改成小调", "用大调",
 * "转小调"), as a clause of its own ("小调", "90 BPM，小调"), negated, or
 * describing the colour of the piece ("来点小调的感觉"). A key with its tonic
 * ("D 小调") never gets here: the lexicon reads it as a key.
 */
const MODE_VERB =
  /(?:改成|改为|改用|改到|改|换成|换为|换用|换到|换|转成|转为|转到|转|变成|变为|变|切换到|切到|切成|调成|调为|调到|设成|设为|使用|采用|用|要)(?:一?个)?\s*$/;
const MODE_TURN = /^.*(?:但是|但|不过|而是|只是|然后|同时|并且|而且)/;
const MODE_LEAD =
  /^(?:整体|整首|全曲|调性|调式|曲子|音乐|key|请|麻烦|帮我|给我|我|想|是|为|[:：=\s])*$/;
const MODE_TAIL =
  /^(?:吧|呢|啊|呀|嘛|哦|的|了|试试|看看|就行|就好|即可|好了|可以吗|行吗|怎么样|如何|\s)*$/;
const MODE_COLOUR = /^\s*的?\s*(?:感觉|色彩|味道|调式|音阶|氛围|感|味)/;
const MODE_PARTIAL =
  /(?:来点|来一点|加点|加一点|带点|带一点|有点|一点|一些|更|再|偏向|偏)\s*$/;
/** Punctuation, or a number or key the lexicon already took out of the text. */
const CLAUSE_BREAK = /[,.;:!?，。；：！？、\n\u0001]/;

function modeInstruction(lower: string, word: Word): boolean {
  // "minor key", "in major" have no second meaning
  if (/[a-z]/.test(word.text) || word.neg || word.too) return true;
  const before = lower.slice(0, word.start).split(CLAUSE_BREAK).pop() ?? "";
  const after = lower.slice(word.end).split(CLAUSE_BREAK)[0];
  if (MODE_VERB.test(before)) return true;
  const alone = MODE_LEAD.test(before.replace(MODE_TURN, ""));
  if (alone && MODE_TAIL.test(after)) return true;
  return MODE_COLOUR.test(after) && (alone || MODE_PARTIAL.test(before));
}

/** single characters such as 快 / 重 / 亮 (and "long", "short") only count next to a modifier */
const needsModifier = (word: Word) =>
  (word.text.length === 1 || word.text === "long" || word.text === "short") &&
  !!(word.lex.dim || word.lex.mode || word.lex.length);
const modified = (word: Word) =>
  !!(word.compared || word.too || word.neg || word.very);

/* ---------- what a request asks for ---------- */

interface TrackAsk {
  track: TrackName;
  kind: "mute" | "restore" | "add" | "only" | "set" | "step" | "scale" | "keep";
  /** set: 0..1 · step: signed fader units · scale: factor */
  value?: number;
  /** "only": the tracks that stay */
  group?: TrackName[];
}

/** What the request asks for, before it is applied to a configuration. */
interface Intent {
  analysis: Analysis;
  words: Word[];
  clauses: Clause[];
  /** style evidence of a description (drives the style of a new piece) */
  lexical: Record<StyleId, number>;
  evidence: Map<StyleId, string[]>;
  /** refinements: evidence from words that instruct a change of style */
  restyle: Record<StyleId, number>;
  /** "换个风格": a style change is wanted even if no style word instructs it */
  restyleWanted: boolean;
  /** "加点爵士味": borrow a style's colour */
  towards: Map<StyleId, string>;
  /** "少点爵士味", "太像恐怖片了": move away from a style's colour */
  away: Map<StyleId, string>;
  /** a new piece: styles named only as a colour ("带一点忧伤") */
  hedged: Map<StyleId, string>;
  /** refinements: styles named only as what the music is for ("适合咖啡馆") */
  contexts: Map<StyleId, string>;
  valence: number;
  arousal: number;
  /** arousal of emotion words only, for refinements that keep the style */
  feeling: number;
  leads: InstrumentId[];
  excluded: Set<InstrumentId>;
  /** "换个乐器", "钢琴换成别的": any lead but the current / the named one */
  otherLead: boolean;
  soloLead: boolean;
  padFromStrings: boolean;
  trackAsks: TrackAsk[];
  /** every track the text names or balances, even where no level word was understood */
  tracks: Set<TrackName>;
  touchedDrums: boolean;
  delta: Record<Dim, number>;
  /** exact changes ("混响加 20%") and exact values ("能量 80%") of the three sliders */
  amountBy: Partial<Record<Amount, number>>;
  amountSet: Partial<Record<Amount, number>>;
  /** "混响恢复": sliders (or the tempo) that go back to the style's own value */
  restored: Set<Dim>;
  /** a new piece: "安静的…" keeps the slider inside a band instead of moving it */
  band: Partial<Record<Amount, { dir: 1 | -1; very: boolean }>>;
  tempo: {
    set?: number;
    by?: number;
    factor?: number;
    pos?: number;
    own?: number;
  };
  scenePos?: number;
  length: {
    set?: number;
    by?: number;
    factor?: number;
    cap?: number;
    floor?: number;
    step: number;
  };
  modeExplicit?: "major" | "minor";
  modeVotes: Set<"major" | "minor">;
  /** "不要这么悲伤": leave that mode if the piece is in it */
  modeAway: Set<"major" | "minor">;
  shift: number;
  relative?: "major" | "minor";
  loop?: boolean;
  impliedLoop?: boolean;
  seed?: "melody" | "again";
  arrangement: ((hints: ArrangementHints) => void)[];
  register: number;
  density: number;
  reset?: "all" | "volumes";
  restoreMuted: boolean;
  short: boolean;
  noDrums: boolean;
  /** displeasure with nothing to act on ("不好听") */
  dislike: boolean;
  /** a key change was asked for without saying which ("换个调") */
  askKey: boolean;
  notes: string[];
  tags: string[];
}

/** Placeholders: whether "已按整首处理" is true is known once the request is applied. */
const SECTION_NOTE = "\u0001section";
const TIME_NOTE = "\u0001time";
const SECTION_SKIP = "暂时不能只在某一段去掉或保留声部，这部分没有改动";
const scopeNote = (marker: string, applied: boolean) =>
  marker === SECTION_NOTE
    ? applied
      ? "暂时不能只修改某一个段落，已按整首处理"
      : "暂时不能只修改某一个段落"
    : applied
      ? "暂时不能按时间点修改，已按整首处理"
      : "暂时不能只修改某个时间点";
const FORM_NOTE = "暂时不能分段安排强弱，整首按风格自己的起伏来写";
const OVERALL_NOTE =
  "整体音量请用播放器的音量滑块；我可以分别调旋律、和声、贝斯、鼓组的音量";

function emptyScores(): Record<StyleId, number> {
  return Object.fromEntries(STYLE_IDS.map((id) => [id, 0])) as Record<
    StyleId,
    number
  >;
}

function interpret(text: string, mode: Mode): Intent {
  const { analysis, words, clauses } = read(text, mode);
  const { lower } = analysis;
  const intent: Intent = {
    analysis,
    words,
    clauses,
    lexical: emptyScores(),
    evidence: new Map(),
    restyle: emptyScores(),
    restyleWanted: words.some(
      (word, i) =>
        word.lex.change &&
        !!words[i + 1]?.lex.suffix &&
        gapBetween(lower, word.end, words[i + 1].start, 1) !== null,
    ),
    towards: new Map(),
    away: new Map(),
    hedged: new Map(),
    contexts: new Map(),
    valence: 0,
    arousal: 0,
    feeling: 0,
    leads: [],
    excluded: new Set(),
    otherLead: false,
    soloLead: false,
    padFromStrings: false,
    trackAsks: [],
    tracks: new Set(),
    touchedDrums: false,
    delta: { energy: 0, complexity: 0, reverb: 0, tempo: 0 },
    amountBy: {},
    amountSet: {},
    restored: new Set(),
    band: {},
    tempo: {},
    length: { step: 0 },
    modeVotes: new Set(),
    modeAway: new Set(),
    shift: 0,
    arrangement: [],
    register: 0,
    density: 0,
    restoreMuted: false,
    short: false,
    noDrums: false,
    dislike: false,
    askKey: false,
    notes: [],
    tags: [],
  };
  const note = (message: string) => {
    // one remark about "only part of the piece" is enough
    if (message === SECTION_NOTE && intent.notes.includes(TIME_NOTE)) return;
    if (!intent.notes.includes(message)) intent.notes.push(message);
  };
  const near = (a: number, b: number, max: number) =>
    a >= 0 &&
    b < words.length &&
    gapBetween(lower, words[a].end, words[b].start, max) !== null;
  const clauseOf = (i: number) => clauses[words[i].clause];
  const sameClause = (a: number, b: number) =>
    a >= 0 && b < words.length && words[a].clause === words[b].clause;

  // several words pulling the same way are one request, not a sum
  const up: Record<Dim, number> = {
    energy: 0,
    complexity: 0,
    reverb: 0,
    tempo: 0,
  };
  const down: Record<Dim, number> = {
    energy: 0,
    complexity: 0,
    reverb: 0,
    tempo: 0,
  };
  const bump = (dim: Dim, value: number) => {
    if (value > 0) up[dim] = Math.max(up[dim], value);
    else down[dim] = Math.min(down[dim], value);
  };
  let longer = 0;
  let shorter = 0;
  const stretch = (dir: number) => {
    if (dir > 0) longer = 1;
    else shorter = -1;
  };
  const ask = (entry: TrackAsk) => {
    if (entry.track === "drums") intent.touchedDrums = true;
    intent.tracks.add(entry.track);
    intent.trackAsks.push(entry);
  };

  /* ----- numbers: a total, a change, a bound or a point in time ----- */
  const TO = /到|至|成|为|是|在|=|:|\bto\b|\bat\b/;
  const directionOf = (word: Word): 1 | -1 | undefined =>
    word.lex.length ??
    (word.lex.dim === "tempo" ? word.lex.dir : undefined) ??
    (word.lex.op === "up" || word.lex.op === "add"
      ? 1
      : word.lex.op === "down"
        ? -1
        : undefined);
  /** Tracks (through a list: "鼓和贝斯各 40%") or the slider a word stands for. */
  const subjectsAt = (index: number): Target[] => {
    const lex = words[index].lex;
    if (lex.inst && !lex.cat) return ["melody"];
    if (!lex.target) return lex.dim ? [lex.dim] : [];
    const found: Target[] = [lex.target];
    let first = index;
    while (
      words[first - 1]?.lex.link &&
      words[first - 2]?.lex.target &&
      near(first - 2, first - 1, 1) &&
      near(first - 1, first, 1)
    ) {
      first -= 2;
      found.unshift(words[first].lex.target as Target);
      words[first].used = true;
    }
    return found;
  };

  words.forEach((word, i) => {
    const qty = word.lex.qty;
    if (!qty || word.used) return;
    word.used = true;
    const clause = clauseOf(i);
    const before = lower.slice(clause.start, word.start);
    const after = lower.slice(word.end, clause.end);

    // the word that governs the number: skip "再 / 个 / 大约"
    let g = i - 1;
    while (g >= 0 && sameClause(g, i) && words[g].lex.mod && !words[g].lex.neg)
      g--;
    const governed = g >= 0 && sameClause(g, i) && near(g, i, 4);
    let dir = governed ? directionOf(words[g]) : undefined;
    let dirIndex = dir !== undefined ? g : -1;
    let subjectIndex = -1;
    if (governed) {
      if (dir === undefined || words[g].lex.op) {
        let s = dir === undefined ? g : g - 1;
        while (s >= 0 && sameClause(s, i) && words[s].lex.mod) s--;
        if (
          s >= 0 &&
          sameClause(s, i) &&
          (s === g || near(s, g, 3)) &&
          (words[s].lex.target ||
            words[s].lex.dim ||
            words[s].lex.length ||
            (words[s].lex.inst && !words[s].lex.cat))
        )
          subjectIndex = s;
      } else subjectIndex = g;
    }
    // "20 seconds longer", "10 bpm faster"
    const trailing = words[i + 1];
    if (
      dir === undefined &&
      trailing &&
      sameClause(i, i + 1) &&
      near(i, i + 1, 1) &&
      /^[a-z]/.test(trailing.text) &&
      directionOf(trailing) !== undefined &&
      (trailing.lex.length || trailing.lex.dim === "tempo")
    ) {
      dir = directionOf(trailing);
      dirIndex = i + 1;
      subjectIndex = i + 1;
    }
    const signed = /[+＋]\s*$/.test(before)
      ? 1
      : /(?:^|\s)-\s*$/.test(before)
        ? -1
        : undefined;
    const between =
      dirIndex >= 0 && dirIndex < i
        ? lower.slice(words[dirIndex].end, word.start)
        : subjectIndex >= 0 && subjectIndex < i
          ? lower.slice(words[subjectIndex].end, word.start)
          : "";
    const absolute = TO.test(between);
    const relative =
      !absolute && (dir !== undefined || signed !== undefined)
        ? ((dir ?? signed) as 1 | -1)
        : undefined;
    const consume = () => {
      if (dirIndex >= 0) words[dirIndex].used = true;
      if (subjectIndex >= 0 && words[subjectIndex].lex.dim)
        words[subjectIndex].used = true;
      if (subjectIndex >= 0 && words[subjectIndex].lex.length)
        words[subjectIndex].used = true;
    };

    if (qty.unit === "s") {
      const point =
        qty.clock &&
        !/(?:时长|长度|共|总长|duration|length)\s*[:=]?\s*$/.test(before)
          ? /^\s*(?:的地方|的位置|的时候|那里|那儿|处|时|左右的地方|之后|以后|之前|以前|开始|进)/.test(
              after,
            )
          : false;
      const position =
        point ||
        clause.scoped ||
        /(?:第|前|后|最后|开头|开始|末尾|头|尾|first|last|from)\s*$/.test(
          before,
        ) ||
        /^\s*(?:的地方|的位置|的时候|那里|那儿|处|时进|之后|以后|之前|以前|开始|mark)/.test(
          after,
        ) ||
        words.some(
          (other, k) =>
            k < i &&
            sameClause(k, i) &&
            other.lex.loop === false &&
            near(k, i, 1),
        );
      if (position) {
        clause.scoped = true;
        note(TIME_NOTE);
        return;
      }
      if (
        /(?:不超过|不要超过|别超过|最多|最长|at most|up to|under|no more than|less than|within)\s*$/.test(
          before,
        ) ||
        /^\s*(?:以内|之内|以下|or less)/.test(after)
      ) {
        intent.length.cap = qty.value;
        return;
      }
      if (
        /(?:至少|不少于|起码|最少|at least)\s*$/.test(before) ||
        /^\s*(?:以上|or more)/.test(after)
      ) {
        intent.length.floor = qty.value;
        return;
      }
      if (relative !== undefined) {
        consume();
        intent.length.by = (intent.length.by ?? 0) + relative * qty.value;
      } else if (qty.value >= 5 && intent.length.set === undefined) {
        consume();
        intent.length.set = qty.value;
      }
      return;
    }

    const subjects = subjectIndex >= 0 ? subjectsAt(subjectIndex) : [];
    const subject: Target | "duration" | undefined =
      qty.unit === "bpm"
        ? "tempo"
        : subjectIndex >= 0 && words[subjectIndex].lex.length
          ? "duration"
          : subjects[0];

    if (subject === "tempo") {
      if (qty.unit === "x") intent.tempo.factor = qty.value;
      else if (qty.unit === "%" && relative === undefined && !absolute) return;
      else if (qty.unit === "%")
        intent.tempo.factor =
          relative === undefined ? undefined : 1 + (relative * qty.value) / 100;
      else if (relative !== undefined)
        intent.tempo.by = (intent.tempo.by ?? 0) + relative * qty.value;
      else if (intent.tempo.set === undefined) intent.tempo.set = qty.value;
      consume();
      if (subjectIndex >= 0) words[subjectIndex].used = true;
      return;
    }
    if (subject === "duration") {
      if (qty.unit === "x") {
        intent.length.factor = qty.value;
        consume();
      }
      return;
    }
    if (subject === undefined) {
      // a number with nothing to attach it to
      if (qty.unit === "%" && /音量|volume|响度/.test(before))
        note(OVERALL_NOTE);
      else if (
        mode === "refine" &&
        qty.unit === "n" &&
        (dir !== undefined || absolute || TO.test(before.slice(-2)))
      )
        note(
          `没听懂 ${qty.value} 指的是哪一项，可以说「速度 ${qty.value}」或「时长 ${qty.value} 秒」`,
        );
      return;
    }

    consume();
    words[subjectIndex].used = true;
    const fraction =
      qty.unit === "%" || (qty.unit === "n" && qty.value > 1)
        ? qty.value / 100
        : qty.value;
    for (const target of subjects) {
      if (isTrack(target)) {
        if (qty.unit === "x")
          ask({ track: target, kind: "scale", value: qty.value });
        else if (relative !== undefined)
          ask({ track: target, kind: "step", value: relative * fraction });
        else {
          if (fraction > 1) note("音量最大是 100%");
          ask({ track: target, kind: "set", value: clamp(fraction, 0, 1) });
        }
      } else if (target !== "tempo") {
        if (qty.unit === "x")
          intent.amountBy[target] = qty.value >= 1 ? 0.25 : -0.25;
        else if (relative !== undefined)
          intent.amountBy[target] =
            (intent.amountBy[target] ?? 0) + relative * fraction;
        else intent.amountSet[target] = clamp(fraction, 0, 1);
      }
    }
  });

  /* ----- mixer targets and the level words attached to them ----- */
  interface Level {
    kind: NonNullable<Lex["op"]> | "dim";
    dir: 1 | -1;
    scale: number;
    pos?: number;
    compared: boolean;
    /** the quality the level word itself speaks of ("密" is about density) */
    dim?: Dim;
    text: string;
  }
  /** "强力和弦", "大街": a one-character level word needs a modifier or the end of its clause */
  const emphatic = (k: number) => {
    const word = words[k];
    const rest = lower.slice(word.end, clauseOf(k).end);
    const previous = words[k - 1];
    return (
      /^\s*(?:了|啦|吧|呢|啊|些|点|一点|一些|得|$)/.test(rest) ||
      (!!words[k + 1]?.lex.mod && near(k, k + 1, 0)) ||
      (!!previous &&
        (!!previous.lex.mod || previous.lex.neg === "too") &&
        near(k - 1, k, 0))
    );
  };
  /**
   * The level word attached to words[index]. Adjectives only count when
   * `accepts` their quality; `strict` (instrument words) takes plain volume
   * words only; `opsOnly` takes no adjectives at all.
   */
  const levelNear = (
    index: number,
    direction: 1 | -1,
    accepts: (dim: Dim) => boolean,
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
          lex.dim === "energy" && accepts("energy")
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
          return {
            kind: "dim",
            dir: flip(dir),
            scale,
            compared,
            text: word.text,
          };
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
      const sideOk =
        lex.side === "both" || lex.side === (direction > 0 ? "post" : "pre");
      if (
        lex.op &&
        sideOk &&
        !(
          strict &&
          (lex.op === "add" || lex.op === "unmute" || lex.op === "only")
        )
      ) {
        if (
          word.text.length === 1 &&
          (lex.op === "up" || lex.op === "down") &&
          !emphatic(k)
        )
          break;
        word.used = true;
        if (direction > 0) trailing();
        const dir = lex.op === "down" ? -1 : 1;
        return {
          kind: lex.op,
          dir: lex.op === "up" || lex.op === "down" ? flip(dir) : dir,
          scale,
          compared,
          text: word.text,
        };
      }
      if (
        lex.dim &&
        accepts(lex.dim) &&
        direction > 0 &&
        lex.dir &&
        !(strict && ((word.text.length > 1 && !lex.fixed) || lex.mode))
      ) {
        word.used = true;
        trailing();
        return {
          kind: "dim",
          dir: flip(lex.dir),
          scale,
          pos: lex.pos,
          compared,
          dim: lex.dim,
          text: word.text,
        };
      }
      break;
    }
    return undefined;
  };
  /** Qualities a level adjective may have next to this target. */
  const acceptsFor =
    (target: Target) =>
    (dim: Dim): boolean =>
      isTrack(target)
        ? dim === "energy" || dim === "complexity"
        : target === "energy"
          ? dim !== "tempo"
          : dim === target;

  for (let i = 0; i < words.length; i++) {
    if (!words[i].lex.target || words[i].used) continue;
    const group = [i];
    let last = i;
    while (
      words[last + 1]?.lex.link &&
      words[last + 2]?.lex.target &&
      !words[last + 2].used &&
      near(last, last + 1, 1) &&
      near(last + 1, last + 2, 1)
    ) {
      last += 2;
      group.push(last);
    }
    for (const index of group) words[index].used = true;
    const targets = group.map((index) => words[index].lex.target as Target);
    const negated = group.some((index) => words[index].neg === "hard");
    const kept = group.some((index) => words[index].kept);
    const only = group.some((index) => words[index].solo);
    const scoped = mode === "refine" && clauseOf(i).scoped;
    // "要鼓", "有低音": said about a track at the start of a clause, it brings the track back
    const lead = lower.slice(clauseOf(i).start, words[i].start);
    const wanted =
      mode === "refine" &&
      /^\s*(?:还是|那就|也|还|又|就)?(?:要|要有|有|带|带上|来)(?:点|个)?\s*$/.test(
        lead,
      );
    // "我不喜欢这个旋律", "旋律不好听": other notes, please
    const disliked = [words[i - 1], words[last + 1]].some(
      (word, side) =>
        !!word?.lex.dislike &&
        (side === 0 ? near(i - 1, i, 2) : near(last, last + 1, 2)),
    );
    const named = targets.filter(isTrack);
    // "除了鼓其他都小一点": everything but the tracks named
    const rest = words[last + 1];
    if (
      negated &&
      named.length === targets.length &&
      rest?.lex.other &&
      sameClause(last, last + 1) &&
      /^(?:除了|除|except)$/.test(words[group[0] - 1]?.text ?? "")
    ) {
      const others = levelNear(last + 1, 1, (dim) => dim === "energy");
      if (others && others.kind !== "only") {
        for (const track of TRACKS)
          if (!named.includes(track))
            ask(
              others.kind === "mute"
                ? { track, kind: "mute" }
                : {
                    track,
                    kind: "step",
                    value: others.dir * FADER_STEP * others.scale,
                  },
            );
        continue;
      }
    }
    const level =
      negated || kept
        ? undefined
        : (levelNear(group[0], -1, acceptsFor(targets[0])) ??
          levelNear(last, 1, acceptsFor(targets[targets.length - 1])));
    // "只要鼓和贝斯" is about the other tracks as well
    const everyTrack = named.length > 0 && (only || level?.kind === "only");
    for (const track of everyTrack ? TRACKS : named) intent.tracks.add(track);
    if (disliked && named.includes("melody")) {
      intent.seed = "melody";
      for (const word of [words[i - 1], words[last + 1]])
        if (word?.lex.dislike) word.used = true;
      continue;
    }
    if (scoped && (negated || level || only)) note(SECTION_NOTE);

    for (const target of targets) {
      if (isTrack(target)) {
        if (kept) ask({ track: target, kind: "keep" });
        else if (
          negated ||
          level?.kind === "mute" ||
          only ||
          level?.kind === "only"
        ) {
          if (scoped) note(SECTION_SKIP);
          else if (negated || level?.kind === "mute")
            ask({ track: target, kind: "mute" });
          else ask({ track: target, kind: "only", group: named });
        } else if (level?.kind === "unmute" || (!level && wanted))
          ask({ track: target, kind: "restore" });
        else if (
          !level &&
          mode === "refine" &&
          (words[i].changed || words[last].replaced)
        )
          note(
            target === "drums"
              ? "鼓组的音色跟随风格；想换律动可以说「四拍底鼓」「摇摆」「碎拍」或「半拍」"
              : target === "bass"
                ? "贝斯的音色跟随风格；想换走法可以说「行走贝斯」「八度贝斯」或「切分贝斯」"
                : target === "chords"
                  ? "和声跟随风格；可以说「改成爵士风格」，或者调「旋律丰富度」"
                  : "想换一段旋律可以说「换个旋律」，想换音色可以说「换成古筝」",
          );
        else if (level?.kind === "add")
          ask({ track: target, kind: "add", value: 0.15 * level.scale });
        else if (level?.dim === "complexity") {
          // "旋律密一点": the melody has a density of its own; the others follow the slider
          if (target === "melody") intent.density += level.dir * level.scale;
          else {
            bump("complexity", level.dir * STEP.complexity * level.scale);
            if (mode === "refine")
              note(
                `${TRACK_LABELS[target]}的疏密跟着「${AMOUNT_LABELS.complexity}」走，已经整体调整`,
              );
          }
        } else if (level && target === "melody" && /^[高低]$/.test(level.text))
          // "旋律太高了" is about pitch, not loudness
          intent.register += level.dir;
        else if (level)
          ask({
            track: target,
            kind: "step",
            value: level.dir * FADER_STEP * level.scale,
          });
        continue;
      }
      if (kept) continue;
      if (target === "reverb" && (negated || level?.kind === "mute")) {
        intent.amountSet.reverb = 0;
        continue;
      }
      if (!level || level.kind === "only" || level.kind === "mute") continue;
      if (level.kind === "unmute") {
        // "混响恢复": back to what the style has
        if (/恢复|restore|回来/.test(level.text)) intent.restored.add(target);
        continue;
      }
      if (target === "tempo" && level.pos !== undefined && !level.compared)
        intent.tempo.pos = level.pos;
      else bump(target, level.dir * STEP[target] * level.scale);
    }
  }

  // "活力少一点", "少点空间感", "层次少一些": a quality with a more / less word beside it
  words.forEach((word, i) => {
    const lex = word.lex;
    if (!lex.dim || !lex.dir || lex.target || word.used || word.neg) return;
    const never = () => false;
    const level = levelNear(i, -1, never) ?? levelNear(i, 1, never);
    if (!level || (level.kind !== "up" && level.kind !== "down")) return;
    word.used = true;
    bump(lex.dim, lex.dir * level.dir * STEP[lex.dim] * level.scale);
  });

  // "音调高一些", "调子低一点": the key moves, by a whole tone
  words.forEach((word, i) => {
    if (!word.lex.pitch) return;
    const never = () => false;
    const level = levelNear(i, 1, never) ?? levelNear(i, -1, never);
    if (level && (level.kind === "up" || level.kind === "down"))
      intent.shift += level.dir * 2;
  });

  // "钢琴太响了", "吉他小一点": the lead instrument stands for the melody fader
  words.forEach((word, i) => {
    if (!word.lex.inst || word.lex.cat || word.neg || word.kept || word.used)
      return;
    const level = levelNear(i, 1, (dim) => dim === "energy", true);
    if (!level) return;
    word.leveled = true;
    if (/^[高低]$/.test(level.text)) {
      intent.register += level.dir;
      return;
    }
    if (mode === "refine" && clauseOf(i).scoped) note(SECTION_NOTE);
    ask(
      level.kind === "mute"
        ? { track: "melody", kind: "mute" }
        : {
            track: "melody",
            kind: "step",
            value: level.dir * FADER_STEP * level.scale,
          },
    );
  });

  /* ----- styles: a run of style words shares what stands around it ----- */
  const styleWord = (word: Word) => !!word.lex.w && !!word.lex.cat;
  /** What a style word asks for when refining. */
  type Role = "away" | "restyle" | "towards" | "context" | "mood";
  const roles = new Map<number, Role>();
  if (mode === "refine") {
    const allBare = clauses.every((clause) => clause.bare);
    for (let i = 0; i < words.length; i++) {
      if (!styleWord(words[i]) || roles.has(i)) continue;
      const run = [i];
      while (
        words[run[run.length - 1] + 1] &&
        (styleWord(words[run[run.length - 1] + 1]) ||
          !!words[run[run.length - 1] + 1].lex.inst) &&
        near(run[run.length - 1], run[run.length - 1] + 1, 1)
      )
        run.push(run[run.length - 1] + 1);
      const any = (test: (word: Word) => boolean | undefined) =>
        run.some((index) => !!test(words[index]));
      const clause = clauseOf(i);
      const end = run[run.length - 1];
      // "爵士味太重了", "国风味再浓一点": the flavour itself is turned down or up
      let dosed: 1 | -1 | undefined;
      const suffix = words[end + 1];
      if (suffix?.lex.suffix && near(end, end + 1, 1)) {
        const level = levelNear(end + 1, 1, (dim) => dim === "energy");
        if (level && level.kind !== "mute") dosed = level.dir;
        else if (level) dosed = -1;
      }
      const genre = any((word) => !!word.lex.cat && word.lex.cat !== "emotion");
      // "鼓换成电子鼓": the sound of one part, not the style of the piece
      let verb = i - 1;
      while (verb >= 0 && words[verb].lex.mod) verb--;
      const partSwap =
        verb > 0 &&
        !!words[verb].lex.change &&
        !!words[verb - 1].lex.target &&
        isTrack(words[verb - 1].lex.target as Target) &&
        near(verb - 1, verb, 1);
      const named = any(
        (word) => word.lex.cat === "genre" || word.lex.cat === "era",
      );
      const role: Role = partSwap
        ? "context"
        : any((word) => !!word.neg || word.too || word.less) || dosed === -1
          ? "away"
          : dosed === 1
            ? "towards"
            : clause.ctx && !any((word) => word.changed)
              ? "context"
              : any((word) => word.liked)
                ? clause.want || any((word) => word.compared || word.changed)
                  ? "restyle"
                  : "context"
                : any((word) => word.styled) ||
                    (any((word) => word.changed) &&
                      (genre || !any((word) => word.compared)))
                  ? "restyle"
                  : intent.restyleWanted && genre
                    ? "restyle"
                    : any((word) => word.flavour || word.added) ||
                        (named && any((word) => word.compared))
                      ? "towards"
                      : clause.bare &&
                          genre &&
                          (allBare ||
                            any(
                              (word) =>
                                word.lex.cat === "genre" ||
                                word.lex.cat === "era",
                            ))
                        ? "restyle"
                        : genre
                          ? "context"
                          : "mood";
      for (const index of run)
        if (styleWord(words[index])) roles.set(index, role);
    }
  }

  /** "明亮的主音", "温柔的钢琴": the adjective describes a part, not the whole piece. */
  const attributive = (i: number) => {
    const next = words[i + 1];
    if (!next || !sameClause(i, i + 1)) return false;
    if (!/^\s*的?\s*$/.test(lower.slice(words[i].end, next.start)))
      return false;
    if (next.lex.inst || (next.lex.target && isTrack(next.lex.target)))
      return true;
    const then = words[i + 2];
    return (
      !!next.lex.mode &&
      !next.lex.w &&
      !!then?.lex.target &&
      near(i + 1, i + 2, 0)
    );
  };
  const genreNamed =
    mode === "new" &&
    words.some(
      (word) =>
        (word.lex.cat === "genre" || word.lex.cat === "era") &&
        !!word.lex.w &&
        !word.neg &&
        !word.too &&
        !word.flavour &&
        !word.replaced,
    );

  /* ----- everything else, word by word ----- */
  words.forEach((word, i) => {
    const lex = word.lex;
    const clause = clauseOf(i);
    if (lex.op === "mute" && word.kept) intent.restoreMuted = true;
    if (lex.reset && !word.neg) {
      intent.reset =
        lex.reset === "volumes" || intent.reset === "volumes"
          ? "volumes"
          : "all";
      return;
    }
    if (lex.dislike && !word.used) intent.dislike = true;
    if (lex.other && !word.neg) {
      const previous = words[i - 1];
      if (
        previous?.lex.change ||
        previous?.lex.brk ||
        /(?:换|用|要|来点?)\s*$/.test(lower.slice(clause.start, word.start))
      )
        intent.otherLead = true;
    }
    if (word.used && !lex.w) return;
    // "蓝调吉他，慢": a clause of its own is an instruction even without "一点"
    const alone =
      lower
        .slice(clause.start, clause.end)
        .replace(/[\s的地得要点些吧啊呀\u0001]/g, "") === word.text;
    const gated = needsModifier(word) && !modified(word) && !alone;
    const negative = word.neg === "hard";

    if (lex.unsupported && !word.neg) note(lex.unsupported);
    if (lex.note && lex.inst && !word.neg) note(`${word.text}：${lex.note}`);
    if (lex.tag && !word.neg) intent.tags.push(lex.tag);
    if (lex.seed && !word.neg)
      intent.seed =
        lex.seed === "melody" || intent.seed === "melody" ? "melody" : "again";
    if (lex.short && !word.neg) intent.short = true;
    if (lex.noDrums && !word.neg) intent.noDrums = true;
    if (lex.tempo && !word.neg) intent.tempo.own = lex.tempo;
    if (lex.shift) intent.shift += lex.shift;
    if (lex.relative) intent.relative = lex.relative;

    if (lex.loop !== undefined && !word.kept) {
      const value = negative ? !lex.loop : lex.loop;
      if (lex.w) intent.impliedLoop = value;
      else intent.loop = value;
    }

    if (lex.arr && !word.used) {
      const hint = lex.arr;
      const swing = word.scale > 1 ? 0.62 : word.scale < 1 ? 0.3 : 0.5;
      const restore = !!word.kept;
      if (mode === "refine" && clause.scoped) note(SECTION_NOTE);
      intent.arrangement.push((hints) => {
        for (const layer of ["pad", "arp", "counter", "perc"] as const)
          if (hint[layer] !== undefined)
            hints.layers = { ...hints.layers, [layer]: !negative || restore };
        if (hint.swing !== undefined) hints.swing = negative ? 0 : swing;
        if (hint.drums && !negative) hints.drums = hint.drums;
        if (hint.bass && !negative) hints.bass = hint.bass;
        if (hint.register && !negative)
          hints.melody = { ...hints.melody, register: hint.register };
        if (hint.motion && !negative)
          hints.melody = { ...hints.melody, motion: hint.motion };
      });
    }

    if (lex.length && !gated && !word.neg && !word.used) {
      const previous = words[i - 1];
      if (previous?.lex.section && near(i - 1, i, 1))
        note("暂时不能单独调整某一段的长度");
      // "太短了" asks for a longer piece
      else stretch(word.too ? -lex.length : lex.length);
    }
    if (lex.section && mode === "refine") {
      // "前奏长一点" has its own note; a bare section word is no instruction
      const edits = words.some(
        (other, k) =>
          k !== i &&
          sameClause(Math.min(k, i), Math.max(k, i)) &&
          (other.lex.op ||
            other.lex.dim ||
            other.lex.neg ||
            other.lex.inst ||
            other.lex.arr),
      );
      if (edits) note(SECTION_NOTE);
    }

    if (lex.mode && !gated) {
      const flipped = negative || word.too || word.neg === "too" || word.less;
      if (!lex.w && !lex.dim) {
        if (modeInstruction(lower, word))
          intent.modeExplicit = !flipped
            ? lex.mode
            : lex.mode === "major"
              ? "minor"
              : "major";
      } else if (flipped) intent.modeAway.add(lex.mode);
      else if (
        !(mode === "new" && (attributive(i) || word.flavour)) &&
        roles.get(i) !== "context"
      )
        intent.modeVotes.add(lex.mode);
    }

    if (lex.dim && lex.dir && !word.used && !gated) {
      const inverted = (word.too || !!word.neg || !!word.less) && !lex.fixed;
      const dir = (inverted ? -lex.dir : lex.dir) as 1 | -1;
      if (lex.dim === "tempo") {
        if (lex.pos !== undefined && !inverted && !word.compared)
          intent.tempo.pos = lex.pos;
        else bump("tempo", dir * STEP.tempo * word.scale);
      } else if (mode === "new" && !word.compared) {
        // a new piece has nothing to step from: "安静的…", "不要太吵" name a range
        if (clause.scoped) note(FORM_NOTE);
        else if (!attributive(i))
          intent.band[lex.dim] = { dir, very: !!word.very };
      } else bump(lex.dim, dir * STEP[lex.dim] * word.scale);
    }

    if (lex.inst) {
      // when refining, "钢琴太响了" is about loudness, not a request to change the lead
      const volumeOnly = word.leveled && mode === "refine";
      const next = words[i + 1];
      if (negative) intent.excluded.add(lex.inst);
      else if (word.kept) {
        /* "别去掉钢琴": nothing to do */
      } else if (word.replaced && next?.lex.change && words[i + 2]?.lex.other) {
        // "钢琴换成别的": anything but this one
        intent.excluded.add(lex.inst);
        intent.otherLead = true;
      } else if (word.added && lex.inst === "strings")
        intent.padFromStrings = true;
      else if (!word.neg && !word.replaced && !volumeOnly) {
        if (mode === "refine" && clause.scoped && !word.changed) {
          /* "前 8 秒只要钢琴": a part of the piece, not a new lead */
        } else if (word.changed) intent.leads.unshift(lex.inst);
        else {
          if (intent.leads.length && lex.inst === "strings" && !lex.cat)
            intent.padFromStrings = true;
          intent.leads.push(lex.inst);
        }
        if (word.solo && !(mode === "refine" && clause.scoped))
          intent.soloLead = true;
        else if (word.solo) note(SECTION_SKIP);
      }
    }

    if (lex.w) {
      const role = roles.get(i);
      const hedge =
        mode === "new" && lex.cat
          ? word.flavour
            ? HEDGED
            : word.compared && !word.changed
              ? COMPARED
              : 1
          : 1;
      const rank =
        mode === "new" && lex.cat && genreNamed
          ? lex.cat === "genre" || lex.cat === "era"
            ? GENRE_BOOST
            : lex.cat === "emotion"
              ? 1
              : SCENE_BESIDE_GENRE
          : 1;
      // an excluded instrument says nothing about the style
      const factor =
        (lex.inst && !lex.cat && word.neg) || word.replaced || word.kept
          ? 0
          : negative
            ? -1.5
            : word.neg === "too" || word.too || word.less
              ? -0.5
              : hedge * rank;
      const sign =
        factor >= 1
          ? 1
          : factor <= -1
            ? -1
            : factor < 0
              ? -0.5
              : factor > 0
                ? hedge
                : 0;
      const context = role === "context";
      for (const [id, weight] of Object.entries(lex.w) as [StyleId, number][]) {
        intent.lexical[id] += weight * factor;
        if (factor > 0) {
          const list = intent.evidence.get(id) ?? [];
          if (!list.includes(word.text)) list.push(word.text);
          intent.evidence.set(id, list);
        }
        if (role === "restyle") intent.restyle[id] += weight;
      }
      const best = (Object.entries(lex.w) as [StyleId, number][]).sort(
        (a, b) => b[1] - a[1],
      )[0]?.[0];
      if (best && lex.cat) {
        if (role === "towards" && lex.cat !== "emotion" && !lex.arr)
          intent.towards.set(best, word.text);
        if (role === "away" && (lex.cat !== "emotion" || !lex.a) && !lex.arr)
          intent.away.set(best, word.text);
        if (mode === "new" && hedge === HEDGED && factor > 0)
          intent.hedged.set(best, word.text);
        if (context && (lex.w[best] ?? 0) >= 3 && !intent.contexts.has(best))
          intent.contexts.set(best, word.text);
      }
      if (!context) {
        intent.valence += (lex.v ?? 0) * sign;
        intent.arousal += (lex.a ?? 0) * sign;
        if (lex.cat === "emotion" && !lex.dim)
          intent.feeling += (lex.a ?? 0) * sign;
        if (lex.pos !== undefined && !lex.dim && factor > 0)
          intent.scenePos = lex.pos;
      }
    } else if (lex.a && !gated && !word.used) {
      intent.arousal += lex.a * (word.too || word.neg ? -1 : 1);
    }
  });

  // "鼓不要去掉，只是小一点": a level word on its own speaks of the track
  // named just before
  words.forEach((word, i) => {
    const lex = word.lex;
    if (word.used || (lex.op !== "up" && lex.op !== "down") || lex.dim || lex.w)
      return;
    if (word.text.length === 1 && !emphatic(i)) return;
    const earlier = words
      .slice(0, i)
      .filter(
        (other) =>
          other.clause === word.clause - 1 &&
          !!other.lex.target &&
          isTrack(other.lex.target),
      )
      .pop();
    const own = words.some(
      (other, k) =>
        k !== i &&
        other.clause === word.clause &&
        (other.lex.target ||
          other.lex.dim ||
          other.lex.inst ||
          other.lex.pitch ||
          other.lex.qty ||
          (other.lex.w && other.lex.cat)),
    );
    if (own) return;
    let dir: 1 | -1 = lex.op === "up" ? 1 : -1;
    const previous = words[i - 1];
    if (
      previous &&
      (previous.lex.mod === "too" || previous.lex.neg === "too") &&
      near(i - 1, i, 0)
    )
      dir = -dir as 1 | -1;
    word.used = true;
    if (earlier && mode === "refine")
      ask({
        track: earlier.lex.target as TrackName,
        kind: "step",
        value: dir * FADER_STEP,
      });
    else if (mode === "refine")
      note(
        MIX_WORDS.test(lower) ||
          /所有|全部|整体|每个|各个|\ball\b|everything/.test(lower)
          ? OVERALL_NOTE
          : "没听出要调大或调小哪一项，可以说「鼓大一点」「情绪能量低一点」「音调高一点」",
      );
  });

  // "换个调": which key?
  if (
    mode === "refine" &&
    /换个?调|换一个调|换调|变调|transpose/.test(lower) &&
    !analysis.key &&
    !intent.shift &&
    !intent.modeExplicit &&
    !intent.relative
  )
    intent.askKey = true;
  if (
    /换个?乐器|换一个乐器|换一种乐器|换种乐器|换个音色|another instrument|different instrument/.test(
      lower,
    )
  )
    intent.otherLead = true;

  if (intent.soloLead && /piano/.test(intent.leads[0] ?? "")) {
    intent.lexical.focus += 1.9;
    intent.lexical.romantic += 1.3;
    intent.lexical.cinematic += 1.2;
  }
  // a solo says something about every other track, sleep music about the drums
  if (intent.soloLead) for (const track of TRACKS) intent.tracks.add(track);
  if (intent.noDrums) intent.tracks.add("drums");
  for (const dim of AMOUNTS)
    intent.delta[dim] = clamp(up[dim] + down[dim], -0.45, 0.45);
  intent.delta.tempo = clamp(up.tempo + down.tempo, -30, 30);
  intent.length.step = longer + shorter;
  intent.valence = clamp(intent.valence, -1, 1);
  intent.arousal = clamp(intent.arousal, -1, 1);
  intent.feeling = clamp(intent.feeling, -1, 1);
  namedWorks(analysis, words).forEach(note);
  return intent;
}

/**
 * A named song, singer or band cannot be copied, and a style the lexicon has
 * never heard of cannot be guessed: say so instead of pretending.
 */
function namedWorks(analysis: Analysis, words: Word[]): string[] {
  const out: string[] = [];
  const { text, lower } = analysis;
  const work = /《([^》]{1,30})》/.exec(text);
  if (work)
    out.push(
      `不能复刻现成的作品《${work[1]}》，会按描述的情绪和乐器写一段原创的`,
    );
  const covered = (position: number) =>
    analysis.tokens.some(
      (token) => token.start <= position && position < token.end,
    );
  let name = "";
  for (const word of words) {
    if (!/^(?:风格|曲风|style)$/.test(word.text)) continue;
    let start = word.start;
    if (lower[start - 1] === "的") start--;
    let from = start;
    while (
      from > 0 &&
      /[一-鿿]/.test(lower[from - 1]) &&
      !covered(from - 1) &&
      start - from < 6
    )
      from--;
    const run = text.slice(from, start);
    if (
      [...run].length >= 2 &&
      !/^(?:什么|哪种|哪个|一种|这个|那个|同样|原来|现在|之前|刚才|整体|音乐|曲子)$/.test(
        run,
      ) &&
      !/[的了是和与]$/.test(run)
    )
      name = run;
  }
  const latin =
    /(?:\blike|\bstyle of|\bby)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/.exec(
      text,
    ) ?? /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)(?:'s|\s+style|\s+type)/.exec(text);
  if (!name && latin) name = latin[1];
  if (name)
    out.push(
      `没认出「${name}」是哪种风格（也不能模仿具体的歌手或作品），已按其余的描述处理`,
    );
  return out;
}

/** What a request talks about, as far as the lexicon can tell. */
export interface Mentions {
  /** tracks whose loudness or presence the text speaks about */
  tracks: Set<TrackName>;
  tempo: boolean;
  energy: boolean;
  complexity: boolean;
  reverb: boolean;
  /** the tempo and the length the text names as totals, as written (not clamped) */
  bpm?: number;
  duration?: number;
}

/** Whole-mix words: with no track named beside them they concern every fader. */
const MIX_WORDS =
  /音量|响度|混音|推子|volume|loudness|\bmix(?:ing)?\b|\bbalance\b/i;

/**
 * Which faders and which continuous parameters the text mentions. This is
 * deliberately generous (naming a track is enough): it decides whether a
 * language model was asked to move a value, not how far.
 */
export function readMentions(text: string, mode: "new" | "refine"): Mentions {
  const said = (typeof text === "string" ? text : "")
    .trim()
    .slice(0, LIMITS.promptChars);
  const intent = interpret(said, mode);
  const about = (dim: Dim) =>
    intent.words.some(({ lex }) => lex.dim === dim || lex.target === dim);
  return {
    tracks: new Set(
      intent.tracks.size === 0 && MIX_WORDS.test(said) ? TRACKS : intent.tracks,
    ),
    tempo: about("tempo") || intent.analysis.bpm !== undefined,
    // mood words move the energy of a piece as well ("更温柔一点")
    energy:
      about("energy") ||
      intent.words.some(({ lex }) => lex.cat === "emotion" && !!lex.a),
    complexity: about("complexity"),
    reverb: about("reverb"),
    ...(intent.tempo.set !== undefined ? { bpm: intent.tempo.set } : {}),
    ...(intent.length.set !== undefined ? { duration: intent.length.set } : {}),
  };
}

/** The title a refinement keeps: the work's own, as stored (at most 80 characters). */
export function keptTitle(request: AgentRequest): string {
  return typeof request.title === "string"
    ? request.title
        .replace(/[\u0000-\u001f\u007f]+/g, " ")
        .trim()
        .slice(0, 80)
    : "";
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

function chooseStyle(intent: Intent, scores = intent.lexical): Choice {
  const hasMood = Math.abs(intent.valence) + Math.abs(intent.arousal) >= 0.4;
  const affinity = (id: StyleId) =>
    hasMood
      ? 0.6 *
        (intent.valence * STYLE_COORDS[id][0] +
          intent.arousal * STYLE_COORDS[id][1])
      : 0;
  const total = (id: StyleId) => scores[id] + affinity(id);
  const rank = (ids: StyleId[], score: (id: StyleId) => number) =>
    [...ids].sort(
      (a, b) =>
        score(b) - score(a) ||
        scores[b] - scores[a] ||
        STYLE_IDS.indexOf(a) - STYLE_IDS.indexOf(b),
    );
  const candidates = rank(
    STYLE_IDS.filter((id) => scores[id] >= WEAK),
    total,
  );
  if (candidates.length) {
    const [best, second] = candidates;
    return {
      best,
      tied: second && total(best) - total(second) < 0.25 ? second : undefined,
    };
  }
  if (!hasMood || scores !== intent.lexical) return {};
  const open = NEUTRAL.filter((id) => intent.lexical[id] > -0.5);
  return {
    neutral: rank(
      open.length ? open : NEUTRAL,
      (id) => affinity(id) + 0.3 * intent.lexical[id],
    )[0],
  };
}

/**
 * The catalogue's own blurb of a style ("摇滚能量：失真吉他强力和弦…") is that
 * style, exactly as its preset has it — the words describe the preset, they
 * are not instructions on top of it.
 */
export function catalogBlurb(text: string): StyleId | undefined {
  const tidy = (value: string) => value.replace(/[\s。.：:，,]+/g, "");
  const said = tidy(text);
  if (said.length < 8) return undefined;
  return STYLES.find(
    (style) =>
      said === tidy(style.description) ||
      said === tidy(style.label + style.description),
  )?.id;
}

/** A message that is nothing but a style's name as the interface shows it ("爵士小馆", "摇滚能量风格"). */
function catalogLabel(text: string): StyleId | undefined {
  const tidy = (value: string) =>
    value.replace(/[\s「」“”"'。.，,！!]+/g, "").toLowerCase();
  const said = tidy(text).replace(/的?(?:风格|曲风)$/, "");
  if (!said) return undefined;
  return STYLES.find(
    (style) => said === tidy(style.label) || said === tidy(style.english),
  )?.id;
}

/* ---------- applying the request ---------- */

const LOW = { energy: 0.4, complexity: 0.3, reverb: 0.15 };
const HIGH = { energy: 0.72, complexity: 0.7, reverb: 0.6 };
const round3 = (value: number) => Math.round(value * 1000) / 1000;
const round2 = (value: number) => Math.round(value * 100) / 100;
const percent = (value: number) => `${Math.round(value * 100)}%`;
const REGISTERS = ["low", "mid", "high"] as const;

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
 * `notes` receives what could not be done, or was already so.
 */
function applyParameters(
  config: MusicConfig,
  intent: Intent,
  mode: Mode,
  fresh: boolean,
  notes: string[],
) {
  const { analysis } = intent;
  const refine = mode === "refine";
  const [slow, fast] = styleInfo(config.mood).bpmRange;
  const at = (pos: number) => Math.round(slow + (fast - slow) * pos);
  const [bpmLow, bpmHigh] = LIMITS.bpm;
  const [lengthLow, lengthHigh] = LIMITS.duration;

  /* tempo */
  const tempo = intent.tempo;
  const bpmBefore = config.bpm;
  const tempoAsked =
    tempo.set !== undefined ||
    tempo.by !== undefined ||
    tempo.factor !== undefined ||
    tempo.pos !== undefined ||
    intent.delta.tempo !== 0;
  if (tempo.set !== undefined && tempo.set < 30)
    notes.push(
      `速度范围是 ${bpmLow}–${bpmHigh} BPM，没有按 ${tempo.set} BPM 修改`,
    );
  else if (tempo.set !== undefined) {
    config.bpm = clamp(Math.round(tempo.set), bpmLow, bpmHigh);
    if (config.bpm !== Math.round(tempo.set))
      notes.push(`速度范围是 ${bpmLow}–${bpmHigh} BPM，已取 ${config.bpm}`);
    else if (refine && config.bpm === bpmBefore && !fresh)
      notes.push(`速度已经是 ${config.bpm} BPM`);
  } else {
    if (intent.restored.has("tempo")) config.bpm = styleInfo(config.mood).bpm;
    if (tempo.pos !== undefined) config.bpm = at(tempo.pos);
    else if (fresh && tempo.own) config.bpm = tempo.own;
    else if (fresh && intent.scenePos !== undefined && config.bpm < 140)
      config.bpm = Math.min(
        config.bpm + 24,
        Math.max(config.bpm, at(intent.scenePos)),
      );
    const wanted =
      Math.round(config.bpm * (tempo.factor ?? 1)) +
      Math.round(tempo.by ?? 0) +
      Math.round(intent.delta.tempo);
    config.bpm = clamp(wanted, bpmLow, bpmHigh);
    if (tempoAsked && config.bpm !== wanted) {
      if (refine && config.bpm === bpmBefore)
        notes.push(
          config.bpm === bpmHigh
            ? `速度已经是最快的 ${bpmHigh} BPM`
            : `速度已经是最慢的 ${bpmLow} BPM`,
        );
      else
        notes.push(`速度范围是 ${bpmLow}–${bpmHigh} BPM，已取 ${config.bpm}`);
    }
  }

  /* length */
  const length = intent.length;
  const lengthBefore = config.duration;
  if (length.set !== undefined) {
    const wanted = Math.round(length.set);
    config.duration = clamp(wanted, lengthLow, lengthHigh);
    if (config.duration !== wanted)
      notes.push(
        `时长范围是 ${lengthLow}–${lengthHigh} 秒，已取 ${config.duration} 秒`,
      );
    else if (refine && config.duration === lengthBefore)
      notes.push(`时长已经是 ${lengthBefore} 秒`);
  } else if (length.by !== undefined || length.factor !== undefined) {
    const wanted = Math.round(
      config.duration * (length.factor ?? 1) + (length.by ?? 0),
    );
    config.duration = clamp(wanted, lengthLow, lengthHigh);
    if (config.duration !== wanted)
      notes.push(
        config.duration === lengthBefore
          ? wanted > lengthHigh
            ? `已经是最长的 ${lengthHigh} 秒`
            : `已经是最短的 ${lengthLow} 秒`
          : `时长范围是 ${lengthLow}–${lengthHigh} 秒，已取 ${config.duration} 秒`,
      );
  } else if (length.step) {
    const longer = length.step > 0;
    const next = longer
      ? DURATION_STEPS.find((step) => step > config.duration)
      : [...DURATION_STEPS].reverse().find((step) => step < config.duration);
    if (next) config.duration = next;
    else
      notes.push(
        longer
          ? `已经是最长的 ${lengthHigh} 秒`
          : `已经是最短的 ${lengthLow} 秒`,
      );
  } else if (fresh && mode === "new" && intent.short) config.duration = 15;
  if (length.cap !== undefined && config.duration > length.cap)
    config.duration = clamp(Math.round(length.cap), lengthLow, lengthHigh);
  if (length.floor !== undefined && config.duration < length.floor)
    config.duration = clamp(Math.round(length.floor), lengthLow, lengthHigh);

  /* key */
  const keyBefore = config.key;
  const minor = () => parseKey(config.key).minor;
  if (analysis.key) config.key = analysis.key;
  else if (intent.relative) {
    // the key that shares the notes: C major ↔ A minor
    if (minor() !== (intent.relative === "minor"))
      config.key = keyName(
        parseKey(config.key).tonic + (intent.relative === "minor" ? -3 : 3),
        intent.relative,
      );
  } else if (intent.modeExplicit)
    config.key = withMode(config.key, intent.modeExplicit);
  else if (intent.modeVotes.size === 1)
    config.key = withMode(config.key, [...intent.modeVotes][0]);
  else if (
    refine &&
    !intent.modeVotes.size &&
    intent.modeAway.has("minor") &&
    !intent.modeAway.has("major") &&
    minor()
  )
    config.key = withMode(config.key, "major");
  if (intent.shift)
    config.key = keyName(
      parseKey(config.key).tonic + intent.shift,
      minor() ? "minor" : "major",
    );
  if (refine && !fresh && config.key === keyBefore) {
    if (analysis.key || intent.modeExplicit || intent.relative)
      notes.push(`调性已经是 ${keyLabel(keyBefore)}`);
    else if (intent.askKey)
      notes.push(
        "想换成哪个调？可以说「改成 G 大调」「转成小调」或「升一个调」",
      );
  }

  /* the three sliders */
  for (const dim of AMOUNTS) {
    const before = config[dim];
    let value = before;
    const band = intent.band[dim];
    const extra = band?.very ? 0.12 : 0;
    if (band?.dir === -1) value = Math.min(value, LOW[dim] - extra);
    if (band?.dir === 1) value = Math.max(value, HIGH[dim] + extra);
    value += intent.delta[dim] + (intent.amountBy[dim] ?? 0);
    if (dim === "energy" && refine && !fresh) value += 0.16 * intent.feeling;
    if (mode === "new" && dim !== "reverb")
      value = Math.max(value, Math.min(config[dim], 0.12));
    const set = intent.restored.has(dim)
      ? styleInfo(config.mood)[dim]
      : intent.amountSet[dim];
    if (set !== undefined) value = set;
    config[dim] = round3(clamp(value, 0, 1));
    const moved = intent.delta[dim] + (intent.amountBy[dim] ?? 0);
    if (refine && !fresh && config[dim] === before) {
      if (set !== undefined)
        notes.push(`${AMOUNT_LABELS[dim]}已经是 ${percent(before)}`);
      else if (moved > 0 && before >= 1)
        notes.push(`${AMOUNT_LABELS[dim]}已经是最高的 100%`);
      else if (moved < 0 && before <= 0)
        notes.push(`${AMOUNT_LABELS[dim]}已经是最低的 0%`);
    }
  }

  /* lead */
  const leadBefore = config.instrument;
  if (intent.leads.length) config.instrument = intent.leads[0];
  if (
    intent.excluded.has(config.instrument) ||
    (intent.otherLead && !intent.leads.length)
  ) {
    const avoid = new Set([...intent.excluded, leadBefore]);
    const replacement =
      STYLE_LEADS[config.mood].find((id) => !avoid.has(id)) ??
      STYLE_LEADS[config.mood].find((id) => !intent.excluded.has(id));
    if (replacement) config.instrument = replacement;
  } else if (refine && intent.excluded.size && !intent.leads.length)
    notes.push(
      `当前主奏乐器是${instrumentLabel(config.instrument)}，本来就没有用${[...intent.excluded].map(instrumentLabel).join("、")}`,
    );
  if (
    refine &&
    !fresh &&
    intent.leads.length &&
    !intent.soloLead &&
    config.instrument === leadBefore
  )
    notes.push(`主奏乐器已经是${instrumentLabel(leadBefore)}`);

  /* mixer tracks */
  const volumesBefore = { ...config.volumes };
  if (intent.reset) {
    config.volumes = { ...DEFAULT_VOLUMES };
    if (intent.reset === "all") delete config.arrangement;
  }
  if (intent.restoreMuted)
    for (const track of TRACKS)
      if (config.volumes[track] === 0)
        config.volumes[track] = DEFAULT_VOLUMES[track];
  const resetAsked = !!intent.reset || intent.restoreMuted;
  const idle = new Map<TrackName, string>();
  for (const entry of intent.trackAsks) {
    const { track } = entry;
    const base = DEFAULT_VOLUMES[track];
    const current = config.volumes[track];
    const label = TRACK_LABELS[track];
    let next = current;
    if (entry.kind === "mute") next = 0;
    else if (entry.kind === "only") {
      for (const other of TRACKS)
        if (!(entry.group ?? [track]).includes(other))
          config.volumes[other] = 0;
      if (current === 0) next = base;
    } else if (entry.kind === "set") next = entry.value ?? current;
    else if (entry.kind === "restore" || entry.kind === "keep")
      next = current === 0 ? base : current;
    else if (entry.kind === "add")
      next = current === 0 ? base : current + (entry.value ?? 0.15);
    else if (entry.kind === "scale") next = current * (entry.value ?? 1);
    else next = current + (entry.value ?? 0);
    next = round2(clamp(next, 0, 1));
    config.volumes[track] = next;
    if (!refine || next !== current || entry.kind === "only") continue;
    const state =
      entry.kind === "mute"
        ? `${label}已经是关闭的`
        : entry.kind === "keep"
          ? `${label}会保留`
          : entry.kind === "restore"
            ? `${label}本来就是打开的`
            : entry.kind === "set"
              ? `${label}音量已经是 ${percent(current)}`
              : current >= 1
                ? `${label}音量已经是最大的 100%`
                : current <= 0
                  ? `${label}已经是关闭的`
                  : undefined;
    if (state && !idle.has(track)) idle.set(track, state);
  }
  if (!intent.touchedDrums && (intent.soloLead || (fresh && intent.noDrums)))
    config.volumes.drums = 0;
  // "already so" is only said of a fader that ends where it started
  for (const [track, state] of idle)
    if (
      config.volumes[track] === volumesBefore[track] &&
      !notes.includes(state)
    )
      notes.push(state);
  if (
    refine &&
    resetAsked &&
    TRACKS.every((track) => config.volumes[track] === volumesBefore[track]) &&
    (intent.reset !== "all" || !config.arrangement)
  )
    notes.push(
      intent.restoreMuted && !intent.reset
        ? "没有被关闭的声部"
        : "各声部的音量已经是默认值",
    );

  /* structure */
  const loopBefore = config.loop;
  if (intent.loop !== undefined) config.loop = intent.loop;
  else if (fresh && intent.impliedLoop !== undefined)
    config.loop = intent.impliedLoop;
  else if (fresh && mode === "new" && intent.short) config.loop = false;
  if (refine && intent.loop !== undefined && config.loop === loopBefore)
    notes.push(loopBefore ? "已经是循环片段" : "已经是完整结尾");

  /* arrangement */
  const hints: ArrangementHints = config.arrangement
    ? (JSON.parse(JSON.stringify(config.arrangement)) as ArrangementHints)
    : {};
  const hintsBefore = JSON.stringify(hints);
  for (const edit of intent.arrangement) edit(hints);
  if (intent.padFromStrings) hints.layers = { ...hints.layers, pad: true };
  if (intent.register) {
    const now = REGISTERS.indexOf(hints.melody?.register ?? "mid");
    const next = clamp(now + Math.sign(intent.register), 0, 2);
    if (next !== now)
      hints.melody = { ...hints.melody, register: REGISTERS[next] };
    else if (refine)
      notes.push(next === 2 ? "旋律已经在最高的音区" : "旋律已经在最低的音区");
  }
  if (intent.density) {
    const now = hints.melody?.density ?? 0.5;
    hints.melody = {
      ...hints.melody,
      density: round2(clamp(now + 0.2 * Math.sign(intent.density), 0, 1)),
    };
  }
  if (intent.touchedDrums && config.volumes.drums > 0 && hints.drums === "none")
    delete hints.drums;
  if (
    refine &&
    (intent.arrangement.length || intent.padFromStrings) &&
    JSON.stringify(hints) === hintsBefore
  )
    notes.push("编曲上已经是这样了");
  config.arrangement = hints;
}

/* ---------- words for the user ---------- */

const quote = (text: string) =>
  [...text].length > 18 ? `${[...text].slice(0, 18).join("")}…` : text;

/**
 * Use the user's own words as the title when they are a short, clean name:
 * a noun phrase, not a sentence ("我是做游戏的"), not a wish or its opposite
 * ("不是悲伤的那种"), not a parameter and not somebody else's name.
 */
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
  if (
    /^(?:我|你|他|她|它|咱|这|那|是|不|没|别|想|要|主要|除了|讨厌|拒绝|帮|给|请|有点|太|更|再|很|非常|先|越)/.test(
      phrase,
    ) ||
    /但是|不过|而是|还是|或者|然后/.test(phrase) ||
    /(?:的|了|用|吧|呢|吗|啊|呀|嘛)$/.test(phrase) ||
    /风格|曲风|类似|[《》“”"'：:+]|\bstyle\b|\blike\b/i.test(phrase)
  )
    return undefined;
  const { analysis, words } = read(phrase, "new");
  if (analysis.key) return undefined;
  const instruction = words.some(
    ({ lex }) =>
      lex.neg ||
      lex.op ||
      lex.target ||
      lex.change ||
      lex.seed ||
      lex.qty ||
      lex.shift ||
      lex.like ||
      lex.ctx ||
      lex.want ||
      lex.other ||
      lex.dislike ||
      lex.keep ||
      lex.that ||
      lex.reset ||
      lex.unsupported ||
      (lex.loop !== undefined && !lex.w) ||
      lex.mod === "too" ||
      lex.mod === "more" ||
      lex.mod === "slight" ||
      lex.mod === "lot",
  );
  if (instruction || !words.some(({ lex }) => lex.w || lex.inst))
    return undefined;
  // "做饭视频的轻松(音乐)": an adjective left dangling is not a title
  const lastWord = words[words.length - 1]?.lex;
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
/** "没有刚才那版好听", "不如上一版": a comparison that comes out against this version. */
const DISPLEASED =
  /没有?.{0,8}(?:好听|好)|不如.{0,10}|不好听|难听|不喜欢|不满意|not as good|worse/i;
const EXAMPLES =
  "「鼓轻一点」「换成古筝」「慢一点」「改成爵士风格」「换个旋律」";

/**
 * Plan one request without any network access. "new" starts from the best
 * matching style; "refine" changes only what the message asks for.
 */
export function planWithRules(request: AgentRequest): AgentPlan {
  const said = (typeof request.text === "string" ? request.text : "")
    .trim()
    .slice(0, LIMITS.promptChars);
  const mode: Mode = request.mode === "refine" ? "refine" : "new";
  const current = clampConfig(request.current ?? {});
  const chosen = readPins(request);
  // a style card's own blurb is the style itself, not a list of instructions
  const blurb = mode === "new" ? catalogBlurb(said) : undefined;
  const pins =
    blurb && (!chosen.mood || chosen.mood === blurb)
      ? { ...chosen, mood: blurb }
      : chosen;
  const text = blurb && pins.mood === blurb ? "" : said;
  const intent = interpret(text, mode);
  // a pinned style replaces style detection; the text still sets the parameters
  const choice: Choice = pins.mood ? {} : chooseStyle(intent);
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
    if (pins.mood) adopt(pins.mood);
    else if (!text) styleNotes.push("没有收到描述，按当前参数制作");
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
        `没有从「${quote(text)}」里听出风格，先按「${styleLabel(current.mood)}」来做`,
      );
    }
    // "欢快，带一点点忧伤": the hedged style is a colour on top of the chosen one
    for (const [id, word] of intent.hedged)
      if (fresh && id !== config.mood && intent.lexical[config.mood] >= WEAK) {
        styleNotes.push(
          `以「${styleLabel(config.mood)}」为主，「${word}」只作点缀`,
        );
        break;
      }
  } else if (pins.mood) {
    if (pins.mood !== current.mood) {
      config = { ...config, ...stylePreset(pins.mood) };
      delete config.arrangement;
      fresh = true;
    }
  } else {
    const wanted = chooseStyle(intent, intent.restyle);
    // the name on a style chip, typed as the whole message, is that style
    const named = catalogLabel(text);
    if (named) wanted.tied = undefined;
    const best = named ?? wanted.best;
    if (best && best === current.mood)
      styleNotes.push(`已经是「${styleLabel(best)}」风格`);
    else if (best && wanted.tied && wanted.tied !== current.mood)
      styleNotes.push(
        `「${styleLabel(best)}」和「${styleLabel(wanted.tied)}」都沾边，先保持当前的「${styleLabel(current.mood)}」，请再说明确一点`,
      );
    else if (best) {
      config = { ...config, ...stylePreset(best) };
      delete config.arrangement;
      fresh = true;
    } else {
      // "加点爵士味": borrow the style's colour without replacing the piece
      for (const [id] of intent.towards) {
        if (id === current.mood) continue;
        config.instrument = stylePreset(id).instrument;
        const trait = TRAITS[id];
        if (trait?.swing)
          intent.arrangement.unshift((hints) => {
            hints.swing = hints.swing ?? 0.5;
          });
        if (trait?.drums) {
          const feel = trait.drums;
          intent.arrangement.unshift((hints) => {
            hints.drums = hints.drums ?? feel;
          });
        }
        styleNotes.push(
          `保持「${styleLabel(current.mood)}」的底子，借用「${styleLabel(id)}」的主奏乐器`,
        );
        break;
      }
      // "少点爵士味", "太像恐怖片了": step away from what makes that style
      for (const [id, word] of intent.away) {
        if (intent.towards.has(id)) continue;
        const trait = TRAITS[id] ?? {};
        const label = styleLabel(id);
        let moved = false;
        for (const dim of [
          "energy",
          "complexity",
          "reverb",
          "tempo",
        ] as const) {
          const way = trait[dim];
          if (!way) continue;
          const step = (-way * STEP[dim]) / 2;
          if (dim === "tempo") intent.tempo.by = (intent.tempo.by ?? 0) + step;
          else intent.amountBy[dim] = (intent.amountBy[dim] ?? 0) + step;
          moved = true;
        }
        const swung =
          (current.arrangement?.swing ??
            (current.mood === id && trait.swing ? 0.5 : 0)) > 0;
        if (trait.swing && swung) {
          intent.arrangement.push((hints) => {
            hints.swing = 0;
          });
          moved = true;
        }
        if (trait.drums && current.arrangement?.drums === trait.drums) {
          intent.arrangement.push((hints) => {
            delete hints.drums;
          });
          moved = true;
        }
        if (parseKey(styleInfo(id).key).minor && !intent.modeVotes.size)
          intent.modeAway.add("minor");
        // a lead borrowed from that style goes back to the piece's own
        const own = stylePreset(current.mood).instrument;
        if (
          id !== current.mood &&
          !intent.leads.length &&
          current.instrument !== own &&
          STYLE_LEADS[id].slice(0, 2).includes(current.instrument) &&
          !STYLE_LEADS[current.mood].includes(current.instrument)
        ) {
          intent.leads.push(own);
          moved = true;
        }
        const brighter =
          parseKey(styleInfo(id).key).minor &&
          parseKey(current.key).minor &&
          !intent.analysis.key &&
          !intent.modeExplicit &&
          !intent.relative &&
          !intent.modeVotes.size;
        if (moved || brighter)
          styleNotes.push(
            id === current.mood
              ? `还是「${label}」风格，把它的特征收了一些；想换风格可以说「改成…风格」`
              : `保持「${styleLabel(current.mood)}」风格，减少「${word}」的味道`,
          );
        else
          styleNotes.push(
            id === current.mood
              ? `这首本身就是「${label}」风格；想换风格可以说「改成…风格」`
              : `这首是「${styleLabel(current.mood)}」风格，没有找到可以单独去掉的「${word}」元素`,
          );
        break;
      }
    }
  }

  if (
    mode === "refine" &&
    intent.restyleWanted &&
    !fresh &&
    !styleNotes.length &&
    !pins.mood
  )
    styleNotes.push("想换成什么风格？可以说「改成爵士风格」或「换成国风」");
  const baseline = copyConfig(config);
  if (fresh && !intent.leads.length && !pins.instrument)
    for (const [id, lead] of SIGNATURE_LEADS)
      if (
        id !== config.mood &&
        intent.lexical[id] >= 3 &&
        (mode === "new" || intent.restyle[id] > 0)
      ) {
        config.instrument = lead;
        styleNotes.push(
          `保留「${styleLabel(id)}」的色彩：主奏乐器用${instrumentLabel(lead)}`,
        );
        break;
      }
  applyParameters(config, intent, mode, fresh, notes);
  // a new piece is described by its own words; a piece made from a style chip alone has none
  config.prompt = mode === "new" && (said || pins.mood) ? said : current.prompt;
  // pinned values win over whatever the text said about the same parameter
  config = clampConfig(
    withPins({ ...config, seed: current.seed }, pins),
    current,
  );
  // another go ("再来一个") is a new melody only when nothing else was asked for
  const otherwise = describeChanges(current, config);
  const reseed =
    mode === "new" ||
    intent.seed === "melody" ||
    (intent.seed === "again" && otherwise.length === 0);
  if (reseed) {
    const next = clampConfig({ seed: request.nextSeed }, current).seed;
    // a new melody must be another melody, whatever seed the caller happened to offer
    config.seed =
      mode === "refine" && next === current.seed ? (next + 1) >>> 0 : next;
  }

  // a sound the chosen style already has is not missing ("铜管" in 史诗燃向)
  const blurbOf = styleInfo(config.mood).description;
  const sounds = intent.words.filter(
    (word) =>
      !!word.lex.unsupported && !word.neg && blurbOf.includes(word.text),
  );
  for (const marker of intent.notes) {
    if (sounds.some((word) => word.lex.unsupported === marker)) continue;
    const message =
      marker === SECTION_NOTE || marker === TIME_NOTE
        ? scopeNote(marker, mode === "new" || otherwise.length > 0)
        : marker;
    // nothing is "修改" in a description of a new piece
    if (mode === "new" && marker === SECTION_NOTE) continue;
    if (!notes.includes(message)) notes.push(message);
  }
  // "适合咖啡馆": heard as what the music is for, not as an instruction — say so
  if (
    mode === "refine" &&
    !reseed &&
    !otherwise.length &&
    !notes.length &&
    !styleNotes.length &&
    !pins.mood
  )
    for (const [id, word] of intent.contexts) {
      styleNotes.push(
        id === current.mood
          ? `这首已经是适合「${word}」的「${styleLabel(id)}」风格`
          : `听到了「${word}」，这次没有把它当成换风格的要求；想换可以说「改成${styleLabel(id)}风格」`,
      );
      break;
    }
  const displeased = intent.dislike || DISPLEASED.test(said);
  if (
    mode === "refine" &&
    displeased &&
    !reseed &&
    !otherwise.length &&
    !notes.length
  )
    notes.push(
      "抱歉这一版没让你满意。告诉我哪里不对会更好改，比如「太快了」「鼓太吵」「换成钢琴」，或者说「换个旋律」重写一版",
    );

  const before =
    mode === "new"
      ? { ...clampConfig(baseline, current), seed: config.seed }
      : current;
  const changes = describeChanges(before, config);
  const unchanged = mode === "refine" && changes.length === 0;
  // the reasoning names the pins once, not again as changes
  const pinNotes = describePins(chosen);
  const told =
    mode === "new"
      ? describeChoices(
          pinNotes.length ? withPins(before, chosen) : before,
          config,
        )
      : pinNotes.length
        ? describeChanges(withPins(before, chosen), config)
        : changes;

  const title =
    mode === "new"
      ? pickTitle(text, config.mood, config.seed)
      : keptTitle(request) ||
        (config.mood === current.mood
          ? pickTitle(current.prompt, current.mood, current.seed)
          : pickTitle("", config.mood, current.seed));

  // an engine-1 work is re-made by the new engine: nothing of its tune carries over
  const heard: MusicConfig =
    (request.current as MusicConfig | null)?.engine === 1
      ? { ...current, engine: 1 }
      : current;
  const label = styleLabel(config.mood);
  const summary = `${config.bpm} BPM、${keyLabel(config.key)}、${instrumentLabel(config.instrument)}主奏`;
  const understood = styleNotes.length > 0 || notes.length > 0;
  let reply: string;
  if (mode === "new")
    reply =
      `好的，做一段「${label}」风格的音乐：${summary}，${config.duration} 秒，${config.loop ? "循环片段" : "完整结尾"}。` +
      (guessed && text
        ? "这次没听出明确的风格，可以再告诉我场景、情绪或想要的乐器。"
        : notes.length
          ? `${notes[0]}。`
          : "");
  else if (unchanged)
    reply = understood
      ? `${styleNotes[0] ?? notes[0]}。作品保持不变。`
      : (PRAISE.test(text)
          ? "很高兴你喜欢，"
          : "这句话里我没有听出要调整什么，") +
        `作品保持不变。${PRAISE.test(text) ? "想再调整" : ""}可以试试：${EXAMPLES}。`;
  else
    reply =
      `好的：${changes.slice(0, 3).join("，")}${changes.length > 3 ? " 等" : ""}。` +
      melodyNote(heard, config, request.provider) +
      (notes.length ? `${notes[0]}。` : "");

  const reasoning = [
    ...pinNotes,
    ...styleNotes,
    ...told.slice(0, 8),
    ...notes,
    ...(unchanged && !understood
      ? [`没有从「${quote(text)}」里识别到可执行的调整`]
      : []),
  ];
  const tags = [
    label,
    `${config.bpm} BPM`,
    instrumentLabel(config.instrument),
    ...intent.tags,
    ...(config.volumes.drums === 0 ? ["无鼓"] : []),
    ...(TRACKS.every(
      (track) => track === "melody" || config.volumes[track] === 0,
    )
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
      ? {
          cloudPrompt: buildCloudPrompt(
            config,
            mode === "refine" ? current : undefined,
          ),
        }
      : {}),
  };
}
