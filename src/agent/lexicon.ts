/**
 * Vocabulary of the offline producer brain: how scene, genre, emotion, era,
 * instrument and mixing words map to styles and parameters, plus the text
 * normaliser and the tokenizer that reads a request with it.
 *
 * Matching is leftmost-longest over one merged dictionary, so "欢快" is read
 * as one word and never as "…快" (faster), and "电子游戏" never as "电子".
 */
import type { TrackName } from "../types";
import {
  INSTRUMENT_LIST,
  KEYS,
  parseKey,
  type BassFeel,
  type DrumFeel,
  type InstrumentId,
  type StyleId,
} from "../music/catalog";

export type Cat = "genre" | "scene" | "emotion" | "era" | "usage" | "game";
export type Dim = "energy" | "complexity" | "reverb" | "tempo";
/** Things a level word ("大一点", "less", "静音") can be attached to. */
export type Target = TrackName | Dim;
/**
 * A number with its unit, as written. What it means — a total, a change, a
 * point in time — is decided by the clause it stands in (rules.ts).
 *  bpm: beats per minute   s: seconds   %: percent   x: a factor ("一半", "翻倍")
 *  n: a bare number ("速度 96", "把鼓调到 80", "复杂度 0.3")
 *  db: decibels ("鼓大 6dB"): a direction and a rough size, never a target
 */
export interface Quantity {
  unit: "bpm" | "s" | "%" | "x" | "n" | "db";
  value: number;
  /** written as a clock time ("0:45") */
  clock?: boolean;
  /** the number names its own subject ("1.5 倍速", "2 倍长") */
  about?: "tempo" | "duration";
  /** written with a decimal point ("0.5"): a fraction, not percentage points */
  decimal?: boolean;
}
export type Weights = Partial<Record<StyleId, number>>;

export interface ArrHint {
  pad?: boolean;
  arp?: boolean;
  counter?: boolean;
  perc?: boolean;
  drums?: DrumFeel;
  bass?: BassFeel;
  swing?: number;
  register?: "low" | "mid" | "high";
  motion?: "stepwise" | "leaps" | "arpeggio";
}

/** Everything one dictionary word can mean; most words use two or three facets. */
export interface Lex {
  /** style evidence */
  w?: Weights;
  cat?: Cat;
  /** valence / arousal contribution, each -1..1 */
  v?: number;
  a?: number;
  mode?: "major" | "minor";
  inst?: InstrumentId;
  /** what to tell the user when a requested sound has no exact voice */
  note?: string;
  target?: Target;
  /** negation cue: "hard" excludes, "too" is a comparative ("不要太…") */
  neg?: "hard" | "too";
  /** the bare "不": a cue only when the negated word follows at once ("不悲伤") */
  bare?: boolean;
  dim?: Dim;
  dir?: 1 | -1;
  /** complaint words ("太吵", "单调"): the direction never inverts */
  fixed?: boolean;
  /** tempo words: position inside the style's BPM range, 0..1 */
  pos?: number;
  /** a genre with a tempo of its own (Drum & Bass) */
  tempo?: number;
  op?: "up" | "down" | "mute" | "unmute" | "add" | "only";
  side?: "pre" | "post" | "both";
  mod?: "too" | "more" | "slight" | "lot" | "very" | "somewhat";
  loop?: boolean;
  /**
   * "melody": an explicit request for other notes ("换个旋律"); "again": another
   * go at the piece ("再来一个"), a new melody only when nothing else is asked.
   */
  seed?: "melody" | "again";
  arr?: ArrHint;
  /** "换成 / 改成 / switch to" */
  change?: boolean;
  /** "风格 / 感觉 / style" directly after a style word */
  suffix?: boolean;
  /** "加点 / 带点 … 元素": a flavour, not a full style change */
  flavour?: boolean;
  link?: boolean;
  /** ends a clause ("但是", "but") */
  brk?: boolean;
  solo?: boolean;
  section?: boolean;
  /** stings (片头, 胜利): short and with an ending unless told otherwise */
  short?: boolean;
  noDrums?: boolean;
  /** "长一点 / 短一点" */
  length?: 1 | -1;
  qty?: Quantity;
  /** semitones to move the key by ("升一个调", "降半音") */
  shift?: number;
  /** "关系小调 / relative major" */
  relative?: "major" | "minor";
  /** "音调 / 调子 / pitch": 高 / 低 next to it move the key, not a fader */
  pitch?: boolean;
  /** "时长 / 长度 / length": the length of the piece, as the inspector names it */
  about?: "duration";
  /** a key written with its tonic ("G 大调"); the first one is also Analysis.key */
  key?: string;
  /** "不是 / 并非 / 除了": says what something is not; never removes a part */
  copula?: boolean;
  /** a sound effect ("雨声", "掌声"): not an instrument and not a scene */
  effect?: boolean;
  /** the clause says what the music is for ("这是给…配的", "用在…里") */
  ctx?: boolean;
  /** resemblance ("像", "sounds like") */
  like?: boolean;
  /** a wish ("想要", "让它") */
  want?: boolean;
  /** "别的 / 其他乐器": anything but the thing named before */
  other?: boolean;
  /** "不好听 / 不喜欢": displeasure without a direction */
  dislike?: boolean;
  /** "保持 / 不变 / 别动": leave the thing named beside it alone */
  keep?: boolean;
  /** "这种感觉 / 这样": refers back to what was just described */
  that?: boolean;
  /** "恢复默认 / 全部恢复" */
  reset?: "all" | "volumes";
  tag?: string;
  unsupported?: string;
}

export interface Token {
  start: number;
  end: number;
  text: string;
  lex: Lex;
}

const DICT = new Map<string, Lex>();

function add(terms: string, lex: Lex) {
  for (const term of terms.split("|")) {
    const key = term.trim();
    if (!key) continue;
    const previous = DICT.get(key);
    DICT.set(
      key,
      previous
        ? { ...previous, ...lex, w: lex.w ?? previous.w }
        : lex,
    );
  }
}
const style = (cat: Cat, terms: string, w: Weights, extra: Lex = {}) =>
  add(terms, { cat, w, ...extra });

