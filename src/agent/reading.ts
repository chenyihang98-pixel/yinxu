/**
 * Reading one request: the words of the lexicon, clause by clause, with what
 * stands around each of them resolved — negation (and double negation),
 * "太 / 更 / 一点" modifiers, complaints, change verbs, resemblance and
 * context. Pure; rules.ts turns this reading into instructions.
 */
import {
  analyse,
  gapBetween,
  type Analysis,
  type Lex,
  type Token,
} from "./lexicon";

export type Mode = "new" | "refine";

export interface Word extends Token {
  /** index of the clause (text between sentence punctuation) the word is in */
  clause: number;
  neg?: "hard" | "too";
  /** inside a double negation ("别把鼓去掉", "不要去掉鼓"): keep it */
  kept?: boolean;
  /** "太…" in front, or inside "不要太…" */
  too?: boolean;
  /** has "一点 / 更 / 再 / 稍微 / 很多" attached: a relative request */
  compared?: boolean;
  very?: boolean;
  scale: number;
  /** follows a change verb ("换成 X") */
  changed?: boolean;
  /** followed by "风格 / 感觉 / 味" */
  suffixed?: boolean;
  /** followed by "风格 / 曲风 / style": named as a style */
  styled?: boolean;
  flavour?: boolean;
  added?: boolean;
  /** "把 X 换成 Y": X is what gets replaced */
  replaced?: boolean;
  /** an instrument word that only carried a volume request ("钢琴太响了") */
  leveled?: boolean;
  solo?: boolean;
  /** what it is compared with ("像 X", "太像 X 了") */
  liked?: boolean;
  /** "少点 X" */
  less?: boolean;
  /** already consumed by another word's instruction */
  used?: boolean;
}

export interface Clause {
  start: number;
  end: number;
  /** says what the music is for ("这是给…配的") */
  ctx: boolean;
  want: boolean;
  /** names a part of the piece ("副歌", "第 20 秒"): edits in it are per-section */
  scoped: boolean;
  /** nothing but a description: style words, instruments, filler */
  bare: boolean;
}

export interface Reading {
  analysis: Analysis;
  words: Word[];
  clauses: Clause[];
}

/** Sentence punctuation; a clause never spans it. */
export const CLAUSE_END = /[,.;!?。；！？\n]/;

export const isContent = (lex: Lex) =>
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
    lex.qty ||
    lex.shift ||
    lex.relative ||
    lex.pitch
  );

/**
 * Words that only describe. A clause of nothing else is a description ("快节奏
 * 的摇滚"); a comparative or a complaint in it makes it an instruction.
 */
const describes = (word: Word) =>
  !word.too &&
  !word.neg &&
  !word.less &&
  !word.kept &&
  !!(
    word.lex.w ||
    word.lex.inst ||
    word.lex.suffix ||
    word.lex.change ||
    word.lex.link ||
    word.lex.mod ||
    ((word.lex.dim || word.lex.mode) && !word.compared && !word.lex.fixed)
  );

