/**
 * What a refinement says must NOT happen, and what it only remarks on.
 *
 * A negation binds to the verb that follows it: "鼓别关", "不要换成古筝",
 * "don't make it faster" forbid an action, so nothing in their scope is an
 * instruction and the thing they speak of is locked for the whole message.
 * A lack that is forbidden keeps the part ("鼓不能没有", "别把鼓去掉").
 * "保持速度", "30 秒不变" lock in the same way. A denied statement ("不是太
 * 快，是太慢") and a clause about an earlier version ("上一版太吵，这次刚
 * 好") are remarks: heard, never carried out.
 *
 * Pure text work on one clause at a time; reading.ts applies the result.
 */
import type { TrackName } from "../types";
import type { Token } from "./lexicon";

export type Lock =
  | "tempo"
  | "duration"
  | "key"
  | "instrument"
  | "mood"
  | "seed"
  | "loop"
  | "energy"
  | "complexity"
  | "reverb"
  | "arrangement"
  | `vol:${TrackName}`;

export interface Hush {
  /** tokens that are not instructions (indexes into the token list) */
  dropped: Set<number>;
  /** part and instrument tokens that must stay ("别把鼓去掉") */
  kept: Set<number>;
  /** what must come out of this message exactly as it went in */
  locks: Set<Lock>;
  /** something was forbidden or kept without naming what ("什么都别动") */
  general: boolean;
  /** clauses that only remark on an earlier version or deny a statement */
  remarks: Set<number>;
}

const END = "，,。；;!！?？\\n";
const GUARDED_NOT = "(?<![要是能可好行对来得用差了说忍并也倒])";
const PROHIBIT =
  "(?:千万|可|也|先|暂时|就|都|还是|请|最好)?(?:(?<![要])不要|不用|不必|不需要|没必要|无需|用不着|(?<![能])不能|(?<![可])不可以|不许|不准|不想|不希望|不打算|(?<![特区分个识告离差])别|甭|勿|没说要|没让你|没叫你|不是让你|不是叫你|不是要你?|不是想|没有要|没想要?)";
const LEAD_IN = `(?:再|去|给我|随便|乱|轻易|擅自|急着|老是|总是|把[^${END}]{1,12}?|将[^${END}]{1,12}?|让[^${END}]{1,8}?)?`;
/** removing or lacking: forbidden, it means the part stays */
const LACK =
  "关|去掉|去除|去|删|拿掉|拿|停掉|停|静音|没有|没|少(?![于点些一])|缺|不要|砍掉";