/* ---------- scenes and usage ---------- */
style("scene", "vlog|日常|生活记录|日记|plog|记录生活|生活碎片|daily", { bright: 2.2, acoustic: 1.5, chill: 0.8 }, { v: 0.5, a: 0.2 });
style("scene", "校园|青春|学生|操场|同学|少年|youth|campus|school|teen", { bright: 2.5, acoustic: 1 }, { v: 0.6, a: 0.3 });
style("scene", "毕业|毕业季|graduation", { bright: 1.5, cinematic: 1.5, sad: 1, acoustic: 1 }, { v: 0.1 });
style("scene", "旅行|旅游|旅途|出游|自驾|公路|风景|户外|露营|徒步|travel|trip|journey|road trip|outdoor|hiking|camping", { acoustic: 2.2, bright: 2, cinematic: 0.6 }, { v: 0.6, a: 0.3 });
style("scene", "美食|探店|做饭|烹饪|料理|吃播|下午茶|烘焙|厨房|餐厅|food|cooking|recipe|kitchen|foodie", { bright: 2, jazz: 1.6, acoustic: 1.3, cute: 1, chill: 0.8 }, { v: 0.6, a: 0.2 });
style("scene", "宠物|猫咪|小猫|猫|狗狗|小狗|萌宠|小动物|pet|pets|cat|cats|kitten|puppy|dog|dogs", { cute: 3, bright: 1 }, { v: 0.8, a: 0.4 });
style("scene", "萌娃|宝宝|婴儿|亲子|母婴|baby|toddler", { cute: 3, dreamy: 0.8 }, { v: 0.8, a: 0.2 });
style("scene", "儿童|小朋友|小孩|孩子|幼儿|童年|童趣|儿歌|kids|children|child|kid|nursery", { cute: 3, bright: 1 }, { v: 0.8, a: 0.4 });
style("scene", "动画|卡通|动漫|二次元|番剧|cartoon|anime|animation", { cute: 2.2, bright: 1.2, chiptune: 0.5 }, { v: 0.6, a: 0.4 });
style("scene", "咖啡馆|咖啡店|咖啡厅|咖啡|cafe|coffee|coffee shop|café", { chill: 3, jazz: 1.5, acoustic: 0.8 }, { v: 0.3, a: -0.4 });
style("scene", "雨天|下雨|雨夜|雨声|雨后|小雨|rain|rainy|raining", { chill: 2, sad: 1, dreamy: 0.6, ambient: 0.6, focus: 0.5 }, { v: -0.1, a: -0.5 });
style("scene", "深夜|夜晚|午夜|凌晨|晚上|夜色|夜景|night|midnight|late night", { chill: 1.6, jazz: 1, ambient: 0.8, sad: 0.6, dreamy: 0.5 }, { v: -0.1, a: -0.4 });
style("scene", "书店|bookstore", { chill: 2.2, focus: 2, jazz: 0.8 }, { a: -0.5 });
style("usage", "图书馆|阅读|看书|读书|自习|学习|工作|办公|写作业|写代码|编程|专注|复习|study|studying|reading|work|working|coding|focus|concentration|homework|library", { focus: 3, chill: 1.2 }, { a: -0.5 });
style("genre", "lofi|lo fi|chillhop|chill hop|低保真", { chill: 4, hiphop: 0.8, focus: 0.8 }, { a: -0.5 });
style("genre", "lofi hip hop|lo fi hip hop|lofi hiphop|lofi beats|lo fi beats", { chill: 5, hiphop: 1 }, { a: -0.5 });
style("emotion", "chill|慵懒|松弛|放松|悠闲|惬意|闲适|休闲|relax|relaxing|relaxed|laid back|chillout|chill out|mellow", { chill: 3, acoustic: 0.8, jazz: 0.6 }, { v: 0.4, a: -0.6 });
style("usage", "电影|电影感|影视|大片|cinematic|film|movie|soundtrack|ost|film score", { cinematic: 3.2, epic: 0.8 });
style("emotion", "戏剧|戏剧性|戏剧化|dramatic|drama", { cinematic: 2.5, epic: 1 }, { a: 0.3 });
style("usage", "预告片|预告|trailer|teaser", { epic: 3, cinematic: 2, tension: 0.5 }, { a: 0.6 });
style("usage", "纪录片|人文|历史|documentary", { cinematic: 3, ambient: 0.8 });
style("scene", "叙事|故事|故事感|剧情|回忆|往事|时光|岁月|narrative|story|storytelling|memory|memories", { cinematic: 2.5, sad: 0.8, romantic: 0.6, acoustic: 0.5 });
style("emotion", "怀旧|nostalgic|nostalgia", { cinematic: 1.5, retro: 1.5, sad: 0.8, acoustic: 0.5 }, { v: -0.1, a: -0.2 });
style("emotion", "感人|感动|催泪|泪目|走心|动人|touching|emotional|moving|heartfelt|tearjerker", { cinematic: 2.2, sad: 1.8, romantic: 1 }, { v: -0.2, a: -0.2 });
style("genre", "史诗|史诗感|宏大|壮阔|磅礴|恢弘|大气|气势|震撼|壮丽|雄壮|epic|majestic|grand|heroic|anthem", { epic: 4, cinematic: 1.2 }, { a: 0.7 });
style("genre", "管弦|管弦乐|交响|交响乐|orchestral|orchestra|symphony|symphonic", { cinematic: 2.2, epic: 2 }, { inst: "strings" });
style("genre", "古典|古典乐|classical|巴洛克|baroque", { cinematic: 2, romantic: 1, focus: 0.5 });
style("emotion", "燃|燃向|很燃|超燃|高燃|热血|激昂|振奋|斗志|拼搏|奋斗|逆袭|炸裂|triumphant", { epic: 3, rock: 1.5, battle: 1, dance: 0.6 }, { v: 0.4, a: 0.9 });
style("emotion", "励志|鼓舞|鼓舞人心|motivational|inspiring|inspirational|uplifting", { epic: 2, corporate: 1.6, cinematic: 1 }, { v: 0.6, a: 0.6 });
style("game", "战斗|打斗|对战|激战|厮杀|开战|battle|fight|fighting|combat|war", { battle: 4, epic: 1.5, rock: 0.8 }, { v: -0.2, a: 1 });
style("game", "boss|boss战|关底|最终决战|决战|final boss", { battle: 4, epic: 1.5, tension: 0.5 }, { a: 1 });
style("scene", "追逐|追车|逃亡|逃跑|追击|飙车|竞速|赛车|chase|pursuit|escape|racing|race", { battle: 3.5, tension: 1.5, rock: 1, dance: 0.8 }, { a: 0.9, pos: 0.85 });
style("game", "对决|决斗|较量|pk|duel|showdown|versus", { battle: 3, epic: 1.5, tension: 1 }, { a: 0.8 });
style("genre", "像素|像素风|8 bit|8bit|8位|红白机|fc|nes|gameboy|game boy|掌机|街机|arcade|chiptune|chip tune|芯片音乐|复古游戏|retro game|pixel|pixel art", { chiptune: 4.5, retro: 0.8 }, { v: 0.5, a: 0.5 });
style("game", "游戏|game|games|gaming|手游", { chiptune: 1.3, retro: 0.6, battle: 0.5, cute: 0.4, epic: 0.4 });
style("game", "小游戏|电子游戏|电玩|video game|videogame|mini game", { chiptune: 3.5, retro: 1, cute: 0.6 });
style("genre", "国风|古风|中国风|中式|东方|国潮|仙侠|武侠|江湖|修仙|古装|宫廷|汉服|江南|江南小调|民间小调|水墨|山水|古韵|chinese|china|oriental|wuxia|xianxia|guofeng|chinese style|traditional chinese", { guofeng: 4 });
style("scene", "茶|茶道|茶馆|品茶|tea", { guofeng: 2, chill: 1, acoustic: 0.6 }, { a: -0.4 });
style("scene", "禅|禅意|zen", { guofeng: 2, ambient: 2.2 }, { a: -0.8 });
style("genre", "和风|日式|日系|japanese", { guofeng: 1.6, acoustic: 1.2, dreamy: 1 });
style("genre", "爵士|爵士乐|jazz|jazzy|jazzier|摇摆乐|bebop|小酒馆|酒吧|酒馆|jazz bar|piano bar|cocktail bar|lounge|cocktail|鸡尾酒|威士忌|布鲁斯|蓝调|blues", { jazz: 4, chill: 0.6 }, { a: -0.1 });
style("genre", "bossa|bossa nova|波萨诺瓦|巴萨诺瓦", { jazz: 3.5, chill: 1.5, acoustic: 1 });
style("genre", "funk|funky|放克", { jazz: 3, hiphop: 1.5, dance: 1, retro: 0.8 }, { a: 0.4 });
style("genre", "soul|灵魂乐|neo soul", { jazz: 2.5, hiphop: 1, chill: 1 });
style("genre", "r&b|rnb|节奏布鲁斯", { hiphop: 2, jazz: 2, chill: 1.5, romantic: 1 });
style("genre", "groove|律动|groovy", { hiphop: 1, jazz: 0.8, dance: 0.8 });
style("genre", "拉丁|latin|salsa|雷鬼|reggae", { jazz: 1.6, dance: 1.5, bright: 1.5 }, { v: 0.6, a: 0.4 });
style("genre", "民谣|乡村|folk|country|indie folk|弹唱|原声|acoustic|unplugged|田园|乡间|篝火", { acoustic: 4 }, { v: 0.5, a: -0.2 });
style("emotion", "治愈|疗愈|温暖|暖心|healing|warm|cozy|cosy", { acoustic: 2.2, dreamy: 1, romantic: 0.8, chill: 0.8, bright: 0.6 }, { v: 0.6, a: -0.3 });
style("scene", "清晨|早晨|晨光|早安|morning|sunrise", { acoustic: 2.2, bright: 1, dreamy: 0.6 }, { v: 0.6, a: -0.2 });
style("emotion", "清新|小清新|fresh", { acoustic: 2, bright: 1.5 }, { v: 0.6 });
style("emotion", "阳光|sunny|sunshine", { bright: 2.5, acoustic: 1 }, { v: 0.8, a: 0.3, mode: "major" });
style("scene", "午后|下午|afternoon", { chill: 1.5, acoustic: 1 }, { a: -0.3 });
style("genre", "悬疑|推理|侦探|谜案|神秘|诡异|诡秘|阴森|不安|危机|潜行|潜入|suspense|mystery|mysterious|detective|thriller|eerie|ominous|sinister|stealth", { tension: 4 }, { v: -0.6, a: 0.2, mode: "minor" });
style("emotion", "暗黑|黑暗|阴暗|dark|darker", { tension: 2.5, epic: 0.5, ambient: 0.5 }, { v: -0.6, mode: "minor" });
style("genre", "恐怖|惊悚|惊吓|鬼|鬼屋|闹鬼|灵异|丧尸|僵尸|噩梦|horror|scary|spooky|haunted|ghost|zombie|nightmare|creepy", { tension: 4.5, ambient: 0.8 }, { v: -0.9, a: 0.3, mode: "minor" });
style("emotion", "紧张|紧迫|压迫感|倒计时|心跳|惊险|焦虑|tense|tension|suspenseful|nervous|anxious", { tension: 3, battle: 1.5 }, { v: -0.4, a: 0.7 });
style("emotion", "刺激|thrilling|exciting|adrenaline", { battle: 1.5, tension: 1.5, dance: 1, rock: 0.8 }, { a: 0.8 });
style("game", "解谜|益智|谜题|puzzle|脑洞|推箱子", { tension: 2.5, focus: 1.5, dreamy: 0.8, chiptune: 0.6 }, { a: -0.2 });
style("emotion", "可爱|俏皮|萌|萌系|卡哇伊|调皮|小调皮|顽皮|蹦蹦跳跳|软萌|糖果|cute|kawaii|playful|quirky|bouncy|whimsical", { cute: 4, bright: 1 }, { v: 0.9, a: 0.5, mode: "major" });
style("emotion", "搞笑|搞怪|滑稽|幽默|逗比|沙雕|funny|silly|comedy|humor|humorous|goofy", { cute: 3, bright: 1.5, chiptune: 0.8, jazz: 0.5 }, { v: 0.8, a: 0.6 });
style("usage", "鬼畜", { cute: 2, chiptune: 1.5, dance: 1.5, bright: 1 }, { a: 0.8 });
style("emotion", "活泼|lively", { bright: 2.2, cute: 2 }, { v: 0.8, a: 0.6, mode: "major" });
style("emotion", "甜|甜美|甜蜜|sweet", { romantic: 2, cute: 1.5 }, { v: 0.8 });
style("scene", "童话|fairy tale|fairytale", { dreamy: 2, cute: 2 }, { v: 0.6 });
style("genre", "氛围音乐|环境音|环境音乐|ambient|drone|soundscape", { ambient: 3.5, dreamy: 0.8, tension: 0.4 }, { a: -0.7 });
// "有氛围感的咖啡店 vlog": a mood, not the ambient genre
style("emotion", "氛围|氛围感|atmosphere|atmospheric", { ambient: 1.4, dreamy: 0.8, chill: 0.8, cinematic: 0.6 }, { a: -0.3 });
style("usage", "冥想|打坐|正念|meditation|meditate|meditative|mindfulness|助眠|睡眠|睡前|入睡|哄睡|催眠|安眠|晚安|sleep|sleeping|bedtime|lullaby|摇篮曲|瑜伽|yoga|spa|按摩|白噪|白噪音|white noise|深呼吸|放空|发呆", { ambient: 4.5, dreamy: 0.8 }, { v: 0.1, a: -0.9, noDrums: true });
style("emotion", "梦幻|空灵|梦境|梦|星空|星河|银河|仙境|云端|漂浮|失重|月光|极光|深海|海底|水下|dream|dreamy|dreams|ethereal|galaxy|stars|starry|floating|underwater", { dreamy: 3.5, ambient: 1.2 }, { v: 0.3, a: -0.5 });
style("scene", "奇幻|魔法|精灵|fantasy|magic|magical|fairy", { dreamy: 2.2, cinematic: 1.2, epic: 1 });
style("scene", "宇宙|太空|科幻|space|cosmos|cosmic|sci fi|scifi|outer space", { dreamy: 2.2, ambient: 2, retro: 1.5, cinematic: 1 });
style("usage", "科技|科技感|未来|未来感|智能|ai|人工智能|互联网|数码|数字|创新|tech|technology|future|futuristic|innovation|digital|startup|saas", { corporate: 3, retro: 0.8, dance: 0.5 }, { v: 0.4, a: 0.3 });
style("usage", "商务|企业|公司|宣传片|宣传|品牌|产品|发布会|路演|融资|创业|汇报|ppt|演示|讲解|教程|开箱|测评|广告|招聘|团队|corporate|business|presentation|commercial|promo|product|launch|explainer|tutorial|advert|advertisement|brand|company|keynote|pitch", { corporate: 3.5 }, { v: 0.5, a: 0.3 });
style("usage", "新闻|播报|资讯|快讯|时事|财经|news|newscast|broadcast|headline|bulletin", { corporate: 3, epic: 1.5, tension: 0.5 }, { a: 0.4 });
style("usage", "片头|开场|开场白|栏目|节目|logo|sting|ident|片花|转场|opener|intro music", { corporate: 1.4, epic: 1.3, cinematic: 0.6 }, { short: true });
style("usage", "提示音|通知音|jingle|notification", { corporate: 1.5, cute: 1.4, bright: 1 }, { short: true });
style("usage", "片尾|片尾曲|结尾曲|credits|end credits|ending theme", { cinematic: 1.6, sad: 0.8, romantic: 0.8 }, { loop: false });
style("emotion", "伤感|悲伤|难过|忧伤|忧郁|哀伤|悲凉|凄美|心碎|心痛|眼泪|流泪|哭|离别|告别|分别|分手|失恋|孤独|孤单|寂寞|思念|想念|怀念|遗憾|惆怅|落寞|低落|emo|抑郁|sad|sadder|sadness|sorrow|sorrowful|melancholy|melancholic|lonely|loneliness|heartbreak|heartbroken|farewell|goodbye|grief|mourning|depressed|gloomy|tearful|bittersweet", { sad: 3, cinematic: 0.8 }, { v: -0.8, a: -0.5, mode: "minor" });
style("genre", "电音|电子音乐|电子舞曲|电子乐|edm|house|techno|trance|dubstep|舞曲|跳舞|蹦迪|夜店|派对|聚会|party|club|clubbing|dance|dancing|future bass|electro|rave", { dance: 4, retro: 0.6 }, { v: 0.5, a: 0.9 });
style("genre", "电子|电子味|电子感|电子风|electronic|electronica", { retro: 2.2, dance: 2 }, { a: 0.3 });
style("genre", "disco|迪斯科", { dance: 3, retro: 2.5 }, { a: 0.7 });
style("usage", "运动|健身|跑步|撸铁|举铁|锻炼|训练|健身房|燃脂|瘦身|有氧|动感单车|骑行|滑板|极限运动|篮球|足球|比赛|赛事|体育|workout|gym|fitness|running|run|sport|sports|exercise|training|cardio|hiit", { dance: 3, rock: 1.8, hiphop: 1, epic: 0.8 }, { v: 0.4, a: 0.9 });
style("usage", "快剪|卡点|踩点|混剪|高能|炫酷|酷炫|酷|帅|潮|时尚|走秀|潮流|fashion|stylish|cool|swag|trendy", { dance: 2, hiphop: 2, retro: 0.8, rock: 0.5 }, { a: 0.6 });
style("genre", "嘻哈|说唱|hiphop|hip hop|rap|trap|boom bap|boombap|街舞|涂鸦|drill", { hiphop: 4.5 }, { a: 0.3 });
style("scene", "街头|urban|street", { hiphop: 2.6, chill: 0.5, retro: 0.4 });
style("emotion", "梦想|追梦|dream big", { epic: 1.6, corporate: 1.5, cinematic: 1.2, bright: 1 }, { v: 0.6, a: 0.4 });
style("scene", "奶茶|奶茶店|甜品|甜品店", { chill: 2, cute: 1.6, bright: 1.2 }, { v: 0.6 });
style("emotion", "鬼马", { cute: 3, jazz: 0.8 }, { v: 0.7, a: 0.5 });
style("genre", "beat|beats", { hiphop: 1.2, chill: 0.5 });
style("genre", "old school|oldschool", { hiphop: 2, retro: 2 });
style("genre", "摇滚|摇滚乐|朋克|金属|重金属|硬核|rock|punk|metal|hard rock|grunge|indie rock|alt rock|riff|失真", { rock: 4.5 }, { a: 0.9 });
style("genre", "乐队|live band|band", { rock: 2.5, acoustic: 0.8, jazz: 0.8 }, { a: 0.5 });
style("emotion", "浪漫|婚礼|结婚|求婚|告白|表白|情侣|恋爱|恋人|爱情|约会|纪念日|情人节|七夕|心动|love|romance|romantic|wedding|proposal|valentine|anniversary|couple|date", { romantic: 4 }, { v: 0.7, a: -0.3 });
style("emotion", "温馨|幸福|tender", { romantic: 2.6, acoustic: 1.5 }, { v: 0.7, a: -0.3 });
style("usage", "节日|新年|元旦|跨年|圣诞|圣诞节|庆典|庆祝|喜庆|欢庆|生日|开业|年会|团圆|喜事|红包|烟花|festival|festive|holiday|christmas|xmas|new year|celebration|celebrate|birthday|carnival", { festive: 4.5 }, { v: 0.9, a: 0.6 });
style("usage", "春节|过年|拜年|元宵|中秋|国庆|端午|chinese new year|lunar new year", { festive: 4.5, guofeng: 1.5 }, { v: 0.9, a: 0.6 });
style("usage", "万圣节|halloween", { tension: 2.5, cute: 1.5, festive: 1 });
/* ---------- game contexts ---------- */
style("game", "主菜单|菜单|标题画面|标题界面|开始界面|选关|大厅|menu|title screen|main menu|lobby", { dreamy: 2.2, chill: 1.4, chiptune: 0.8, cinematic: 1 }, { loop: true });
style("game", "城镇|村庄|小镇|村子|集市|town|village|market", { acoustic: 2.6, bright: 1.2, cute: 1, guofeng: 0.4 }, { v: 0.5 });
style("game", "tavern|inn|客栈", { acoustic: 2.2, jazz: 1.5, guofeng: 0.6 });
style("game", "探索|地图|大地图|世界地图|旷野|原野|森林|草原|冒险|开放世界|explore|exploration|overworld|world map|forest|adventure|field", { cinematic: 2.2, acoustic: 1.6, dreamy: 1.4, epic: 1.2, chiptune: 0.5 });
style("game", "地牢|地下城|洞穴|迷宫|遗迹|墓穴|废墟|dungeon|cave|maze|ruins|crypt|labyrinth", { tension: 3.5, ambient: 1.2, chiptune: 0.5 }, { v: -0.5, mode: "minor" });
style("game", "商店|商城|道具店|shop|store|shopping|merchant", { cute: 2.5, jazz: 1.8, bright: 1.5, chiptune: 0.6 }, { v: 0.6 });
style("game", "胜利|通关|过关|获胜|凯旋|庆功|victory|win|winning|fanfare|level up|升级|triumph", { epic: 2.6, festive: 2.4, bright: 1.5, chiptune: 1 }, { v: 0.9, a: 0.7, short: true, mode: "major" });
style("game", "失败|game over|gameover|战败|阵亡|死亡|defeat|defeated", { sad: 3, tension: 1.2, chiptune: 0.5 }, { v: -0.8, short: true, mode: "minor" });
/* ---------- eras ---------- */
style("era", "复古|年代感|老歌|retro|vintage|synthwave|合成器浪潮|赛博朋克|赛博|cyberpunk|cyber|霓虹|neon|outrun|new wave|newwave|磁带|卡带|vhs", { retro: 4.5 });
style("era", "蒸汽波|vaporwave", { retro: 3, chill: 2 });
style("era", "city pop|citypop", { retro: 3, jazz: 1.5, dance: 1 });
/* ---------- emotions and broad colours ---------- */
style("usage", "轻音乐|light music|easy listening", { acoustic: 2, romantic: 1.6, dreamy: 1.2, chill: 1 }, { a: -0.3 });
style("emotion", "欢快|快乐|开心|愉快|高兴|喜悦|欢乐|愉悦|明朗|开朗|元气|积极|正能量|乐观|happy|happier|cheerful|joyful|joy|upbeat|fun|positive|optimistic|feel good|carefree|无忧无虑", { bright: 2.6, cute: 0.8, festive: 0.5, acoustic: 0.5, chiptune: 0.5 }, { v: 0.9, a: 0.5, mode: "major" });
style("emotion", "轻松|easygoing|light hearted|lighthearted", { bright: 1.6, chill: 1.2, acoustic: 1 }, { v: 0.6, a: -0.1 });
style("emotion", "安静|宁静|静谧|平静|恬静|安宁|平和|祥和|quiet|calm|peaceful|serene|tranquil|stillness", { focus: 2, ambient: 1.5, dreamy: 0.8, chill: 0.8, acoustic: 0.5 }, { v: 0.2, a: -0.8, dim: "energy", dir: -1 });
style("emotion", "极简|minimal|minimalist", { focus: 2.5, ambient: 0.6 }, { dim: "complexity", dir: -1 });
style("emotion", "温柔|轻柔|柔和|柔美|soft|gentle", { romantic: 1.2, dreamy: 1, acoustic: 0.8, focus: 0.5 }, { v: 0.4, a: -0.6, dim: "energy", dir: -1 });
style("emotion", "优雅|高级|精致|格调|质感|高端|奢华|典雅|elegant|classy|luxury|luxurious|sophisticated", { jazz: 1.6, romantic: 1.5, cinematic: 1.5, corporate: 0.8 });
style("genre", "华尔兹|圆舞曲|waltz", { romantic: 2.5, cinematic: 1, jazz: 0.8 }, { unsupported: "暂不支持三拍子，按 4/4 拍编写" });
style("emotion", "希望|有希望|光明|憧憬|向往|hope|hopeful", { cinematic: 1.6, corporate: 0.8, acoustic: 0.8, romantic: 0.6 }, { v: 0.5, a: 0.1 });
style("scene", "夏天|夏日|海边|沙滩|海岛|夏威夷|热带|度假|beach|summer|tropical|island|vacation", { bright: 2.2, acoustic: 1.8, chill: 1, dance: 0.5 }, { v: 0.7, a: 0.3 });
style("scene", "自然|大自然|大海|海浪|山谷|群山|nature|ocean|sea|mountain|mountains", { cinematic: 1.6, ambient: 1.5, acoustic: 1.5, dreamy: 1.2 }, { a: -0.3 });
style("scene", "春天|春日|樱花|spring|sakura", { acoustic: 2, bright: 1.5, dreamy: 1, romantic: 0.8 }, { v: 0.6 });
style("scene", "秋天|秋日|落叶|autumn", { acoustic: 1.6, sad: 1.5, cinematic: 1, jazz: 0.8 }, { v: -0.2, a: -0.3 });
style("scene", "冬天|冬日|雪|下雪|雪夜|winter|snow|snowy", { dreamy: 1.8, festive: 1, sad: 1, ambient: 1, romantic: 0.6 }, { a: -0.4 });
style("scene", "城市|都市|街道|地铁|通勤|city|downtown|subway", { hiphop: 1.5, chill: 1.5, retro: 1, jazz: 1 });

