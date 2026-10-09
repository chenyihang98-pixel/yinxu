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
import { hush, type Lock } from "./vetoes";

export type Mode = "new" | "refine";

export interface Word extends Token {
  /** index of the clause (text between sentence punctuation) the word is in */
  clause: number;
  neg?: "hard" | "too";
  /** inside a double negation ("别把鼓去掉", "不要去掉鼓"): keep it */
  kept?: boolean;
  /** "太…" in front, or inside "不要太…" */
  too?: boolean;
  /** "快了点", "鼓大了": said of the piece as it is — it came out too much so */
  perfect?: boolean;
  /** negated by "不是 / 除了": says what it is not, removes nothing */
  denied?: boolean;
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
  /** "not … enough": the negation in front asks for more, it does not negate */
  enough?: boolean;
  /** a number or a strong word that could not be read with confidence */
  unread?: boolean;
  /** a number a complaint is about ("鼓 80% 太大"): the words behind it speak of the part in front */
  skip?: boolean;
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
  /** bare, and no other word in it at all ("雨天咖啡馆", not "同事喜欢爵士") */
  pure: boolean;
  /** only remarks on an earlier version, or denies a statement */
  remark: boolean;
}

export interface Reading {
  analysis: Analysis;
  words: Word[];
  clauses: Clause[];
  /** refinements: what the message says must stay exactly as it is */
  locks: Set<Lock>;
  /** something was forbidden or kept without naming what */
  general: boolean;
  /**
   * The request with every number (\u0001) and every word that only names a
   * thing (\u0002) blanked out, for amounts.ts.
   */
  masked: string;
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

/** Words that say nothing by themselves: hedges, politeness, who said it. */
const HEDGES =
  /如果|的话|或许|也许|可能|好像|似乎|感觉|觉得|认为|是不是|能不能|可不可以|要不要|有没有|试试看?|看看|一下|就好了?|就行了?|就可以了?|就够了?|会更好|更好|比较好|好了|好吗|行吗|可以吗|怎么样|如何|麻烦|帮我|给我|帮忙|谢谢|所以|因为|那么|这个|这首|这段|这版|这次|现在|整体|整首|听起来|听着|听上去|起来|音乐|曲子|版本|时间|应该|需要|希望|还可以|可以|还是|而且|另外|同时|其实|真的|确实|实在|比较|已经|有点儿?|(?:客户|老板|领导|同事|朋友|甲方|导演|老师|他们|她们|我们|大家|有人)(?:也|都|还)?(?:说|觉得|认为|希望|想要?|要求|建议|提到|表示|嫌)?/g;
const SOFT =
  /[\s\u0001\u0002"'()（）《》「」·~…:：\-—、的地得了吧呢啊呀嘛哦哈啦么把让使给请要想来我你它这那就还也都再更又才只先是有好行能会吗个首段种点些很挺和与跟及]/g;
const SOFT_EN =
  /\b(?:the|a|an|to|it|its|is|be|of|please|bit|little|some|in|my|this|that|for|me|i|we|you|can|could|would|should|have|get|give|want|need|make|so|and|just|now|maybe|perhaps|think|feel|feels|sounds?|seems?|really|kind|kinda|are|was|were|if|possible|thanks?|them|by|at|on|with|but|then|also|still|more|way|too|very|all|there|here|let's|lets|try|how|about|what|do|does|will|been|im|i'm|it's|thats|that's|like|piece|track|music|song|version|one|enough|not|isn't|aren't|quite|sure|thing|things|as|than)\b/g;
/** In a clause that is nothing but a description, only articles and the word "music" are no words. */
const PLAIN_EN =
  /\b(?:the|a|an|please|some|of|and|with|for|in|music|track|piece|song|tune)\b/g;
/** What is left of a stretch of text once every known word and every filler is taken out. */
function leftover(text: string, generous: boolean): string {
  let rest = text;
  if (generous) rest = rest.replace(HEDGES, "");
  return rest
    .replace(generous ? SOFT_EN : PLAIN_EN, "")
    .replace(SOFT, "")
    .replace(/[,.;!?。；！？，\n]/g, "");
}

/** Adjectives of the lexicon as opposed to its verbs: "快", "大", "安静" but not "加快", "调大". */
const VERBAL =
  /^(?:加|减|放|提|降|缩|延|拉|增|调|收|压|升|换|改|变|去|关|开|推|抬|往|向|上|下|涨|掉|慢下来|speed|slow (?:it )?down|turn|bring|raise|lower|increase|decrease|reduce|extend|shorten|lengthen|boost)/;
/** "加快", "放慢", "less reverb": a word that is an instruction by itself. */
export const isVerbal = (text: string) =>
  VERBAL.test(text) || /^(?:less|more|更多|更少)\s?\S/.test(text);
const isAdjective = (token: Token) =>
  !VERBAL.test(token.text) &&
  !!(
    (token.lex.dim && token.lex.dir) ||
    token.lex.length ||
    token.lex.op === "up" ||
    token.lex.op === "down"
  );
/** "X 了(点)" at the end of what is said: the piece came out too X. */
const PERFECT =
  /^\s*了\s*(?:一?点儿?|一?些|一丢丢|一点点|好多|很多|不少)?\s*(?:吧|啊|呀|哦|呢|嘛)?\s*$/;
const COMPARATIVE_EN = /^(?:[a-z]+er|more [a-z]+)$/;

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
        pure: false,
        remark: false,
      });
      from = i + 1;
    }
  const clauseAt = (position: number) => {
    const index = clauses.findIndex((clause) => position <= clause.end);
    return index < 0 ? clauses.length - 1 : index;
  };

  // refinements: what is forbidden, kept, denied or only remarked on is no instruction
  // the words as written (numbers and keys included), lower-cased without moving a character
  const raw = [...analysis.text]
    .map((ch) =>
      ch.toLowerCase().length === ch.length ? ch.toLowerCase() : ch,
    )
    .join("");
  const quiet =
    mode === "refine" ? hush(raw, analysis.tokens, clauses) : undefined;
  for (const index of quiet?.remarks ?? []) clauses[index].remark = true;
  // "最后" after "先 … 然后 …" is "finally", not the end of the piece
  const sequenced =
    /(?:^|[,，。；;\s])(?:先|首先|第一步)|然后|接着|再把|再换|再加/.test(lower);

  analysis.tokens.forEach((token, index) => {
    if (quiet?.dropped.has(index)) return;
    const clause = clauses[clauseAt(token.start)];
    if (token.lex.ctx) clause.ctx = true;
    if (token.lex.want) clause.want = true;
    if (token.lex.section && !(sequenced && token.text === "最后"))
      clause.scoped = true;
  });

  const words: Word[] = analysis.tokens
    .map((token, index) => ({ token, index }))
    .filter(
      ({ token, index }) =>
        Object.keys(token.lex).length > 0 && !quiet?.dropped.has(index),
    )
    .map(({ token, index }) => ({
      ...token,
      scale: 1,
      clause: clauseAt(token.start),
      ...(quiet?.kept.has(index) ? { kept: true } : {}),
    }));

  // the masked text: numbers and naming words out of the way of the amount grammar
  let masked = lower;
  for (const token of analysis.tokens) {
    const lex = token.lex;
    const names =
      Object.keys(lex).length === 0
        ? token.text !== "up to"
        : !lex.qty &&
          !lex.about &&
          !!(
            lex.w ||
            lex.inst ||
            lex.target ||
            lex.arr ||
            (lex.seed && token.text !== "再来") ||
            lex.unsupported ||
            lex.section ||
            lex.loop !== undefined ||
            lex.mode ||
            lex.pitch ||
            lex.pos !== undefined ||
            lex.fixed ||
            lex.like ||
            lex.ctx ||
            lex.that ||
            lex.other ||
            lex.dislike ||
            lex.reset ||
            lex.solo
          );
    if (names)
      masked =
        masked.slice(0, token.start) +
        "\u0002".repeat(token.end - token.start) +
        masked.slice(token.end);
  }
  const near = (a: number, b: number, max: number) =>
    a >= 0 &&
    b < words.length &&
    gapBetween(lower, words[a].end, words[b].start, max) !== null;

  // "快了点", "鼓大了", "短了": an adjective with 了 describes the piece as it is
  if (mode === "refine")
    for (const word of words) {
      if (!isAdjective(word)) continue;
      const rest = lower.slice(word.end, clauses[word.clause].end);
      if (PERFECT.test(rest)) word.perfect = true;
    }

  // "not fast enough", "aren't loud enough": more of it, and the "not" negates nothing
  words.forEach((word, i) => {
    if (!word.lex.dim && word.lex.op !== "up" && word.lex.op !== "down") return;
    if (!/^\s*enough\b/.test(lower.slice(word.end))) return;
    const cue = words[i - 1];
    if (cue?.lex.neg && near(i - 1, i, 2)) {
      cue.used = true;
      cue.skip = true;
    }
    word.enough = true;
  });

  // modifiers: "太", "更", "一点", "很多" … also through "像" ("太像 X 了")
  words.forEach((word, i) => {
    if (!isContent(word.lex)) return;
    const mods: Lex["mod"][] = [];
    for (let k = i - 1; k >= 0 && near(k, k + 1, 0); k--) {
      const lex = words[k].lex;
      if (lex.like) word.liked = true;
      else if (lex.neg === "too") mods.push("too");
      else if (lex.mod) mods.push(lex.mod);
      else {
        // "more upbeat", "less busy": the English comparative
        if (/^(?:more|less)$/.test(words[k].text)) mods.push("more");
        break;
      }
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
    if (word.perfect && !word.lex.fixed) mods.push("too");
    // "faster", "more energetic": a comparative needs no "一点"
    if (COMPARATIVE_EN.test(word.text)) mods.push("more");
    if (word.enough) mods.push("more");
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
      // a new description: "don't make it sad" excludes what the verb leads to
      if (lex.change && mode === "new" && !lex.seed) continue;
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
    if (!cue.lex.neg || consumed.has(i) || cue.used) return;
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
      if (word.kept || word.enough) continue;
      if (kind === "hard" && word.neg === "hard") {
        // "别把鼓去掉": negated from both sides
        delete word.neg;
        word.kept = true;
      } else {
        word.neg = kind;
        if (cue.lex.copula) word.denied = true;
      }
    }
  });
  // "悲伤？不，要欢快的": a style that is asked about and then declined
  if (mode === "new")
    clauses.forEach((clause, index) => {
      const next = clauses[index + 1];
      if (!next || !/[?？]/.test(lower[clause.end] ?? "")) return;
      if (
        !/^\s*(?:不|不是|不要|不对|no|nope|nah)\s*$/.test(
          lower.slice(next.start, next.end),
        )
      )
        return;
      for (const word of words)
        if (word.clause === index && word.lex.w && !word.neg) word.neg = "hard";
    });
  // "swap piano for guitar": the first is replaced by the second
  words.forEach((word, i) => {
    const [first, second] = [words[i], words[i + 1]];
    if (!first?.lex.inst || !second?.lex.inst) return;
    if (
      !/(?:swap|replace|switch|exchange|trade)\s+(?:out\s+)?(?:the\s+)?$/.test(
        lower.slice(0, first.start),
      )
    )
      return;
    if (
      !/^\s*(?:for|with|by)\s+(?:a\s+|the\s+)?$/.test(
        lower.slice(first.end, second.start),
      )
    )
      return;
    first.replaced = true;
    second.changed = true;
    void word;
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
  clauses.forEach((clause, index) => {
    if (!clause.bare || clause.remark) return;
    // every character of a pure clause belongs to a known word or is a particle
    let rest = lower.slice(clause.start, clause.end);
    for (const token of analysis.tokens)
      if (
        token.start >= clause.start &&
        token.end <= clause.end &&
        Object.keys(token.lex).length > 0
      )
        rest =
          rest.slice(0, token.start - clause.start) +
          "\u0002".repeat(token.end - token.start) +
          rest.slice(token.end - clause.start);
    clause.pure =
      words.some((word) => word.clause === index) &&
      leftover(rest, false).length === 0;
  });
  return {
    analysis,
    words,
    clauses,
    locks: quiet?.locks ?? new Set(),
    general: quiet?.general ?? false,
    masked,
  };
}

/**
 * The unknown words of a clause around the stretch `from`…`to`: what stands
 * before it and what follows it. An adjective with nothing to hold on to
 * ("很快", "快点") is an instruction only when both are empty — "回复很快",
 * "快点交稿" speak of something else.
 */
export function strangers(
  reading: Pick<Reading, "analysis">,
  clause: Clause,
  from: number,
  to: number,
): { before: string; after: string } {
  const { lower, tokens } = reading.analysis;
  const blank = (start: number, end: number) => {
    let rest = lower.slice(start, end);
    for (const token of tokens)
      if (
        token.start >= start &&
        token.end <= end &&
        Object.keys(token.lex).length > 0
      )
        rest =
          rest.slice(0, token.start - start) +
          "\u0002".repeat(token.end - token.start) +
          rest.slice(token.end - start);
    return leftover(rest, true);
  };
  return {
    before: blank(clause.start, Math.max(clause.start, from)),
    after: blank(Math.min(clause.end, to), clause.end),
  };
}
