import type { StyleDef } from "./types";

/** 复古电子 — synthwave: octave bass, sixteenth-note arpeggio, gated stabs, 80s drum machine. */
export const retro: StyleDef = {
  id: "retro",
  summary: "合成器垫音、循环琶音与 80 年代鼓机",
  harmony: {
    modes: {
      major: [
        {
          scale: "major",
          bank: {
            verse: [
              ["I", "V", "vi", "IV"],
              ["IV", "V", "vi", "vi"],
              ["I", "iii", "vi", "IV"],
              ["vi", "IV", "I", "V"],
            ],
            chorus: [
              ["IV", "V", "iii", "vi"],
              ["IV", "V", "vi", "I"],
              ["vi", "V", "IV", "V"],
            ],
          },
        },
      ],
      minor: [
        {
          scale: "naturalMinor",
          weight: 2,
          bank: {
            verse: [
              ["i", "bVI", "bIII", "bVII"],
              ["i", "bVII", "bVI", "bVII"],
              ["bVI", "bVII", "i", "i"],
              ["i", "iv", "bVI", "bVII"],
              ["i", "bIII", "bVII", "bVI"],
            ],
            chorus: [
              ["bVI", "bVII", "i", "bIII"],
              ["bVI", "bIII", "bVII", "i"],
              ["iv", "bVII", "bIII", "bVI"],
            ],
            bridge: [["iv", "v", "bVI", "bVII"]],
          },
        },
        {
          scale: "dorian",
          bank: {
            verse: [
              ["i", "IV", "i", "IV"],
              ["i", "bVII", "IV", "i"],
              ["i", "IV", "bVII", "bIII"],
            ],
            chorus: [
              ["bIII", "bVII", "IV", "i"],
              ["IV", "i", "bVII", "IV"],
            ],
          },
        },
      ],
    },
    colour: [0.1, 0.65],
    extensions: { major: ["add9", "maj7"], minor: ["7", "9"], dominant: ["", "7"] },
    variation: 0.4,
    secondary: 0.2,
    borrowed: 0.3,
    sus: 0.5,
    voicing: "close",
    voices: 4,
    register: [52, 76],
    turnaround: { major: ["V", "IV V"], minor: ["bVII", "v", "V"] },
    cadence: { major: [["IV", "V"]], minor: [["bVI", "bVII"]] },
    final: { major: "I", minor: "i" },
  },
  melody: {
    density: 0.55,
    syncopation: 0.55,
    motifBars: 2,
    stepBias: 0.64,
    pickup: 0.4,
    ornaments: 0.15,
    space: 0.25,
    chorusLift: 4,
    // synthwave: driving eighths and dotted pushes
    cells: ["x..x..x.", "x.x.x.x.", "x...x.x.", "__x.x.x.", "x.x...x."],
    gate: 0.9,
  },
  comp: {
    voice: ["epiano", "pluck"],
    from: 0.5,
    patterns: {
      low: [{ rows: { all: "x-......o-......" } }],
      mid: [{ rows: { all: "X-....x-..o-...." } }, { rows: { all: "..x-..o-..x-..o-" } }],
      high: [{ rows: { all: "X-.x-.o-X-.x-.o-" } }, { rows: { all: "X-x-..o-X-x-..o-" } }],
    },
  },
  pad: { voice: ["pad", "airpad"], from: 0, register: [50, 74], voices: 4 },
  arp: {
    voice: ["pluck", "bell"],
    from: 0.3,
    pattern: ["up", "updown", "octaves"],
    rate: { low: 2, mid: 1, high: 1 },
    octaves: 2,
    gate: 0.6,
    register: [52, 77],
  },
  counter: { voice: ["strings", "bell"], from: 0.82, mode: "guide" },
  bass: {
    voice: "synthBass",
    from: 0.1,
    feel: { low: "root", mid: "octave", high: "octave" },
    register: [29, 43],
    approach: 0.3,
    gate: 0.85,
  },
  drums: {
    kit: "electro",
    from: 0.2,
    grooves: {
      low: [{ kick: "X.......x.......", snare: "....o.......o...", hatClosed: "..o...o...o...o." }],
      mid: [
        { kick: "X...x...X...x...", snare: "....X.......X...", hatClosed: "..x...x...x...x." },
        { kick: "X.......X.x.....", snare: "....X.......X...", hatClosed: "x.o.x.o.x.o.x.o." },
      ],
      high: [
        {
          kick: "X...X..xX...X...",
          snare: "....X.......X...",
          hatClosed: "x.x.x.x.x.x.x.x.",
          hatOpen: "..............o.",
        },
        {
          kick: "X...X...X...X...",
          snare: "....X.......X...",
          clap: "....x.......x...",
          hatClosed: "x.xxx.xxx.xxx.xx",
          hatOpen: "..o...o...o...o.",
        },
      ],
    },
    fills: {
      light: [{ tomHigh: "............x...", tomLow: "..............x." }, { snare: "..............xx" }],
      full: [
        {
          tomHigh: "........x.x.....",
          tomMid: "............x...",
          tomLow: "..............x.",
          snare: "...............x",
        },
        { snare: "........x.x.xxxx" },
      ],
    },
    crash: "crash",
    swell: true,
    ghost: 0.15,
  },
  perc: {
    from: 0.75,
    grooves: [{ tambourine: "..o...o...o...o." }, { shaker: "o.g.o.g.o.g.o.g." }],
  },
  swing: 0,
  humanize: { timing: 3, velocity: 0.05 },
  form: { loop: "AB", intro: 1, outro: 1 },
  mix: {
    lead: { reverb: 0.3, delay: 0.22, chorus: 0.2 },
    pad: { gain: 0.42, chorus: 0.5, duck: 0.5 },
    arp: { delay: 0.25, duck: 0.25 },
    comp: { duck: 0.3 },
    bass: { drive: 0.15, duck: 0.3 },
  },
  space: {
    size: 0.55,
    decay: 2,
    damping: 0.45,
    preDelay: 0.02,
    level: 0.5,
    delayBeats: 0.75,
    delayFeedback: 0.36,
  },
  master: { targetLufs: -16, ceilingDb: -1, character: "wide", tilt: 0.12 },
};