/* ---------- instruments ---------- */
const inst = (terms: string, id: InstrumentId, w: Weights = {}, extra: Lex = {}) =>
  add(terms, { inst: id, w, ...extra });
inst("钢琴|piano|pianos|grand piano|三角钢琴|立式钢琴", "piano", { cinematic: 0.4, romantic: 0.4, focus: 0.3, sad: 0.3 });
inst("钢琴曲|钢琴小品|piano piece|piano music", "piano", { romantic: 1.7, cinematic: 1.4, focus: 1.2, sad: 0.5 });
inst("电钢琴|电钢|罗兹|rhodes|electric piano|e piano|epiano|wurlitzer", "epiano", { chill: 1, jazz: 0.8, hiphop: 0.4 });
inst("吉他|guitar|guitars|班卓|banjo|曼陀林|mandolin", "guitar", { acoustic: 1.8, rock: 0.4 });
inst("木吉他|民谣吉他|古典吉他|尼龙吉他|指弹|acoustic guitar|fingerstyle|nylon guitar", "guitar", { acoustic: 2.8 });
inst("尤克里里|ukulele|uke", "guitar", { acoustic: 1.6, bright: 1.4, cute: 0.6 }, { v: 0.5 });
inst("电吉他|失真吉他|electric guitar|distorted guitar|power chords", "guitar", { rock: 3 });
inst("合成器|合成器主音|电子音色|电音音色|锯齿波|synth|synths|synthesizer|synth lead|sawtooth", "synth", { retro: 1.2, dance: 0.8 });
inst("拨弦|电子拨弦|拨奏|pluck|plucks|pizzicato", "pluck", { corporate: 0.6, dreamy: 0.4 });
inst("竖琴|harp", "pluck", { dreamy: 1.2, romantic: 0.6 }, { note: "暂无竖琴音色，用电子拨弦代替" });
inst("钟琴|铃|铃铛|铃声|风铃|钢片琴|钟声|bell|bells|celesta|glockenspiel|chime|chimes", "bell", { dreamy: 0.8, festive: 0.6 });
inst("八音盒|音乐盒|music box|musicbox", "musicbox", { dreamy: 1.5, cute: 1.2, sad: 0.4 });
inst("马林巴|木琴|marimba|xylophone", "marimba", { cute: 1.2, bright: 0.5 });
inst("卡林巴|拇指琴|kalimba|钢鼓|steel drum", "marimba", { cute: 1, chill: 0.6 }, { note: "用马林巴音色近似" });
inst("颤音琴|电颤琴|vibraphone", "vibes", { jazz: 1.5, chill: 0.6 });
inst("长笛|flute|flutes|排箫|pan flute", "flute", { acoustic: 0.5, cinematic: 0.5, dreamy: 0.4 });
inst("竖笛|陶笛|ocarina|口哨|whistle|口琴|harmonica|单簧管|双簧管|clarinet|oboe|木管|woodwind", "flute", { acoustic: 0.6, cinematic: 0.4 }, { note: "用长笛音色近似" });
inst("弦乐|小提琴|大提琴|中提琴|提琴|弦乐四重奏|strings|string section|violin|violins|cello|viola", "strings", { cinematic: 1.3, romantic: 1, epic: 0.8, sad: 0.6 });
// "钢琴和弦乐" is piano + strings, not piano + 和弦 (chords)
inst("和弦乐|和弦乐队", "strings", { cinematic: 1.3, romantic: 1, epic: 0.8, sad: 0.6 });
inst("二胡|erhu", "strings", { guofeng: 3.5 }, { note: "暂无二胡音色，用弦乐近似" });
inst("古筝|guzheng|zither", "guzheng", { guofeng: 3.5 });
inst("琵琶|古琴|扬琴|阮|三弦|pipa|guqin|koto", "guzheng", { guofeng: 3.2 }, { note: "用古筝音色近似" });
inst("笛子|竹笛|笛|dizi|bamboo flute", "dizi", { guofeng: 3.5 });
inst("箫|洞箫|葫芦丝|巴乌|埙|尺八|xiao|shakuhachi", "dizi", { guofeng: 3.2 }, { note: "用竹笛音色近似" });
inst("唢呐|suona", "dizi", { festive: 2, guofeng: 2.5 }, { note: "暂无唢呐音色，用竹笛近似" });
inst("方波|芯片|chip|pulse wave|square wave|8 bit音色|8bit音色", "chip", { chiptune: 2.5 });
add("像素|像素风|8 bit|8bit|8位|红白机|chiptune|chip tune|芯片音乐", { inst: "chip" });
// The catalogue's own labels are one word each: "柔和钢琴" is the piano, never
// 柔和 (a mood) + 钢琴, and "8-bit 方波" never names the chiptune style.
const LABEL_BASE: Record<InstrumentId, string> = {
  piano: "钢琴",
  epiano: "电钢琴",
  guitar: "木吉他",
  synth: "合成器",
  pluck: "拨弦",
  bell: "钟琴",
  musicbox: "八音盒",
  marimba: "马林巴",
  vibes: "颤音琴",
  flute: "长笛",
  strings: "弦乐",
  guzheng: "古筝",
  dizi: "竹笛",
  chip: "方波",
};
for (const { id, label } of INSTRUMENT_LIST) {
  const key = label.toLowerCase().replace(/[-_]/g, " ").replace(/\s+/g, " ");
  if (!DICT.has(key))
    DICT.set(key, { inst: id, w: DICT.get(LABEL_BASE[id])?.w ?? {} });
}