export function read(text: string, mode: Mode): Reading {
  const analysis = analyse(text);
  const { lower } = analysis;

  const clauses: Clause[] = [];
  let from = 0;
  for (let i = 0; i <= lower.length; i++)
    if (i === lower.length || CLAUSE_END.test(lower[i])) {
      clauses.push({
        start: from,
        end: i,
        ctx: false,
        want: false,
        scoped: false,
        bare: true,
      });
      from = i + 1;
    }
  const clauseAt = (position: number) => {
    const index = clauses.findIndex((clause) => position <= clause.end);
    return index < 0 ? clauses.length - 1 : index;
  };

  for (const token of analysis.tokens) {
    const clause = clauses[clauseAt(token.start)];
    if (token.lex.ctx) clause.ctx = true;
    if (token.lex.want) clause.want = true;
    if (token.lex.section) clause.scoped = true;
  }

  const words: Word[] = analysis.tokens
    .filter((token) => Object.keys(token.lex).length > 0)
    .map((token) => ({ ...token, scale: 1, clause: clauseAt(token.start) }));
  const near = (a: number, b: number, max: number) =>
    a >= 0 &&
    b < words.length &&
    gapBetween(lower, words[a].end, words[b].start, max) !== null;

  // modifiers: "太", "更", "一点", "很多" … also through "像" ("太像 X 了")
  words.forEach((word, i) => {
    if (!isContent(word.lex)) return;
    const mods: Lex["mod"][] = [];
    for (let k = i - 1; k >= 0 && near(k, k + 1, 0); k--) {
      const lex = words[k].lex;
      if (lex.like) word.liked = true;
      else if (lex.neg === "too") mods.push("too");
      else if (lex.mod) mods.push(lex.mod);
      else break;
    }
    for (let k = i + 1; k < words.length && near(k - 1, k, 0); k++) {
      if (!words[k].lex.mod) break;
      mods.push(words[k].lex.mod);
    }
    // "有点吵" is a complaint about the piece one is listening to
    const complaint =
      mods.includes("somewhat") &&
      mode === "refine" &&
      !!(
        word.lex.dim ||
        word.lex.op ||
        word.lex.length ||
        (word.lex.w && word.lex.cat)
      );
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

  /* ----- negation: what each cue refers to ----- */
  const isCue = (word: Word | undefined) =>
    !!word &&
    !word.lex.bare &&
    (word.lex.neg === "hard" || word.lex.op === "mute");
  const listFrom = (first: number, step: 1 | -1) => {
    const found = [first];
    let last = first;
    while (
      words[last + step]?.lex.link &&
      words[last + 2 * step] &&
      isContent(words[last + 2 * step].lex) &&
      near(Math.min(last, last + step), Math.max(last, last + step), 1) &&
      near(
        Math.min(last + step, last + 2 * step),
        Math.max(last + step, last + 2 * step),
        1,
      )
    ) {
      last += 2 * step;
      found.push(last);
    }
    return found;
  };
  /** The content words a cue refers to: what follows it, else what it closes. */
  const scope = (i: number): { targets: number[]; too: boolean } => {
    const cue = words[i];
    let too = false;
    for (let j = i + 1; j < words.length && near(j - 1, j, 2); j++) {
      const lex = words[j].lex;
      // "别是那种悲伤的调调": "那种" points forward when something follows it
      const pointsOn =
        !!words[j + 1] &&
        isContent(words[j + 1].lex) &&
        !words[j + 1].lex.neg &&
        near(j, j + 1, 1);
      if (lex.that && pointsOn) continue;
      if (lex.that) {
        // "不想要这种感觉": what the clause before (or this one) just described
        const targets = words
          .map((word, index) => ({ word, index }))
          .filter(
            ({ word, index }) =>
              index < i &&
              word.clause >= cue.clause - 1 &&
              !!word.lex.w &&
              !!word.lex.cat,
          )
          .map(({ index }) => index);
        return { targets, too };
      }
      if (lex.brk || lex.change || lex.neg || lex.keep) break;
      if (lex.mod || lex.like || lex.want || lex.ctx) {
        if (lex.mod === "too") too = true;
        continue;
      }
      if (!isContent(lex)) continue;
      if (
        cue.lex.bare &&
        (words[j].start !== cue.end ||
          !(lex.w || lex.dim || lex.mode || lex.length))
      )
        break;
      return { targets: listFrom(j, 1), too };
    }
    if (cue.lex.bare) return { targets: [], too };
    // "鼓不要了", "钢琴去掉": the cue closes its clause, so it refers backwards
    const rest = lower.slice(cue.end).split(CLAUSE_END)[0];
    const closes =
      gapBetween(rest, 0, rest.length, 1) !== null &&
      !(words[i + 1] && words[i + 1].start < cue.end + rest.length);
    if (!closes) return { targets: [], too };
    let k = i - 1;
    while (
      k >= 0 &&
      (words[k].lex.neg || words[k].lex.mod || words[k].lex.suffix) &&
      near(k, k + 1, 1)
    )
      k--;
    if (k >= 0 && near(k, k + 1, 1) && isContent(words[k].lex))
      return { targets: listFrom(k, -1), too };
    return { targets: [], too };
  };

  const consumed = new Set<number>();
  words.forEach((cue, i) => {
    if (!cue.lex.neg || consumed.has(i)) return;
    const inner = words[i + 1];
    if (
      cue.lex.neg === "hard" &&
      !cue.lex.bare &&
      isCue(inner) &&
      near(i, i + 1, 2)
    ) {
      // "不要去掉鼓", "不是不要鼓", "取消静音": the two cancel, the thing stays
      consumed.add(i + 1);
      inner.used = true;
      const { targets } = scope(i + 1);
      for (const target of targets) {
        delete words[target].neg;
        words[target].kept = true;
      }
      if (!targets.length) inner.kept = true;
      return;
    }
    const { targets, too } = scope(i);
    const kind = cue.lex.neg === "too" || too ? "too" : "hard";
    if (kind === "hard" && /^(?:没有|没)$/.test(cue.text) && targets.length) {
      // "没有摇滚的感觉了": it has gone missing, so more of it is wanted
      const last = words[targets[targets.length - 1]];
      const rest = lower.slice(last.end).split(CLAUSE_END)[0];
      if (/^\s*的?\s*(?:感觉|味道|味|感|风格|氛围)\s*了\s*$/.test(rest)) {
        for (const target of targets) words[target].compared = true;
        return;
      }
    }
    for (const target of targets) {
      const word = words[target];
      if (word.kept) continue;
      if (kind === "hard" && word.neg === "hard") {
        // "别把鼓去掉": negated from both sides
        delete word.neg;
        word.kept = true;
      } else word.neg = kind;
    }
  });
  // what stands directly around a word
  words.forEach((word, i) => {
    const hedge = (lex: Lex) =>
      !!lex.flavour && !(lex.mod === "somewhat" && mode === "refine");
    let before = i - 1;
    // "带点小忧伤": the "小" is part of the hedge
    while (
      before >= 0 &&
      (words[before].lex.mod ||
        words[before].lex.like ||
        words[before].text === "小") &&
      near(before, before + 1, 0)
    ) {
      if (hedge(words[before].lex)) word.flavour = true;
      before--;
    }
    const previous =
      before >= 0 && near(before, before + 1, 2) ? words[before] : undefined;
    const next = near(i, i + 1, 1) ? words[i + 1] : undefined;
    if (previous?.lex.change) word.changed = true;
    if (next?.lex.change) word.replaced = true;
    // "带点 X" hedges what follows, "X 元素" what comes before
    const trails = (text: string) =>
      /^(?:元素|色彩|flavor|flavour)$/.test(text);
    if (
      (previous && hedge(previous.lex) && !trails(previous.text)) ||
      (next?.lex.flavour && trails(next.text))
    )
      word.flavour = true;
    if (previous?.lex.op === "add" || previous?.lex.op === "unmute")
      word.added = true;
    if (
      previous?.lex.op === "down" &&
      previous.lex.side !== "post" &&
      word.lex.w &&
      word.lex.cat &&
      !word.lex.dim
    ) {
      word.less = true;
      previous.used = true;
    }
    if (next?.lex.suffix) {
      word.suffixed = true;
      if (/^(?:风格|曲风|style|genre)$/.test(next.text)) word.styled = true;
    }
    if (
      (previous?.lex.solo && near(before, before + 1, 0)) ||
      (next?.lex.solo && near(i, i + 1, 0))
    )
      word.solo = true;
  });

  for (const word of words)
    if (!describes(word)) clauses[word.clause].bare = false;
  return { analysis, words, clauses };
}
