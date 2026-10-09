/**
 * The grammar of amounts: what a number in a request means, read from the
 * words that stand around it instead of from a list of whole phrases.
 *
 *  - a word of change in front ("上调 10", "往下降 10", "再来 20 秒") or
 *    behind ("10 bpm faster") makes it a difference;
 *  - a target cue between that word and the number ("降到 90", "= 96") makes
 *    it the new value, and so does a number with no word of change at all;
 *  - "至少 / 最多 / 不超过 / 不要低于 / at most" make it a bound: the current
 *    value is kept when it already satisfies the bound;
 *  - "总长 / 一共 / N 秒长 / N seconds long" make it a total;
 *  - "第 / 前 / 在 … 的地方 / 之后 / at / after" make a time a place inside
 *    the piece, never its length;
 *  - "不要 120", "不是 60 秒" reject the value, and "120 太快" complains
 *    about it: neither is ever the value that gets set.
 *
 * Everything here works on the "masked" text of a clause: numbers are
 * \u0001, dictionary words that only name things (parts, styles, instruments)
 * are \u0002, so "低音" or "小提琴" can never be read as "低" or "小".
 */
import type { Quantity } from "./lexicon";

export type Unit = Quantity["unit"];

export interface Direction {
  /** offsets inside the text that was searched */
  start: number;
  end: number;
  dir: 1 | -1;
  /** the word can only speak of the tempo (快, slower) or of the length (长, trim) */
  only?: "tempo" | "duration";
}

const UP_CN =
  "上调|调高|调大|调快|提高|提升|提速|升高|增加|增大|增长|加快|加大|加长|加速|加重|延长|拉长|拉高|开大|往上|向上|上去|上升|变快|变长|变大|变高|再来|涨|提|升|加|增|多|高|快|长|大|延|补|添";
const DOWN_CN =
  "下调|调低|调小|调慢|降低|降速|减少|减小|减慢|减速|减弱|缩短|缩减|剪短|剪掉|砍掉|删掉|去掉|截掉|压低|拉低|收小|放慢|往下|向下|下去|下降|变慢|变短|变小|变低|降|减|少|低|慢|短|小|压|收|砍|剪|截|删|缩|掉|扣";
const UP_EN =
  "bump(?:ed)?|more|add(?:ed|ing)?|raise|increase|up|faster|quicker|longer|louder|higher|extend|another|plus|extra|additional";
const DOWN_EN =
  "less|lower|decrease|reduce|down|off|slower|shorter|quieter|softer|cut|trim|shave|remove|drop|minus|knock|fewer";
const DIRECTION = new RegExp(
  `(${UP_CN})|(${DOWN_CN})|\\b(${UP_EN})\\b|\\b(${DOWN_EN})\\b`,
  "g",
);
const TEMPO_ONLY = /快|慢|速|faster|quicker|slower/;
const LENGTH_ONLY = /长|短|延|缩|剪|截|砍|longer|shorter|extend|trim|shave/;

/** Every word of change in `text`, in order. */
export function directionsIn(text: string): Direction[] {
  const found: Direction[] = [];
  for (const m of text.matchAll(DIRECTION)) {
    const word = m[0];
    found.push({
      start: m.index,
      end: m.index + word.length,
      dir: m[1] !== undefined || m[3] !== undefined ? 1 : -1,
      ...(TEMPO_ONLY.test(word)
        ? { only: "tempo" as const }
        : LENGTH_ONLY.test(word)
          ? { only: "duration" as const }
          : {}),
    });
  }
  return found;
}

/** Can this word of change speak of a number with this unit? */
export const fitsUnit = (direction: Direction, unit: Unit) =>
  !(direction.only === "tempo" && unit === "s") &&
  !(direction.only === "duration" && unit === "bpm");

/** "10 bpm faster", "20 seconds longer", "5 bpm off": the word of change follows. */
const TRAILING =
  /^\s*(?:or so\s+)?(faster|quicker|slower|longer|shorter|more|less|fewer|off|up|down|higher|lower|louder|quieter|extra)\b(?!\s*than)/;
export function trailingDirection(right: string): Direction | undefined {
  const m = TRAILING.exec(right);
  if (!m) return undefined;
  const start = m[0].length - m[1].length;
  return directionsIn(m[1]).map((found) => ({
    ...found,
    start: found.start + start,
    end: found.end + start,
  }))[0];
}