add("萨克斯|萨克斯风|sax|saxophone", { cat: "genre", w: { jazz: 3.5 }, unsupported: "暂无萨克斯音色，保留该风格的主奏乐器" });
// sounds that are not instruments: said honestly instead of borrowing a style's lead
add("雨声|海浪声|浪声|鸟叫|鸟鸣|鸟叫声|虫鸣|蝉鸣|风声|雷声|水声|流水声|掌声|鼓掌声|欢呼声|笑声|脚步声|心跳声|钟表声|嘀嗒声|环境声|音效|sound effect|sound effects|sfx|rain sounds|birdsong|applause", { effect: true, unsupported: "暂时不能加入雨声、鸟叫、掌声这类环境音效，只能用乐器来表现" });
add("小号|长号|圆号|铜管|trumpet|trombone|brass|horn|horns", { cat: "genre", w: { epic: 1.6, jazz: 1.5 }, unsupported: "暂无铜管音色，保留该风格的主奏乐器" });
add("手风琴|accordion", { cat: "genre", w: { acoustic: 1.5, festive: 0.8 }, unsupported: "暂无手风琴音色，保留该风格的主奏乐器" });
add("人声|歌声|唱歌|演唱|歌词|哼唱|合唱|女声|男声|童声|吟唱|vocal|vocals|voice|singing|lyrics|choir|humming|chant|歌手", { unsupported: "只制作纯音乐，不包含人声和歌词" });
add("3/4拍|3/4|6/8拍|6/8|3拍子|三拍子|三拍", { unsupported: "暂不支持三拍子，按 4/4 拍编写" });

style("genre", "流行|流行乐|流行音乐|pop|pop music|k pop|kpop|j pop|jpop", { bright: 2.2, dance: 1.2, corporate: 0.8 }, { v: 0.5, a: 0.3 });
style("emotion", "抒情|lyrical|ballad|慢歌", { sad: 1.6, romantic: 1.6, cinematic: 0.8 }, { a: -0.4 });
style("emotion", "情歌|love song", { romantic: 3, sad: 0.8 }, { v: 0.4, a: -0.3 });
style("emotion", "幼稚|孩子气|childish", { cute: 2.5 }, { v: 0.5, a: 0.3 });
style("usage", "电梯音乐|elevator music|muzak", { jazz: 2.5, chill: 2 }, { a: -0.3 });
style("emotion", "躺平|摆烂|松弛感|citywalk|city walk|brunch", { chill: 2.6, acoustic: 0.8 }, { v: 0.3, a: -0.5 });
style("usage", "魔性|洗脑|上头", { cute: 1.6, dance: 1.6, chiptune: 0.8 }, { a: 0.6 });
style("genre", "drum and bass|drum & bass|drum n bass|drumz n bass|dnb|d&b|鼓打贝斯|jungle", { dance: 4, battle: 1.5 }, { a: 0.9, tempo: 170, arr: { drums: "breakbeat" } });
style("genre", "强力和弦|power chord|power chords", { rock: 2.5 }, { a: 0.5 });
style("genre", "808|采样|采样感|sample|sampled|sampling", { hiphop: 3 });
style("usage", "思绪|心流|沉浸|flow state|in the flow|deep work", { focus: 2.5, ambient: 0.5 }, { a: -0.4 });
style("emotion", "不协和|低沉|脉冲|收紧|dissonant|dissonance|pulsing", { tension: 2.2, cinematic: 0.4 }, { v: -0.4, mode: "minor" });
style("usage", "现代|前进感|有前进感|现代感|modern|forward looking", { corporate: 2.4, retro: 0.3 }, { v: 0.4, a: 0.2 });
add("刷子鼓|鼓刷|刷鼓|brushes|brushed drums|brush drums", { cat: "genre", w: { jazz: 2 }, arr: { drums: "swing" } });
add("三个版本|两个版本|几个版本|多个版本|各一版|各来一版|several versions|three versions|two versions", { unsupported: "一次只生成一个版本，想要别的版本可以接着说" });
add("撤销|撤销上一步|还原|回到上一版|上一版|上一个版本|换回去|改回去|原来的乐器|原来的音色|之前的乐器|原来那个|之前那个|刚才那个|undo|revert|go back", { unsupported: "我不能撤销上一步；之前的每个版本都保存在「我的作品」里，可以直接打开" });

/* ---------- mixer targets ---------- */
add("鼓点|鼓组|鼓声|鼓|架子鼓|打击乐|drums|drum|percussion|drumbeat", { target: "drums" });
add("低音|贝斯|贝司|低频|bass|bassline|sub bass", { target: "bass" });
add("主旋律|旋律|主奏|主音|melody|lead|topline", { target: "melody" });
add("和弦|和声|伴奏|chords|chord|harmony|accompaniment|comping", { target: "chords" });
add("混响|残响|回声|空间|reverb|echo", { target: "reverb" });
add("速度|节奏|拍速|节拍|速率|bpm|tempo|pace|节凑|bmp", { target: "tempo" });
// the inspector's own labels come first: "旋律丰富度" is not the melody fader
add("情绪能量|力度|能量|强度|动态|情绪|energy|intensity|dynamics", { target: "energy" });
add("旋律丰富度|丰富度|丰富程度|复杂度|复杂程度|音符|编曲|配器|complexity|notes|arrangement", { target: "complexity" });
add("空间混响|混响量|reverb amount", { target: "reverb" });
add("音调|调子|音高|调门|调性|pitch", { pitch: true });
add("时长|长度|总长|总长度|全长|总时长|时间长度|length|duration|runtime", { about: "duration" });

