import type { StyleDef } from "./types";

/**
 * 热血战斗 — a fast synth lead over a synth bass hammering sixteenths, string
 * stabs on the pushes, bVI–bVII–i harmony and a kit that never lets up: fast
 * hats, double kicks and tom runs into every section.
 */
export const battle: StyleDef = {
  id: "battle",
  summary: "高速合成器主音、十六分音符的合成贝斯固定音型、弦乐重音与密集鼓点",
  harmony: {
    modes: {
      major: [
        {
          // heroic major with borrowed flat chords
          scale: "major",
          bank: {
            verse: [
              ["I", "V", "vi", "IV"],
              ["I", "bVII", "IV", "I"],
              ["vi", "IV", "I", "V"],
            ],
            chorus: [
              ["bVI", "bVII", "I", "I"],
              ["IV", "V", "vi", "iii"],
              ["IV", "V", "I", "I"],
            ],
            build: [["IV", "IV", "V", "V"]],
          },
        },
      ],
      minor: [
        {
          scale: "naturalMinor",
          weight: 2,
          bank: {
            verse: [
              ["i", "i", "bVI", "bVII"],
              ["i", "bVII", "bVI", "bVII"],
              ["i", "bVI", "bVII", "i"],
              ["i", "bIII", "bVII", "bVI"],
              ["i", "v", "bVI", "bVII"],
              ["i", "iv", "bVII", "bIII"],
            ],
            chorus: [
              ["bVI", "bVII", "i", "i"],
              ["bVI", "bVII", "i", "bIII"],
              ["bVI", "bVII", "v", "i"],
              ["iv", "bVII", "bIII", "bVI"],
              ["i", "bVI", "bIII", "bVII"],
            ],
            bridge: [["iv", "bVI", "bVII", "V"]],
            build: [
              ["bVI", "bVI", "bVII", "bVII"],
              ["iv", "iv", "bVII", "V"],
            ],
          },
        },
        {
          scale: "harmonicMinor",
          bank: {
            verse: [
              ["i", "bVI", "iv", "V"],
              ["i", "iv", "V", "i"],
              ["i", "bVII", "bVI", "V"],
            ],
            chorus: [
              ["bVI", "bVII", "i", "V"],
              ["iv", "V", "i", "i"],
              ["bVI", "V", "i", "i"],
            ],
            build: [["iv", "iv", "V", "V"]],
          },
        },
      ],
    },
    colour: [0, 0.25],
    extensions: { major: ["", "add9"], minor: ["", "7"], dominant: ["", ""] },
    variation: 0.3,
    secondary: 0.1,
    borrowed: 0.3,
    sus: 0.4,
    voicing: "open",
    voices: 3,
    register: [50, 72],
    // riffing verses sit on a chord for two bars; the chorus changes every bar until bars get too short
    barsPerChord: ({ bpm, section }) =>
      bpm >= 172 || (bpm >= 150 && section !== "chorus" && section !== "build") ? 2 : 1,
    turnaround: { major: ["V", "bVII"], minor: ["V", "bVII", "v"] },
    cadence: {
      major: [
        ["bVI", "bVII"],
        ["IV", "V"],
      ],
      minor: [
        ["bVI", "bVII"],
        ["iv", "V"],
      ],
    },
    final: { major: "I", minor: "i" },
  },
  melody: {
    density: 0.6,
    syncopation: 0.5,
    motifBars: 2,
    stepBias: 0.6,
    pickup: 0.4,
    ornaments: 0.1,
    space: 0.15,
    chorusLift: 4,
    gate: 0.9,
    // pushed three-against-four accents and running eighths
    cells: ["x..x..x.", "x.x.x.x.", "x.x.x...", "x...x.x.", "x..x.x..", "x.x...x.", "x......."],
  },
  comp: {
    voice: ["strings", "brass"],
    from: 0.3,
    patterns: {
      low: [{ rows: { all: "X-......x-......" } }],
      mid: [{ rows: { all: "X-....x-..x-...." } }, { rows: { all: "X-.x-...X-.x-..." } }],
      high: [{ rows: { all: "X-.x-.x-X-.x-.x-" } }, { rows: { all: "x-x-.x-.x-x-.x-." } }],
    },
  },
  pad: { voice: ["pad", "choir"], from: 0.55, register: [52, 74] },
  arp: {
    voice: ["pluck", "bell"],
    from: 0.7,
    pattern: ["ostinato", "up"],
    rate: { low: 2, mid: 2, high: 1 },
    register: [55, 79],
    gate: 0.6,
  },
  counter: { voice: ["brass", "strings"], from: 0.82, mode: "double" },
  bass: {
    voice: "synthBass",
    from: 0,
    feel: { low: "root", mid: "octave", high: "octave" },
    register: [28, 43],
    approach: 0.3,
    gate: 0.8,
    riffs: {
      low: ["1.1.1.1.1.1.1.1."],
      mid: ["1.1.1.1.1.1.8.1.", "1.111.111.111.11"],
      high: ["1.111.111.111.11", "1111111111118111", "1.118.111.118.11", "1111811111118181"],
    },
  },
  drums: {
    kit: "pop",
    from: 0,
    grooves: {
      low: [{ kick: "X.......x.......", snare: "....x.......x...", hatClosed: "x.x.x.x.x.x.x.x." }],
      mid: [
        { kick: "X.....x.x.......", snare: "....X.......X...", hatClosed: "x.x.x.x.x.x.x.x." },
        {
          kick: "X..x..x.X..x....",
          snare: "....X.......X...",
          hatClosed: "x.x.x.x.x.x.x.x.",
          hatOpen: "..............o.",
        },
      ],
      high: [
        { kick: "X.x...x.X.x...x.", snare: "....X.......X...", hatClosed: "x.xxx.xxx.xxx.xx" },
        {
          kick: "X..x..x.X..x..x.",
          snare: "....X..g....X.gg",
          hatClosed: "xgxgxgxgxgxgxgxg",
          hatOpen: "......o.......o.",
        },
        { kick: "X.xxX.xxX.xxX.xx", snare: "....X.......X...", ride: "x...x...x...x..." },
      ],
    },
    fills: {
      light: [{ snare: "............x.xx" }, { tomHigh: "............x...", tomLow: "..............xx" }],
      full: [
        { tomHigh: "........xxx.....", tomMid: "...........xx...", tomLow: ".............xxX" },
        { snare: "........x.xxx.xx", tomLow: "...............X" },
        { snare: "........xxxxxxxx", kick: "........x...x..." },
      ],
    },
    crash: "crash",
    swell: true,
    ghost: 0.2,
    buildRoll: "snare",
  },
  swing: 0,
  humanize: { timing: 3, velocity: 0.06 },
  form: {
    loop: "AB",
    intro: 0.6,
    outro: 0.7,
    tail: 2,
    energy: { verse: [0.9, 0.02], breakdown: [0.55, 0.05] },
  },
  mix: {
    lead: { gain: 0.8, reverb: 0.2, delay: 0.15, chorus: 0.15 },
    comp: { gain: 0.5, pan: 0.2, reverb: 0.25 },
    pad: { gain: 0.32 },
    arp: { gain: 0.3, pan: -0.3, delay: 0.15 },
    counter: { gain: 0.4, pan: 0.15 },
    bass: { gain: 0.82, drive: 0.3 },
    kit: { gain: 0.9, reverb: 0.1, drive: 0.1 },
  },
  space: {
    size: 0.4,
    decay: 1.2,
    damping: 0.5,
    preDelay: 0.012,
    level: 0.4,
    delayBeats: 0.75,
    delayFeedback: 0.25,
  },
  master: { targetLufs: -16, ceilingDb: -1, character: "punchy", tilt: 0.12 },
};