const ACT = `更|再|换|改|变|动|调|修改|加|减|增|提|升|降|压|收|缩|延|拉|放慢|放大|开(?=到|大|小|高|低)|重(?=新|来|做|写|编|生)|碰|移|转|切|设|剪|截`;
const VETO_CN = new RegExp(
  `${PROHIBIT}\\s*${LEAD_IN}\\s*(?:(${LACK})|(${ACT}))`,
  "g",
);
const VETO_BARE = new RegExp(
  `${GUARDED_NOT}不\\s*(?:(关|删)|(换|改|动|变|调))`,
  "g",
);
const VETO_EN =
  /\b(?:please\s+)?(?:don't|dont|do not|never|no need to|shouldn't|should not|won't|not going to)(?:\s+(?:ever|just|even|you|go|try to|want to|need to|have to))*\s+(?:(remove|mute|drop|kill|lose|cut)|(make|change|touch|alter|adjust|modify|switch|swap|replace|add|raise|lower|increase|decrease|turn|set|speed|slow|extend|shorten|lengthen|move|transpose|redo|regenerate|rewrite|reroll))\b/g;
const VETO_EN_PASSIVE =
  /\b(?:don't|dont|do not)\s+want\s+(?:the\s+|any\s+|my\s+)?[a-z ]{2,24}?\s+(?:(removed|muted|gone|cut|dropped)|(changed|touched|altered|replaced))\b/g;
/** "not louder", "not any faster": a comparative that is declined */
const DECLINED_EN =
  /\bnot\s+(?:any\s+)?(?:louder|quieter|faster|slower|longer|shorter|higher|lower|softer|brighter|darker|more\s+[a-z]+|less\s+[a-z]+)\b/g;
const CONTRAST = /但是|但|不过|而是|只是|只要|然后|\bbut\b|\bjust\b|\bonly\b/;

const DENY =
  /(?<![是要])(?:并不是|并非|也不是|倒不是|不是|不算)(?!让你|叫你|要你?|想|不要|不想|没有)|\b(?:it's not that|it is not that|not that)\b/g;
const DENY_END = /而是|只是|就是|(?<=[\s\d\u0001\u0002])是|\bbut\b|\bit's\b/;

const HISTORY =
  /^\s*(?:我|你|他|她|客户|老板|甲方|我们|咱们?)?\s*(?:上一?[次版回]|上一个版本|上个版本|之前|刚才|刚刚|昨天|前天|以前|原来|原先|先前|早先|前一版|第一版|last time|previously|earlier|yesterday|the (?:last|previous) (?:version|one|take))/;
const UNDO =
  /回到|换回|改回|变回|恢复|还原|撤销|用回|undo|revert|go back|bring back|restore/;

const KEEP =
  /保持不变|保持原样|保持现状|保持|维持|不变|照旧|原样|别动|不动|留着|\bkeep\b|\bunchanged\b|\bas is\b|\bstays? the same\b|\bthe same\b|\bleave\b/g;
/** what may stand in a clause that only says "keep this": names, particles, pronouns */
const KEEP_FILLER =
  /[\s\u0001\u0002的地得了吧呢啊呀嘛就好行都也还是这那个次版首段曲音乐现在当前原来整体其他它余全部别一切东西样子可以吗请要我你们]|everything|else|anything|it|the|this|that|as|is|please|all|rest|other|same|just|and|its/g;

const SUBJECT_GAP =
  /^[\s的音量声部分这个也都就先暂时可千万还是呢啊吧嘛们它一定可能应该最好\u0002]*$/;

const RAW_LOCKS: [RegExp, Lock][] = [
  [/乐器|音色|instrument|\bsound\b|\blead\b/, "instrument"],
  [/风格|曲风|\bstyle\b|\bgenre\b|\bvibe\b/, "mood"],
  [
    /(?<![大小声强语腔])调(?![整高低大小快慢到成为节皮性音得一])|\bkey\b|transpose|升调|降调|变调|调性/,
    "key",
  ],
  [/速度|节奏|拍速|\btempo\b|\bbpm\b|\bpace\b/, "tempo"],
  [/时长|长度|\blength\b|\bduration\b/, "duration"],
  [/循环|结尾|\bloop\b|\bending\b/, "loop"],
];

const TRACK_NAMES: TrackName[] = ["melody", "chords", "bass", "drums"];
const isTrackName = (value: unknown): value is TrackName =>
  (TRACK_NAMES as unknown[]).includes(value);

interface Span {
  start: number;
  end: number;
}

/**
 * Read the vetoes, keeps and remarks of a refinement. `clauses` are the
 * spans between sentence punctuation; `tokens` the lexicon's reading.
 */
export function hush(lower: string, tokens: Token[], clauses: Span[]): Hush {
  const out: Hush = {
    dropped: new Set(),
    kept: new Set(),
    locks: new Set(),
    general: false,
    remarks: new Set(),
  };
  const inside = (span: Span) =>
    tokens
      .map((token, index) => ({ token, index }))
      .filter(
        ({ token }) => token.start >= span.start && token.end <= span.end,
      );

  /** Lock what the tokens and the words of a forbidden or kept span speak of. */
  const lockSpan = (
    span: Span,
    lack: boolean,
    changes: boolean,
    rawFrom = span.start,
  ) => {
    let named = false;
    for (const { token, index } of inside(span)) {
      const lex = token.lex;
      out.dropped.add(index);
      if (isTrackName(lex.target)) {
        named = true;
        if (lack) {
          out.dropped.delete(index);
          out.kept.add(index);
        } else {
          out.locks.add(`vol:${lex.target}`);
          // "旋律别变": the tune itself, not only its fader
          if (lex.target === "melody" && changes) out.locks.add("seed");
        }
        continue;
      }
      if (
        lex.target === "tempo" ||
        lex.dim === "tempo" ||
        lex.qty?.unit === "bpm" ||
        lex.qty?.about === "tempo"
      )
        out.locks.add("tempo");
      else if (lex.target) out.locks.add(lex.target);
      else if (lex.dim) out.locks.add(lex.dim);
      else if (lex.length || lex.about || lex.qty?.unit === "s")
        out.locks.add("duration");
      else if (lex.inst && !lex.cat) out.locks.add("instrument");
      else if (lex.seed) out.locks.add("seed");
      else if (lex.loop !== undefined && !lex.w) out.locks.add("loop");
      else if (
        lex.key ||
        lex.shift ||
        lex.relative ||
        lex.pitch ||
        (lex.mode && !lex.w && !lex.dim)
      )
        out.locks.add("key");
      else if (lex.arr) out.locks.add("arrangement");
      else if (lex.w && lex.cat) out.locks.add("mood");
      else continue;
      named = true;
    }
    const text = lower.slice(Math.min(span.start, rawFrom), span.end);
    for (const [pattern, lock] of RAW_LOCKS)
      if (pattern.test(text)) {
        out.locks.add(lock);
        named = true;
      }
    if (!named) out.general = true;
  };

  clauses.forEach((clause, clauseIndex) => {
    const text = lower.slice(clause.start, clause.end);
    if (!text.trim()) return;

    // a clause about an earlier version is a remark, unless it asks to go back
    if (HISTORY.test(text) && !UNDO.test(text)) {
      for (const { index } of inside(clause)) out.dropped.add(index);
      out.remarks.add(clauseIndex);
      return;
    }

    const vetoes: (Span & { lack: boolean; changes: boolean })[] = [];
    for (const pattern of [VETO_CN, VETO_BARE, VETO_EN, VETO_EN_PASSIVE]) {
      pattern.lastIndex = 0;
      for (const m of text.matchAll(pattern)) {
        const start = clause.start + m.index;
        if (vetoes.some((veto) => start >= veto.start && start < veto.end))
          continue;
        const rest = lower.slice(start + m[0].length, clause.end);
        const turn = CONTRAST.exec(rest);
        vetoes.push({
          start,
          end: turn ? start + m[0].length + turn.index : clause.end,
          lack: m[1] !== undefined,
          changes:
            /换|改|变|动|重|change|alter|replace|rewrite|redo|regenerate|reroll/.test(
              m[2] ?? "",
            ),
        });
      }
    }
    for (const veto of vetoes) {
      // the thing spoken of may stand in front: "鼓别关", "钢琴不要换"
      let from = veto.start;
      for (const { token } of inside({
        start: clause.start,
        end: veto.start,
      }).reverse()) {
        const lex = token.lex;
        const names =
          lex.target ||
          lex.about ||
          lex.pitch ||
          lex.key ||
          lex.qty ||
          (lex.inst && !lex.cat) ||
          lex.link ||
          lex.loop !== undefined;
        if (!names || !SUBJECT_GAP.test(lower.slice(token.end, from))) break;
        from = token.start;
      }
      // "风格不变": a short lead-in names what is meant even without a dictionary word
      lockSpan(
        { start: from, end: veto.end },
        veto.lack,
        veto.changes,
        from - clause.start <= 8 ? clause.start : from,
      );
    }

    DECLINED_EN.lastIndex = 0;
    for (const m of text.matchAll(DECLINED_EN)) {
      const span = {
        start: clause.start + m.index,
        end: clause.start + m.index + m[0].length,
      };
      for (const { index } of inside(span)) out.dropped.add(index);
    }

    // "不是太快，是太慢": what is denied is not asked for
    DENY.lastIndex = 0;
    for (const m of text.matchAll(DENY)) {
      const start = clause.start + m.index;
      if (vetoes.some((veto) => start >= veto.start && start < veto.end))
        continue;
      const rest = lower.slice(start + m[0].length, clause.end);
      const turn = DENY_END.exec(rest);
      const span = {
        start,
        end: turn ? start + m[0].length + turn.index : clause.end,
      };
      for (const { index } of inside(span)) out.dropped.add(index);
      if (!turn) out.remarks.add(clauseIndex);
    }

    // "保持速度", "30 秒不变", "keep the melody": a clause that only says "keep this"
    if (!vetoes.length) {
      KEEP.lastIndex = 0;
      const keeps = [...text.matchAll(KEEP)];
      if (keeps.length) {
        const members = inside(clause).filter(
          ({ index }) => !out.dropped.has(index),
        );
        const asks = members.some(({ token }) => {
          const lex = token.lex;
          const inKeep = keeps.some(
            (m) =>
              token.start >= clause.start + m.index &&
              token.end <= clause.start + m.index + m[0].length,
          );
          if (inKeep || lex.keep) return false;
          // "保持在 45 秒" sets a length; "30 秒不变" keeps one
          if (lex.qty)
            return !keeps.some((m) => clause.start + m.index >= token.end);
          return !!(
            lex.op ||
            lex.change ||
            lex.neg ||
            lex.seed ||
            lex.mod ||
            lex.length ||
            lex.shift ||
            lex.reset ||
            (lex.dim && !lex.target && !lex.w)
          );
        });
        let bare = text;
        for (const m of keeps) bare = bare.replace(m[0], "");
        for (const { token } of members)
          bare = bare.replace(lower.slice(token.start, token.end), "");
        const leftover = bare.replace(KEEP_FILLER, "");
        if (!asks && [...leftover].length <= 1) lockSpan(clause, false, true);
      }
    }
  });
  return out;
}