/* ---------- negation, change and list words ---------- */
add("不要|不用|不想要|不需要|不能有|不要有|不要用|别要|别用|别带|别加|别有|别|没有|没|无|去掉|去除|移除|删掉|删除|拿掉|取消|不带|不含|不加|免|避免|关闭|关掉|关了|停掉|no|without|not|don't|dont|do not|remove|drop|exclude|avoid|kill|turn off|disable|don't use|dont use|do not use|never use|not using|no more|不使用|不采用|别使用", { neg: "hard" });
add("千万别是|千万别|千万不要|拒绝|讨厌|不喜欢|不想听|不希望|不要像|别像|不像是|别搞得跟|别搞得像|别弄得跟|别弄得像|别整得跟|别做得像|不要搞得像|不要弄得像|anything but|non|nothing|don't want|dont want|do not want|don't like|dont like|do not like|i hate|hate|受不了|不想听到|不想要|lose|ditch|get rid of|take out", { neg: "hard" });
// "不是鼓的问题", "除了鼓": what something is not — a style can be excluded this way, a part is not removed
add("不是|并非|并不是|而非|而不是|不算|不能是|别是|除了|isn't|isnt|aren't|arent|is not|are not|except", { neg: "hard", copula: true });
add("代替|替换掉|取代|instead of|in place of|rather than", { neg: "hard" });
add("不", { neg: "hard", bare: true });
add("不要太|别太|不能太|不用太|不要那么|别那么|不要这么|别这么|不要过于|not too|not so|less of|不那么|没那么|没有那么|不太|不怎么|不是很|不是那么|不是特别|别过于|not that|not as|not very", { neg: "too" });
add("静音|mute|muted|off", { op: "mute", side: "both" });
add("换成|改成|改为|换为|变成|做成|切换到|切换成|切到|切成|换到|改用|换个|换一个|换一种|换种|来个|来一个|来首|来一首|来段|来一段|change to|switch to|make it|turn it into|convert to|变为|转成|转为|换回|改回|变回|弄成|整成|replace with|swap to|swap for", { change: true });
add("风格|曲风|风|style|genre|vibe|vibes|感觉|味道|味|范儿|调调|feel|feeling", { suffix: true });
add("元素|色彩|flavor|flavour|touch of|hint of|一丝|些许|一抹|略带|稍带|夹杂", { flavour: true });
// "欢快为主，偶尔忧伤", "七分欢快三分忧伤", "略显悲伤但整体欢快": the lesser of two moods
add("偶尔|略显|淡淡的|淡淡|隐约|微微|三分|两分|二分|有时|a hint of|a trace of|slightly|occasionally", { flavour: true });
/* ---------- what a clause is: context, resemblance, wish ---------- */
add("这是给|是给|给我家|给我的|用在|用于|用来|放在|拿来|配的|用的|听的|看的|适合|适用于|适于|视频是|是讲|讲的是|是关于|客户说|老板说|朋友说|同事说|领导说|甲方说|导演说|this is for|it's for|its for|it is for|used for|used in|for my|for a|for the|suitable for|good for|my client says|my boss says", { ctx: true });
add("像|像是|好像|类似|类似于|听起来像|听着像|听上去像|sounds like|sound like|like a|like an|似的|一样|那样", { like: true });
add("想要|我要|希望|让它|让这首|让音乐|i want|i'd like|i would like|make it sound", { want: true });
add("别的乐器|其他乐器|其它乐器|别的|其他|其它|别的音色|another instrument|something else|other instrument", { other: true });
add("不好听|难听|不喜欢这个|不满意|不行|不对劲|不太行|don't like it|dont like it|sounds bad", { dislike: true });
add("保持|保持不变|不变|别动|不要动|别改|不要改|留着|keep|unchanged|as is|stay the same", { keep: true });
add("这种感觉|那种感觉|这种风格|这种味道|这个感觉|这个味道|这种|那种|这样|那样的|这样的|like that|like this", { that: true });
add("恢复默认|恢复风格默认|按风格来|全部恢复|恢复全部|都恢复|全都恢复|reset|reset all|restore all|restore everything", { reset: "all" });
add("恢复默认音量|音量恢复默认|默认音量|reset volumes|reset the mix", { reset: "volumes" });
add("和|与|跟|及|以及|还有|、|and|&|or|plus", { link: true });
add("但|但是|不过|而是|只是|然后|同时|并且|but|however|though|then|用|使用|采用|use|using|with|instead", { brk: true });

/* ---------- level words ---------- */
add("大|响|强|多|高|猛|足|突出|明显|靠前|往前|往前放|往前靠|louder|boost|boosted|higher|stronger|up|upfront|forward", { op: "up", side: "post" });
add("小|弱|少|低|淡|靠后|往后|往后放|往后靠|quieter|softer|lower|down|further back", { op: "down", side: "post" });
// "低频太多了", "鼓太少": said of a part, the direction is fixed
add("太多|太多了|过多|too much|too many", { op: "down", side: "both", fixed: true });
add("太少|太少了|过少|too little|too few", { op: "up", side: "both", fixed: true });
add("提高|增加|加强|加重|加大|提升|调高|调大|拉高|拉大|强调|放大|升高|升|more|raise|increase|turn up|bring up|crank up|加强一下|上调|往上|往上调|往上提|往上拉|向上|上去|涨|开大|推高|抬高|提一提|加一加|推一推|再来点|再来一点|再多点|再多一点|再加点|再加一点|loud", { op: "up", side: "both" });
// "能量不足", "听不到贝斯", "钢琴被淹没了": too little of it, whatever stands around
add("不足|不太足|欠缺|听不清|听不到|听不见|听不出|被淹没|被盖住|被压住|淹没了|太靠后", { op: "up", side: "both", fixed: true });
add("more|increase|raise", { op: "up", side: "pre" });
add("降低|减少|减弱|减小|压低|调低|调小|拉低|收一下|收一点|削弱|降|减|less|reduce|turn down|bring down|tone down|小声|decrease|minus|下调|往下|往下调|往下降|往下拉|向下|下去|下降|收小|收一收|收|压一压|压一下|降一降|减一减", { op: "down", side: "both" });
add("less|reduce", { op: "down", side: "pre" });
add("突出|boost|louder", { op: "up", side: "both" });
add("quieter|softer|lower", { op: "down", side: "both" });
add("quieter|softer|calmer", { dim: "energy", dir: -1 });
add("louder", { dim: "energy", dir: 1 });
add("少来点|少放点", { op: "down", side: "pre" });
add("少一点|少点|少一些|少些", { op: "down", side: "both" });
// "不够燃", "旋律不够突出": more of it, please
add("不够|还不够|不太够|还是不够|not enough", { mod: "more" });
add("恢复|打开|开启|加回|加回来|加上|加入|带上|要有|保留|unmute|enable|bring back|turn on|restore|回来|on|加回去|放回来|add back|少不了|缺不了|离不开|必须有|必须要有|一定要有|得有|must have", { op: "unmute", side: "both" });
add("back|back in|back on", { op: "unmute", side: "post" });
add("加|加点|加一点|加些|加一些|来点|来一点|多来点|多加点|加点儿|add|add some|add a bit of|some more", { op: "add", side: "pre", flavour: true });
// "多一点鼓" and "情绪能量多一点"
add("多点|多一点|多一些|多些", { op: "add", side: "both", flavour: true });
add("带点|带一点|有点|一点点的|稍带|a touch of|a bit of|a little", { flavour: true });
add("只要|只留|只保留|只剩|只听|只有|仅保留|只用|solo|only|just", { op: "only", side: "both", solo: true });
add("纯|独奏|清弹", { solo: true });
add("纯音乐|instrumental|背景音乐|bgm|配乐|音乐|music|曲子|歌曲|song|track|一首|一段|一个", {});

/* ---------- modifiers ---------- */
add("太|过于|太过|有点太|too|overly|嫌|嫌它|还是太|实在太|way too|far too", { mod: "too" });
add("更|再|更加|还要|一点|一些|点|些|一点儿|点儿|more of|a bit more", { mod: "more" });
add("稍微|稍|略|略微|一点点|一丢丢|slightly|a bit|a little|a little bit|a tad", { mod: "slight" });
// "有点吵" is a complaint when refining and a mild wish in a new description
add("有点|有些|有一点|有点儿|kind of|kinda", { mod: "somewhat" });
add("很多|得多|许多|大幅|明显地|非常多|a lot|much|way|far|significantly", { mod: "lot" });
add("很|非常|特别|超|超级|极|极其|十分|相当|very|really|super|extremely", { mod: "very" });

/* ---------- tempo, energy, complexity, reverb adjectives ---------- */
add("慢|slow|slower|放慢|慢下来|slow down|缓|降速|减速|减慢|调慢|slow it down|slow things down|拖|拖沓|拖拉|磨叽", { dim: "tempo", dir: -1 });
add("快|fast|faster|加快|加速|提速|speed up|quicker|quick|调快|speed it up|speed things up|赶|急促|匆忙", { dim: "tempo", dir: 1 });
add("拖沓|拖拉|磨叽", { dim: "tempo", dir: 1, fixed: true });
add("急促|匆忙", { dim: "tempo", dir: -1, fixed: true });
add("要快|快的|快一些的|要慢|慢的", {});
add("要快|快的", { dim: "tempo", dir: 1 });
add("要慢|慢的", { dim: "tempo", dir: -1 });
add("很慢|非常慢|特别慢|极慢|超慢|慢板|adagio|largo|very slow", { dim: "tempo", dir: -1, pos: 0, a: -0.6 });
add("舒缓|缓慢|慢速|慢节奏|慢歌|徐缓|悠扬|slow tempo|downtempo", { dim: "tempo", dir: -1, pos: 0.2, a: -0.5 });
add("中速|中等速度|中板|moderato|mid tempo|midtempo|moderate", { dim: "tempo", dir: 1, pos: 0.5 });
add("轻快|明快|allegretto|brisk", { dim: "tempo", dir: 1, pos: 0.68, w: { bright: 1.6, acoustic: 0.6, cute: 0.6 }, cat: "emotion", v: 0.6, a: 0.4 });
add("快节奏|快速|节奏快|高速|快板|uptempo|up tempo|allegro|fast paced", { dim: "tempo", dir: 1, pos: 0.85, a: 0.6 });
add("飞快|极快|超快|很快|非常快|特别快|急速|疾速|presto|very fast|越快越好|as fast as possible", { dim: "tempo", dir: 1, pos: 1, a: 0.8 });
add("越慢越好|as slow as possible", { dim: "tempo", dir: -1, pos: 0, a: -0.6 });
add("有活力|活力|更强|强烈|有力量|有力|劲爆|带感|炸|嗨|热烈|澎湃|激烈|有冲击力|energetic|powerful|intense|punchy|harder|heavier|driving|hype|aggressive|有劲|带劲|力量|力量感|冲击力|张力|重|爆发|爆发力|抢戏|抢镜|喧宾夺主|distracting|热闹|喧闹|闹腾|lively and loud", { dim: "energy", dir: 1, a: 0.6 });
add("燃|燃向|很燃|超燃|高燃|热血|激昂", { dim: "energy", dir: 1 });
add("轻|克制|内敛|低调|收敛|淡淡|subtle|restrained|understated|laid back", { dim: "energy", dir: -1 });
add("吵|太吵|嘈杂|刺耳|闹|太闹|太炸|noisy|harsh|too loud|太响|抢|太抢", { dim: "energy", dir: -1, fixed: true });
add("闷|太闷|没劲|没精神|无力|太软|lifeless|weak|too soft", { dim: "energy", dir: 1, fixed: true });
add("简单|简洁|简约|稀疏|稀|疏|干净|清爽|留白|simple|simpler|sparse|sparser|cleaner|less busy|less complex", { dim: "complexity", dir: -1 });
add("丰富|复杂|密集|层次|有层次|层次感|饱满|华丽|花哨|细节|变化|起伏|跌宕|rich|richer|complex|busier|layered|more layers|more notes|intricate|更多音符|密|紧凑|dense|denser", { dim: "complexity", dir: 1 });
add("单调|太单调|无聊|太无聊|平淡|太平淡|乏味|枯燥|太重复|重复感|boring|monotonous|dull|repetitive|too flat", { dim: "complexity", dir: 1, fixed: true });
add("乱|太乱|杂乱|太满|太花|太杂|messy|cluttered|too busy", { dim: "complexity", dir: -1, fixed: true });
add("空间感|空旷|宽广|大厅感|教堂|hall|cathedral|spacious|roomy|wet|wetter|湿|更多混响|增加混响", { dim: "reverb", dir: 1 });
add("干|更干|贴耳|dry|drier|intimate|减少混响|less reverb|混响少", { dim: "reverb", dir: -1 });
add("太干|干巴巴|too dry", { dim: "reverb", dir: 1, fixed: true });
add("空灵|ethereal", { dim: "reverb", dir: 1 });
add("太湿|太糊|糊|浑浊|太空旷|muddy|too wet|washed out", { dim: "reverb", dir: -1, fixed: true });
add("明亮|brighter|bright", { cat: "emotion", w: { bright: 1.5, acoustic: 0.5 }, v: 0.6, mode: "major", dim: "energy", dir: 1 });
add("亮", { mode: "major", dim: "energy", dir: 1 });
add("暗|darker", { mode: "minor", dim: "energy", dir: -1 });
add("大调|major key|in major", { mode: "major" });
add("小调|minor key|in minor", { mode: "minor" });
add("长|longer|long|加长|延长|拉长|extend|lengthen", { length: 1 });
add("短|shorter|short|缩短|shorten|剪短", { length: -1 });
add("关系小调|平行小调|relative minor", { relative: "minor" });
add("关系大调|平行大调|relative major", { relative: "major" });
/* ---------- amounts written as words ---------- */
add("一半|减半|砍半|对半|half|halve|in half|by half", { qty: { unit: "x", value: 0.5 } });
add("半速|half speed|half tempo|half time tempo", { qty: { unit: "x", value: 0.5, about: "tempo" } });
add("一倍|翻倍|加倍|翻一倍|两倍|double|twice", { qty: { unit: "x", value: 2 } });
add("拉满|开到最大|调到最大|最大|到头|maxed|max|maximum|最高", { qty: { unit: "%", value: 100 } });
add("调到最小|调到最低|关到最小|最小|最低|minimum", { qty: { unit: "%", value: 0 } });