/** "+10", "-5": a signed number. */
export const signOf = (left: string): 1 | -1 | undefined =>
  /[+＋]\s*$/.test(left)
    ? 1
    : /(?:^|[\s\u0002:：=])[-−–]\s*$/.test(left)
      ? -1
      : undefined;

/* ---------- target, total ---------- */

const TARGET =
  /到|至|成|为|是|在|=|:|：|→|->|\bto\b|\bat\b|\bis\b|\bbe\b|\binto\b/;
/** A target cue between the word of change (or the subject) and the number. */
export const targetCue = (between: string) => TARGET.test(between);

const TOTAL_LEFT =
  /(?:时长|长度|总长度?|全长|总时长|一共|总共|共计?|整首|全曲|全部|合计|duration|length|runtime|total(?: of)?|in total|控制在|保持在|限制在|定在)\s*(?:是|为|要|有|得|大约|约|大概|[:=：])?\s*$/;
const TOTAL_RIGHT =
  /^\s*(?:钟)?(?:长(?!一?[点些]|了|度|得)|整|的?长度|的?时长|的?总长|\s*long\b(?!er)|\s*in (?:length|total)|\s*total\b|\s*overall)/;
/** "总长 1 分钟", "45 秒长", "60 seconds long": the whole length, however 长 / long reads elsewhere. */
export const totalCue = (left: string, right: string) =>
  TOTAL_LEFT.test(left) || TOTAL_RIGHT.test(right);

/* ---------- bounds ---------- */

const NEG =
  "(?:不要|不能|不可以|不可|不得|不许|不准|不应该?|不会|不想|别|勿|不|\\bno|\\bnot|\\bdon't|\\bdont|\\bdo not|\\bnever|\\bshouldn't|\\bcan't|\\bcannot)";
const MODAL = "(?:要|能|可以|得|让它?|\\s|to\\b|be\\b|go\\b|it\\b)*";
const ABOVE =
  "(?:超过|超出|高于|多于|长于|快于|大于|高过|多过|above|over|more than|longer than|faster than|higher than|greater than|beyond|exceed(?:s|ing)?)";
const BELOW =
  "(?:低于|少于|短于|慢于|小于|不到|不足|不满|under|below|less than|shorter than|slower than|lower than|fewer than)";
/** what may stand between a bound word and its number: "最多只能 20 秒", "至少要有 60 秒" */
const FILL = "(?:[也只就得要能有是为到在给来个约\\s]|可以|大概|大约|差不多)*";
const CAP_LEFT = new RegExp(
  `(?:${NEG}${MODAL}${ABOVE}|(?<!${NEG}${MODAL})${BELOW}|最多|至多|最高|最快|最长|最大|顶多|上限|封顶|\\bat most|\\bmax(?:imum)?(?: of)?|(?<!\\b(?:it|speed|turn|bring|crank|go|goes|move|push|them|this|that)\\s)\\bup to|\\bwithin|以内)${FILL}$`,
);
const FLOOR_LEFT = new RegExp(
  `(?:${NEG}${MODAL}${BELOW}|(?<!${NEG}${MODAL})${ABOVE}|最少|至少|最低|最慢|最短|最小|起码|下限|保底|\\bat least|\\bmin(?:imum)?(?: of)?)${FILL}$`,
);
const CAP_RIGHT =
  /^\s*(?:左右)?\s*(?:以内|之内|以下|以里|为止|封顶|\bor less\b|\bor under\b|\bmax\b|\bat most\b|\btops\b)/;
const FLOOR_RIGHT =
  /^\s*(?:左右)?\s*(?:以上|起步|起(?![来码])|往上|\bor more\b|\bor over\b|\bor longer\b|\bmin\b|\bat least\b|\band up\b)/;

/**
 * Is the number an upper or a lower bound? "不要低于 100" and "至少 100" are
 * floors, "不要高于 100", "最多 100" and "100 以内" are caps. A bound never
 * moves a value that already satisfies it.
 */
export function boundCue(
  left: string,
  right: string,
): "cap" | "floor" | undefined {
  if (CAP_LEFT.test(left) || CAP_RIGHT.test(right)) return "cap";
  if (FLOOR_LEFT.test(left) || FLOOR_RIGHT.test(right)) return "floor";
  return undefined;
}

/* ---------- places in time ---------- */

const POSITION_LEFT =
  /(?:第|(?<![之以目从提])前|(?<![然之以稍随今往])后|最后|开头的?|开始的?|末尾的?|(?<![开镜])头|尾|过了|到了|(?<![控保定设限制持长度现正实存内])在|\bfirst|\blast|\bfrom|\bafter|\bbefore|\bat|\baround(?: the)?|\buntil|\btill|\bby the)\s*$/;