/* ---------- loop, new take, arrangement ---------- */
add("循环|无缝循环|无缝|可循环|循环播放|游戏循环|首尾相接|loop|loops|loopable|looping|looped|seamless", { loop: true });
add("不要结尾|不需要结尾|不用结尾|去掉结尾|没有结尾|无结尾|别要结尾|no ending|without an ending", { loop: true });
add("不循环|非循环|完整结尾|有结尾|有个结尾|带结尾|完整的结尾|自然结尾|结尾渐弱|渐弱结尾|淡出|渐出|渐弱|收尾|完整版|有始有终|要有结尾|要有个结尾|要结尾|需要结尾|需要一个结尾|需要有结尾|有明确的结尾|明确的结尾|加个结尾|加一个结尾|结尾要自然|自然的结尾|自然收尾|要收住|收住|non loop|one shot|fade out|with an ending|with an outro|needs an ending|proper ending|a real ending", { loop: false });
// another go at the piece: a new melody only when the message asks for nothing else
add("换一版|换个版本|换一个版本|重新来|重来|再来一个|再来一首|再来一版|再来一遍|再做一个|再做一版|另一个版本|另一版|换一首|another take|another version|another one|one more take|one more version|try again|once more|再来|再来一次|再试一次|再给我一个|重做|重做一个|重新做|do it again|one more time", { seed: "again" });
// "换一版爵士的": another go that names what it should be
add("换一版|换个版本|换一个版本|另一个版本|另一版|来一版", { change: true });
add("换个旋律|换一个旋律|换旋律|换一版旋律|换一版新旋律|新旋律|新的旋律|旋律换一个|旋律换掉|旋律重写|重写旋律|重新编曲|重新生成|不一样的旋律|另一个旋律|另一段旋律|不同的旋律|换一段旋律|换段旋律|换一段新的旋律|换一段新旋律|new melody|different melody|another melody|reroll|re roll|regenerate|rewrite the melody|different tune|new tune|another tune", { seed: "melody" });
add("铺底|长音铺底|弦乐铺底|氛围铺底|垫音|铺垫|pad|pads", { arr: { pad: true } });
add("琶音|分解和弦|arp|arps|arpeggio|arpeggios", { arr: { arp: true } });
add("副旋律|对位|对旋律|第二旋律|counter melody|countermelody|counterpoint", { arr: { counter: true } });
add("沙锤|铃鼓|拍手|手鼓|康加|邦戈|小打|shaker|tambourine|clap|claps|congas|bongos", { arr: { perc: true } });
add("摇摆|摇摆感|swing|swung", { arr: { swing: 0.5 }, cat: "genre", w: { jazz: 2.5 } });
add("shuffle|舞步感", { arr: { drums: "shuffle" } });
add("四四拍底鼓|四拍底鼓|四踩|四四拍|4/4底鼓|four on the floor|4 on the floor|four to the floor", { arr: { drums: "fourfloor" } });
add("半拍|half time|halftime", { arr: { drums: "halftime" } });
add("碎拍|breakbeat|breakbeats|breaks", { arr: { drums: "breakbeat" } });
add("进行曲|行军|march|marching", { arr: { drums: "march" }, cat: "genre", w: { epic: 2, festive: 1 } });
add("走路贝斯|行走贝斯|行走低音|walking bass|walking bassline", { arr: { bass: "walking" } });
add("八度贝斯|octave bass", { arr: { bass: "octave" } });
add("持续低音|pedal bass|pedal tone", { arr: { bass: "pedal" } });
add("切分贝斯|syncopated bass", { arr: { bass: "syncopated" } });
add("高八度|升八度|高一个八度|octave up|higher octave|高音区", { arr: { register: "high" } });
add("低八度|降八度|低一个八度|octave down|lower octave|低音区", { arr: { register: "low" } });
add("前奏|间奏|尾奏|结尾|副歌|高潮|主歌|开头|中段|桥段|前半段|后半段|前半|后半|中间部分|intro|outro|chorus|verse|bridge|drop|后面|前面|中间|中间那段|最后|一开始|刚开始|末尾|结尾处|开头处|前段|后段|那一段|这一段|at the end|at the start|at the beginning|in the middle", { section: true });

/* ---------- words that only stop a shorter word from matching inside them ---------- */
add("特别|区别|别致|无限|无人|无敌|无所谓|免费|没想到|没关系|有没有|鼓励|鼓掌|一鼓作气|畅快|爽快|痛快|凉快|快活|快感|快递|快餐|快手|快门|尽快|赶快|慢慢|慢生活|傲慢|年轻|轻盈|减轻|轻奢|沉重|厚重|重要|重复|重新|尊重|庄重|隆重|稳重|重逢|注重|重点|盛大|伟大|强大|大海|大片|大家|大约|大概|最大|巨大|大学|大作|高大上|远大|小孩|小朋友|小众|小夜曲|小品|小日子|小确幸|小红书|小视频|短小|短视频|短片|长镜头|长大|成长|漂亮|响亮|高兴|高山|高级感|低谷|多彩|多么|少女|少年感|淡雅|暗恋|干杯|湿润|点击|点赞|一些人|有些|风景|风吹|风雨|微风|晚风|春风|台风|味觉|空气|空中|天空|时空|节奏感|音乐节|电子邮件|产品经理|月亮|天亮|点亮|照亮|闪亮|长短|长久|漫长|长夜|长安|潮汐|浪潮|热潮|a minor detail|in a minute|no problem|not sure|for a|on the|on a|up to|调整|大调整|小调整|微调|one more thing|不错|不过|不如|不同|不仅|不但|不管|不断|不止|不然|不久|不知道|不确定|不一定|不一样|不可以|不可能|不小心|不好意思|不客气|不得不|不停|不见|不了|不会|不突兀|不知不觉|不可思议|图像|影像|想象|想像|头像|偶像|肖像|录像|画像|雕像|好听|升级版|降临|降落|减肥|减压|加油|加班|满足|圆满|充满|满满|大小|多少|高低|强弱|快慢|半音|全音|要不要|好不好|行不行|能不能|可不可以|是不是|对不对|差不多|了不起|来不及|忍不住|用不着|说不定|要不然|只不过|不得了|不好说", {});

export const STYLE_COORDS: Record<StyleId, [number, number]> = {
  bright: [0.8, 0.5],
  chill: [0.3, -0.5],
  cinematic: [-0.1, 0],
  dreamy: [0.3, -0.6],
  focus: [0.1, -0.6],
  retro: [0.2, 0.5],
  epic: [0.2, 0.9],
  chiptune: [0.7, 0.7],
  guofeng: [0.1, -0.3],
  jazz: [0.3, -0.1],
  acoustic: [0.6, -0.2],
  tension: [-0.8, 0.3],
  cute: [0.9, 0.5],
  battle: [-0.2, 1],
  ambient: [0.1, -0.9],
  corporate: [0.5, 0.3],
  sad: [-0.8, -0.6],
  dance: [0.5, 0.9],
  hiphop: [0, 0.3],
  rock: [0.1, 0.9],
  romantic: [0.7, -0.4],
  festive: [0.9, 0.7],
};

/** Leads to try, in order, when a style's own lead was excluded by the user. */
export const STYLE_LEADS: Record<StyleId, InstrumentId[]> = {
  bright: ["piano", "guitar", "marimba"],
  chill: ["epiano", "guitar", "vibes"],
  cinematic: ["piano", "strings", "flute"],
  dreamy: ["bell", "musicbox", "flute"],
  focus: ["piano", "guitar", "vibes"],
  retro: ["synth", "pluck", "epiano"],
  epic: ["strings", "piano", "flute"],
  chiptune: ["chip", "pluck", "synth"],
  guofeng: ["guzheng", "dizi", "flute"],
  jazz: ["vibes", "epiano", "guitar"],
  acoustic: ["guitar", "piano", "flute"],
  tension: ["strings", "piano", "bell"],
  cute: ["marimba", "musicbox", "pluck"],
  battle: ["synth", "strings", "guitar"],
  ambient: ["bell", "flute", "strings"],
  corporate: ["pluck", "piano", "guitar"],
  sad: ["piano", "strings", "guitar"],
  dance: ["synth", "pluck", "bell"],
  hiphop: ["epiano", "vibes", "pluck"],
  rock: ["guitar", "synth", "piano"],
  romantic: ["piano", "strings", "guitar"],
  festive: ["bell", "marimba", "piano"],
};

/* ---------- normalisation ---------- */

const CN_DIGIT: Record<string, number> = {
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};
const CN_NUM = "[零〇一二两三四五六七八九十百]+";

/** "两" → 2, "九十" → 90, "一百二" → 120, "九零" → 90. */
export function parseChineseNumber(text: string): number {
  if (!/[十百]/.test(text))
    return Number([...text].map((ch) => CN_DIGIT[ch] ?? 0).join(""));
  let total = 0;
  let current = 0;
  let pending = false;
  let lastUnit = 1;
  let sawZero = false;
  for (const ch of text) {
    if (ch === "十" || ch === "百") {
      const unit = ch === "十" ? 10 : 100;
      total += (pending ? current : 1) * unit;
      current = 0;
      pending = false;
      lastUnit = unit;
      sawZero = false;
    } else if (ch === "零" || ch === "〇") sawZero = true;
    else {
      current = CN_DIGIT[ch] ?? 0;
      pending = true;
    }
  }
  if (pending) total += current * (lastUnit === 100 && !sawZero ? 10 : 1);
  return total;
}

/**
 * Full-width → half-width, typographic quotes, hyphens between latin words →
 * spaces, and Chinese numerals → digits where they are clearly a quantity
 * (before a time unit, or after a tempo word). "慢一点" keeps its "一".
 */
export function normalizeText(input: string): string {
  let out = "";
  for (const ch of input) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 0x3000) out += " ";
    else if (code >= 0xff01 && code <= 0xff5e)
      out += String.fromCharCode(code - 0xfee0);
    else out += ch;
  }
  return out
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/♯/g, "#")
    .replace(/♭/g, "b")
    // "lo-fi", "8-bit" are words; "90-100" stays a range
    .replace(/(?<=[a-z])[-_](?=[a-z0-9])|(?<=[0-9])[-_](?=[a-z])/gi, " ")
    // "45 more seconds" → "45 seconds more"
    .replace(
      /(\d+)\s+(more|extra|additional|fewer|less)\s+(seconds?|secs?|minutes?|mins?|bpm)\b/gi,
      "$1 $3 $2",
    )
    .replace(/[\t\r\f\v ]+/g, " ")
    .trim()
    // "鼓 小 一 点": characters typed one by one
    .replace(/(?:[一-鿿] ){2,}[一-鿿](?![一-鿿])/g, (m) => m.replace(/ /g, ""))
    // "慢慢慢慢一点", "快快快": said with emphasis, meant once
    .replace(/([一-鿿])\1{2,}/g, "$1")
    .replace(
      new RegExp(
        `${CN_NUM}(?=\\s*(?:分钟|分半|分\\s*[\\d零〇一二两三四五六七八九十]+\\s*秒|秒|年代|小节|个半分钟|个?\\s*bpm|个半音|个全音))`,
        "g",
      ),
      (m) => String(parseChineseNumber(m)),
    )
    // "一百四十拍", "快十拍": a tempo in numerals ("四四拍", "三拍子" are metres)
    .replace(new RegExp(`${CN_NUM}(?=\\s*拍(?![子底/号手]))`, "g"), (m) => {
      const value = parseChineseNumber(m);
      return value >= 5 && m !== "四四" ? String(value) : m;
    })
    // "七成", "两倍": tenths and factors ("一倍" stays a word: 快一倍 is twice as fast)
    .replace(
      /[二两三四五六七八九十](?=\s*(?:成(?![为了功熟长立品年员分果就绩本交都语套人])|倍))/g,
      (m) => String(parseChineseNumber(m)),
    )
    .replace(
      new RegExp(
        `((?:速度|节拍|拍速|bpm|tempo|每分钟|百分之)\\s*(?:设?为|调?到|降到|升到|提到|改成?|是|=|:)?\\s*)(${CN_NUM})`,
        "gi",
      ),
      (_m, head: string, num: string) => head + parseChineseNumber(num),
    );
}

/* ---------- keys ---------- */

const LETTER_PC: Record<string, number> = {
  c: 0,
  d: 2,
  e: 4,
  f: 5,
  g: 7,
  a: 9,
  b: 11,
};
const KEY_NAMES = { major: new Map<number, string>(), minor: new Map<number, string>() };
for (const key of KEYS) {
  const parsed = parseKey(key);
  KEY_NAMES[parsed.minor ? "minor" : "major"].set(parsed.tonic, key);
}

/** Catalog spelling for a tonic pitch class and mode, e.g. (6, "minor") → "F# minor". */
export function keyName(tonic: number, mode: "major" | "minor"): string {
  return KEY_NAMES[mode].get(((tonic % 12) + 12) % 12) ?? `C ${mode}`;
}
/** Same tonic, other mode ("F major" → "F minor"). */
export function withMode(key: string, mode: "major" | "minor"): string {
  return keyName(parseKey(key).tonic, mode);
}

const pitchClass = (letter: string, accidental: string | undefined) => {
  const shift = !accidental
    ? 0
    : /升|#|sharp/.test(accidental)
      ? 1
      : -1;
  return LETTER_PC[letter.toLowerCase()] + shift;
};

interface Span {
  start: number;
  end: number;
}