const POSITION_RIGHT =
  /^\s*(?:左右|前后|上下)?\s*(?:的)?(?:地方|位置|时候|时间点|时刻|那里|那儿|那边|那一下|那一段|处|时(?![长间])|之后|以后|过后|之前|以前|后面?(?![延续])|前面?|开始|起(?![来码步])|那|进(?!行)|\s*mark\b|\s*in\b|\s*into\b|\s*on\b|\s*onwards?\b)/;
/**
 * Is a time a place inside the piece ("第 20 秒", "0:45 的地方", "after 20
 * seconds") rather than its length? `left` must not be a length cue.
 */
export function positionCue(left: string, right: string): boolean {
  if (TOTAL_LEFT.test(left)) return false;
  return POSITION_LEFT.test(left) || POSITION_RIGHT.test(right);
}

/* ---------- two numbers ---------- */

const RANGE_LINK = /^\s*(?:到|至|-|~|～|—|–|\bto\b|\band\b)\s*$/;
const RANGE_TAIL = /^\s*(?:之间|之内|范围|这个范围|区间)/;
const RANGE_HEAD = /(?:between|介于|在)\s*$/;
const DASH = /^\s*[-~～—–]\s*$/;
const FROM_HEAD =
  /(?:从|由|自|把|将|\bfrom\b)\s*(?:现在的?|原来的?|当前的?)?\s*$/;
const TO_LINK =
  /^\s*(?:[一-鿿\u0002]{0,3}?)(?:到|至|成|为|变|→|->|=>|\bto\b|\binto\b)\s*$/;
const VERB_LINK =
  /[改调降升变换提加减拉缩延增设压放开]|change|turn|make|go|drop|raise/;

/**
 * How two numbers that follow each other in one clause belong together:
 * "range" (10 到 20 秒之间, 90-100), "fromTo" (从 30 秒改成 60 秒: the second
 * is the target and the first is where it comes from), or not at all.
 */
export function pairKind(
  leftOfFirst: string,
  between: string,
  rightOfSecond: string,
  firstHasDirection: boolean,
): "range" | "fromTo" | undefined {
  if (RANGE_LINK.test(between)) {
    if (
      RANGE_TAIL.test(rightOfSecond) ||
      RANGE_HEAD.test(leftOfFirst) ||
      DASH.test(between)
    )
      return "range";
    if (firstHasDirection) return undefined;
    return FROM_HEAD.test(leftOfFirst) ? "fromTo" : "range";
  }
  if (
    TO_LINK.test(between) &&
    (FROM_HEAD.test(leftOfFirst) ||
      VERB_LINK.test(between) ||
      /变|→|->|=>/.test(between))
  )
    return "fromTo";
  return undefined;
}

/* ---------- values that are not wanted ---------- */

const REJECT = new RegExp(
  `(?:千万)?(?:不要|别|并?不是|并非|不算|不用|不必|没必要|不需要|无需|不想要?|不能|不可以|\\bnot|\\bisn't|\\bis not|\\bno)\\s*(?:再|用|是|要|到|在|成|为|有|\\bto\\b|\\bat\\b|\\bit\\b|\\bbe\\b|\\s)*$`,
);
/** "不要 120", "不是 60 秒", "not 120 bpm": the number is what the user does not want. */
export const rejectCue = (left: string) => REJECT.test(left);

const COMPLAINT =
  /^\s*(?:的话|的速度|的时长|的长度)?\s*(?:就|也|都|还是|确实|实在|真的|好像|感觉|是|有)?\s*(?:太|过于|有点儿?|有些|不够|嫌|\btoo\b|is too|are too|was too|feels too|isn't enough|is not enough|not enough)/;
/** "120 太快", "30 秒不够": a complaint about the value named, which is the current one. */
export const complaintCue = (right: string) => COMPLAINT.test(right);

/** "比 100 稍快": a little beyond the number named. */
export function besideCue(left: string, right: string): 1 | -1 | undefined {
  if (!/(?:比|than)\s*$/.test(left)) return undefined;
  const m =
    /^\s*(?:稍微?|略微?|还要?|更|再|要)?\s*(快|高|多|长|大|慢|低|少|短|小)/.exec(
      right,
    );
  return m ? (/[快高多长大]/.test(m[1]) ? 1 : -1) : undefined;
}