/** A key signature written as a key: "C大调", "升F小调", "降B大调", "F# minor", "key of D". */
function findKey(text: string): (Span & { key: string }) | undefined {
  // "bB大调", "#F小调": the accidental written in front of a capital letter
  const front = /(?<![A-Za-z#])([b#])([A-G])\s*(大调|小调|调(?!性))/.exec(text);
  if (front)
    return {
      start: front.index,
      end: front.index + front[0].length,
      key: keyName(
        pitchClass(front[2], front[1]),
        front[3] === "小调" ? "minor" : "major",
      ),
    };
  // "Am 调", "F#m 调": a chord-style name for a minor key
  const chord = /(?<![A-Za-z#])([A-G])([#b])?m\s*调(?!性)/.exec(text);
  if (chord)
    return {
      start: chord.index,
      end: chord.index + chord[0].length,
      key: keyName(pitchClass(chord[1], chord[2]), "minor"),
    };
  const cn = /(?<![A-Za-z])(升|降)?\s*([A-Ga-g])\s*([#b])?\s*(大调|小调)/.exec(
    text,
  );
  if (cn)
    return {
      start: cn.index,
      end: cn.index + cn[0].length,
      key: keyName(
        pitchClass(cn[2], cn[1] ?? cn[3]),
        cn[4] === "小调" ? "minor" : "major",
      ),
    };
  const pattern =
    /(?<![A-Za-z#])([A-Ga-g])(#|b|\s+sharp|\s+flat)?\s*(major|minor|maj|min)(?![A-Za-z])/g;
  for (let m = pattern.exec(text); m; m = pattern.exec(text)) {
    const [, letter, accidental, word] = m;
    const before = text.slice(0, m.index);
    const after = text.slice(m.index + m[0].length);
    if (/^(maj|min)$/.test(word) && letter !== letter.toUpperCase()) continue;
    if (letter === "a" && !accidental) {
      // "a minor detail": the article, unless it is clearly announced as a key
      // "in a minor key" asks for the minor mode, not for A minor
      const cued =
        !/^\s*(?:key|scale)/i.test(after) &&
        (/(?:key of|key|调性?)\s*[:=]?\s*$/i.test(before) ||
          /^\s*调/.test(after) ||
          (/\bin\s*$/i.test(before) && /^\s*(?:$|[,.;!?。])/.test(after)));
      if (!cued) continue;
    }
    return {
      start: m.index,
      end: m.index + m[0].length,
      key: keyName(
        pitchClass(letter, accidental?.trim()),
        word.startsWith("min") ? "minor" : "major",
      ),
    };
  }
  const bare =
    /(?:key of|key:)\s*([A-G])(#|b)?(?![A-Za-z#])|(?<![A-Za-z])([A-G])(#|b)?\s*调(?!性)/.exec(
      text,
    );
  if (bare)
    return {
      start: bare.index,
      end: bare.index + bare[0].length,
      key: keyName(pitchClass(bare[1] ?? bare[3], bare[2] ?? bare[4]), "major"),
    };
  return undefined;
}

/* ---------- numbers: eras, tempo, duration ---------- */

const ERA_WEIGHTS: Record<number, Weights> = {
  0: { dance: 1.5, hiphop: 1.5 },
  10: { dance: 1.5, hiphop: 1.5 },
  20: { jazz: 3, retro: 1 },
  30: { jazz: 3, retro: 1 },
  40: { jazz: 3, retro: 1 },
  50: { jazz: 2, rock: 1.5, retro: 1 },
  60: { rock: 1.8, retro: 1.5, jazz: 1 },
  70: { retro: 2.2, dance: 2, jazz: 1.5 },
  80: { retro: 4.5, dance: 0.8 },
  90: { retro: 2.8, hiphop: 1, dance: 1, chiptune: 0.5 },
};
const ERA_CONTEXT =
  /复古|怀旧|年代|风|synthwave|retro|disco|vibe|style|pop|rock|funk|music|nostalg|金曲|迪斯科|hip hop|rap|r&b|dance|hits|sound|era|feel|老歌/;
const DURATION_CUE = /(?:时长|长度|duration|length|共|总长|长)\s*[:=]?\s*$/;

export interface Analysis {
  /** normalised request, case preserved */
  text: string;
  /** lower-case copy of `text` with every parsed number blanked out */
  lower: string;
  tokens: Token[];
  /**
   * The first tempo and the first length the text names, as written. Whether
   * each is a new total, a change ("快 10 bpm") or a point in time ("第 20 秒")
   * is decided by the clause it stands in; the caller also clamps.
   */
  bpm?: number;
  duration?: number;
  key?: string;
}

const BLANK = "\u0001";
const WORD = /[a-z0-9]/;

const INDEX = new Map<string, string[]>();
for (const term of DICT.keys()) {
  const list = INDEX.get(term[0]) ?? [];
  list.push(term);
  INDEX.set(term[0], list);
}
for (const list of INDEX.values()) list.sort((a, b) => b.length - a.length);

/** Leftmost-longest dictionary scan; latin words must stand alone. */
export function tokenize(lower: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < lower.length) {
    let hit: string | undefined;
    for (const term of INDEX.get(lower[i]) ?? []) {
      if (!lower.startsWith(term, i)) continue;
      const end = i + term.length;
      if (WORD.test(term[0]) && i > 0 && WORD.test(lower[i - 1])) continue;
      if (
        WORD.test(term[term.length - 1]) &&
        end < lower.length &&
        WORD.test(lower[end])
      )
        continue;
      hit = term;
      break;
    }
    if (hit) {
      const lex = DICT.get(hit);
      if (lex)
        tokens.push({ start: i, end: i + hit.length, text: hit, lex });
      i += hit.length;
    } else i++;
  }
  return tokens;
}

/** Read one request: numbers first (so "80s" is never 80 seconds), then words. */
export function analyse(input: string): Analysis {
  const text = normalizeText(input);
  // lower-case without changing the length, so spans stay valid in both copies
  let lower = [...text]
    .map((ch) => (ch.toLowerCase().length === ch.length ? ch.toLowerCase() : ch))
    .join("");
  const extra: Token[] = [];
  const blank = (span: Span) => {
    lower =
      lower.slice(0, span.start) +
      BLANK.repeat(span.end - span.start) +
      lower.slice(span.end);
  };
  const result: Analysis = { text, lower, tokens: [] };

  // every key the text names, in order ("别用 A 小调，用 D 小调")
  for (let found = findKey(text), guard = 0; found && guard < 8; guard++) {
    result.key ??= found.key;
    extra.push({
      start: found.start,
      end: found.end,
      text: lower.slice(found.start, found.end),
      lex: { key: found.key },
    });
    blank(found);
    const rest = findKey(
      text.slice(0, found.end).replace(/[^]/g, " ") + text.slice(found.end),
    );
    found = rest && rest.start >= found.end ? rest : undefined;
  }
  // "第二段", "第 1 遍": a place inside the piece
  for (const m of [
    ...lower.matchAll(
      /第\s*(?:\d+|[一二两三四五六七八九十]+)\s*(?:段|遍|部分|个段落|小节|乐句|句)/g,
    ),
    ...lower.matchAll(
      /\b(?:the\s+)?(?:first|second|third|last)\s+(?:section|part|half|verse|chorus|bar|bars)\b/g,
    ),
  ] as RegExpExecArray[]) {
    const span = { start: m.index, end: m.index + m[0].length };
    extra.push({ ...span, text: m[0], lex: { section: true } });
    blank(span);
  }

  const era = (decade: number, span: Span) => {
    extra.push({
      start: span.start,
      end: span.end,
      text: lower.slice(span.start, span.end),
      lex: {
        cat: "era",
        w: ERA_WEIGHTS[decade] ?? { retro: 2 },
        tag: `${String(decade).padStart(2, "0")} 年代`,
      },
    });
    blank(span);
  };
  for (const m of [...lower.matchAll(/(?<!\d)(?:19|20)?(\d0)\s*年代/g)])
    era(Number(m[1]), { start: m.index, end: m.index + m[0].length });
  for (const m of [...lower.matchAll(/(?<![\d.:])('|19|20)?(\d0)'?s\b/g)]) {
    const decade = Number(m[2]);
    const span = { start: m.index, end: m.index + m[0].length };
    const before = lower.slice(Math.max(0, span.start - 10), span.start);
    const after = lower.slice(span.end, span.end + 16);
    const asDuration = DURATION_CUE.test(before) || /^\s*(?:long|长|的时长)/.test(after);
    const isEra = m[1]
      ? true
      : asDuration
        ? false
        : decade === 70 || decade === 80
          ? true
          : (decade === 60 || decade === 90) &&
            (ERA_CONTEXT.test(after) || ERA_CONTEXT.test(before));
    if (isEra) era(decade, span);
  }

  const amount = (span: Span, qty: Quantity) => {
    extra.push({ ...span, text: lower.slice(span.start, span.end), lex: { qty } });
    blank(span);
  };
  const each = (
    pattern: RegExp,
    read: (m: RegExpExecArray) => Quantity | undefined,
  ) => {
    // matches are taken from the text as it is before this pattern blanks any
    for (const m of [...lower.matchAll(pattern)] as RegExpExecArray[]) {
      const qty = read(m);
      if (qty) amount({ start: m.index, end: m.index + m[0].length }, qty);
    }
  };

  // moving the key by steps: "升一个调", "降半音", "升高两个半音", "up a semitone"
  const steps = (count: string | undefined, unit: string) =>
    (count === undefined || count === "" || count === "a" || count === "one"
      ? 1
      : count === "two"
        ? 2
        : /^\d+$/.test(count)
          ? Number(count)
          : parseChineseNumber(count)) * (/半|semi|half/.test(unit) ? 1 : 2);
  for (const m of [
    ...lower.matchAll(
      /(升高?|调高|提高|降低?|调低)\s*(\d+|[一二两三四五六])?\s*个?\s*(半音|半个调|全音|调|key)(?![性式整])/g,
    ),
    ...lower.matchAll(
      /(高|低)\s*(\d+|[一二两三四五六])\s*个?\s*(半音|半个调|全音|调|key)(?![性式整])/g,
    ),
    ...lower.matchAll(
      /\b(up|down)\s+(?:by\s+)?(a|one|two|\d+)?\s*(semitones?|half steps?|whole steps?|whole tones?)\b/g,
    ),
  ] as RegExpExecArray[]) {
    const span = { start: m.index, end: m.index + m[0].length };
    if (lower.slice(span.start, span.end).includes(BLANK)) continue;
    const sign = /^(?:升|调高|提高|高|up)/.test(m[1]) ? 1 : -1;
    extra.push({
      ...span,
      text: lower.slice(span.start, span.end),
      lex: { shift: sign * Math.min(12, steps(m[2], m[3])) },
    });
    blank(span);
  }

  // tempo: "120bpm", "快 10 个 bpm", "每分钟 96 拍", "120 拍", "bpm=95", "BPM128"
  const tempo = (m: RegExpExecArray): Quantity => ({
    unit: "bpm",
    value: Number(m[1]),
  });
  each(/(?<![\d./])(\d{1,3})\s*(?:个\s*)?(?:bpm\b|拍\/分|拍每分钟)/g, tempo);
  each(/每分钟\s*(\d{2,3})\s*拍?/g, tempo);
  each(/(?<![\d./])(\d{2,3})\s*拍(?![子底\/])/g, tempo);
  // "降 8 拍": one digit is a tempo only right after a word of change
  each(
    /(?<=[快慢加减升降提多少高低涨掉]\s*)(?<![\d./])(\d)\s*拍(?![子底\/])/g,
    tempo,
  );
  each(/bpm\s*[:=]?\s*(\d{2,3})(?![\d%])/g, tempo);
  // "速度 96", "节拍 140", "tempo 88": the word stays a word, the number is a tempo
  for (const m of [
    ...lower.matchAll(
      /(?:速度|节拍|拍速|tempo|每分钟)\s*(?:设?为|调?到|改成?|是|在|=|:)?\s*(\d{2,3})(?![\d%.])(?!\s*(?:秒|分|s\b|%))(?:\s*拍)?/g,
    ),
  ] as RegExpExecArray[]) {
    const start = m.index + m[0].indexOf(m[1]);
    amount(
      { start, end: m.index + m[0].length },
      { unit: "bpm", value: Number(m[1]) },
    );
  }

  // lengths and points in time
  const seconds = (value: number): Quantity => ({ unit: "s", value });
  each(/半分钟|half a minute/g, () => seconds(30));
  each(/(\d+)\s*分钟?\s*(\d{1,2})\s*秒/g, (m) =>
    seconds(Number(m[1]) * 60 + Number(m[2])),
  );
  each(/(\d+)\s*(?:分半钟?|个半分钟)/g, (m) => seconds(Number(m[1]) * 60 + 30));
  each(
    /(\d+)\s*(?:minutes?|mins?)\s*(?:and\s*)?(\d{1,2})\s*(?:seconds?|secs?|s)\b/g,
    (m) => seconds(Number(m[1]) * 60 + Number(m[2])),
  );
  each(/(\d+(?:\.\d+)?)\s*(?:分钟|minutes?\b|mins?\b)/g, (m) =>
    seconds(Number(m[1]) * 60),
  );
  each(/\b(one|two)\s*minutes?\b/g, (m) => seconds(m[1] === "one" ? 60 : 120));
  each(/(?<!\bin )\ba minute\b/g, () => seconds(60));
  each(/(\d+(?:\.\d+)?)\s*(?:秒钟?|seconds?\b|secs?\b)/g, (m) =>
    seconds(Number(m[1])),
  );
  each(/(?<![\d.:a-z])(\d{1,3})\s*s\b/g, (m) => seconds(Number(m[1])));
  each(/(?<![\d:])(\d{1,2}):([0-5]\d)(?![\d:])/g, (m) => {
    // "凌晨 3:00" is a time of day
    const before = lower.slice(0, m.index);
    const after = lower.slice(m.index + m[0].length);
    if (
      /(?:凌晨|早上|上午|中午|下午|晚上|夜里|点)\s*$/.test(before) ||
      /^\s*(?:am|pm|点)/.test(after)
    )
      return undefined;
    return { unit: "s", value: Number(m[1]) * 60 + Number(m[2]), clock: true };
  });

  each(/(\d{1,3})\s*(?:%|percent\b|个点|个百分点)/g, (m) => ({
    unit: "%",
    value: Number(m[1]),
  }));
  each(/百分之\s*(\d{1,3})/g, (m) => ({ unit: "%", value: Number(m[1]) }));
  // "七成" is 70%
  each(
    /(?<![\d.])(\d{1,2}(?:\.\d)?)\s*成(?=$|[\s,，。.;；!！?？、的了吧呢啊左右以\u0001])/g,
    (m) => (Number(m[1]) <= 10 ? { unit: "%", value: Number(m[1]) * 10 } : undefined),
  );
  // factors: "1.5 倍速", "2 倍长", "速度乘以 1.25"
  each(/(?<![\d.])(\d+(?:\.\d+)?)\s*倍\s*(速|长)?/g, (m) =>
    Number(m[1]) > 0 && Number(m[1]) <= 10
      ? {
          unit: "x",
          value: Number(m[1]),
          ...(m[2] ? { about: m[2] === "速" ? "tempo" : "duration" } : {}),
        }
      : undefined,
  );
  each(/(?:乘以?\s*|(?<![a-z0-9])[x×*]\s?)(\d+(?:\.\d+)?)(?![\d%:a-z])/g, (m) =>
    Number(m[1]) > 0 && Number(m[1]) <= 10
      ? { unit: "x", value: Number(m[1]) }
      : undefined,
  );
  each(/(\d+(?:\.\d+)?)\s*(?:db\b|分贝)/g, (m) => ({
    unit: "db",
    value: Number(m[1]),
  }));

  const words = tokenize(lower);
  // bare numbers, wherever no dictionary word ("8 bit", "3/4") claimed them
  const taken = new Uint8Array(lower.length);
  for (const word of words) taken.fill(1, word.start, word.end);
  for (const m of [
    ...lower.matchAll(/(?<![\d.:/a-z#])(\d{1,3}(?:\.\d+)?)(?![\d:/a-z%])/g),
  ] as RegExpExecArray[]) {
    if (taken[m.index] || taken[m.index + m[0].length - 1]) continue;
    amount(
      { start: m.index, end: m.index + m[0].length },
      {
        unit: "n",
        value: Number(m[1]),
        ...(m[1].includes(".") ? { decimal: true } : {}),
      },
    );
  }

  result.lower = lower;
  result.tokens = [...words, ...extra].sort((a, b) => a.start - b.start);
  result.bpm = result.tokens.find(({ lex }) => lex.qty?.unit === "bpm")?.lex.qty
    ?.value;
  // "下一秒" and friends are not a length
  result.duration = result.tokens.find(
    ({ lex }) => lex.qty?.unit === "s" && lex.qty.value >= 5,
  )?.lex.qty?.value;
  return result;
}

const STOPWORDS =
  /\b(?:the|a|an|to|it|its|is|be|of|please|bit|little|volume|level|track|part|some|in|my|this|that|sound|sounds|for|me|them|by|at|any|want|need|like|just|i|we|you|can|could|would|have|get|give|are|was|were|feels|seems|all|way|really)\b/g;

/**
 * The text between two positions when it is short enough to belong to one
 * phrase (no clause boundary, at most `max` meaningful characters); else null.
 */
export function gapBetween(
  lower: string,
  from: number,
  to: number,
  max = 3,
): string | null {
  if (to < from) return null;
  const raw = lower.slice(from, to);
  if (/[,.;!?。；！？\n]/.test(raw)) return null;
  const core = raw
    .replace(STOPWORDS, "")
    .replace(/[\s\u0001"'()（）《》「」·~…:\-]/g, "")
    .replace(/[的地得了吧呢啊呀嘛把让使给请要想我你它这那个声音量部分轨组感整体可以能有是还也都就来下里面上]/g, "");
  return core.length <= max ? core : null;
}
