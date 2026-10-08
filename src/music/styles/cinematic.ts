import type { StyleDef } from "./types";

/** 电影叙事 — broken-chord piano, strings that spread slowly, deep drums that arrive late. */
export const cinematic: StyleDef = {
  id: "cinematic",
  summary: "钢琴分解和弦与缓缓铺开的弦乐，层层推进",
  harmony: {
    modes: {
      major: [
        {
          scale: "major",
          bank: {
            verse: [
              ["I", "iii", "IV", "I"],
              ["I", "V/VII", "vi", "IV"],
              ["I", "IV", "vi", "V"],
              ["vi", "IV", "I", "V"],
            ],
            chorus: [
              ["IV", "V", "vi", "I"],
              ["IV", "I", "V", "vi"],
              ["I", "V", "vi", "iii", "IV", "I", "ii", "V"],
            ],
            bridge: [
              ["vi", "iii", "IV", "V"],
              ["bVI", "bVII", "I", "I"],
            ],
          },
        },
      ],
      minor: [
        {
          scale: "naturalMinor",
          bank: {
            verse: [
              ["i", "bVI", "bIII", "bVII"],
              ["i", "iv", "bVI", "V"],
              ["i", "bIII", "bVII", "iv"],
              ["bVI", "bVII", "i", "i"],
              ["i", "i", "bVI", "bVI", "bIII", "bIII", "bVII", "V"],
            ],
            chorus: [
              ["bVI", "bVII", "i", "bIII"],
              ["bVI", "bIII", "bVII", "i"],
              ["iv", "bVI", "bIII", "bVII"],
              ["i", "bVI", "bIII", "V"],
            ],
            bridge: [
              ["iv", "i", "bVI", "V"],
              ["bVI", "iv", "i", "V"],
            ],
          },
        },
      ],
    },
    colour: [0.1, 0.6],
    extensions: { major: ["add9", "maj7"], minor: ["add9", "9"], dominant: ["", "7"] },
    variation: 0.5,
    secondary: 0.35,
    borrowed: 0.5,
    sus: 0.6,
    voicing: "open",
    voices: 4,
    register: [53, 79],
    turnaround: { major: ["V", "Vsus4 V"], minor: ["V", "bVII"] },
    cadence: {
      major: [
        ["IV", "V"],
        ["vi", "IV", "V"],
        ["IV", "Vsus4"],
      ],
      minor: [
        ["bVI", "bVII"],
        ["iv", "V"],
        ["bVI", "V"],
      ],
    },
    final: { major: "Iadd9", minor: "i" },
  },
  melody: {
    density: 0.36,
    syncopation: 0.2,
    motifBars: 2,
    stepBias: 0.74,
    pickup: 0.3,
    ornaments: 0.25,
    space: 0.4,
    chorusLift: 4,
    // broad: long notes leaning on a short one
    cells: ["x.....x.", "x...x...", "x.......", "x...x.x.", "x..x...."],
  },
  // every lead sits 2–4 LU over the chords: dull struck leads up, bright bowed and blown ones down
  lead: {
    epiano: { gain: 0.98 },
    guitar: { gain: 0.93 },
    pluck: { gain: 0.93 },
    marimba: { gain: 1.1 },
    vibes: { gain: 0.95 },
    bell: { gain: 0.8 },
    musicbox: { gain: 0.82 },
    flute: { gain: 0.76 },
    strings: { gain: 0.68 },
    synth: { gain: 0.72 },
    guzheng: { gain: 0.72 },
    dizi: { gain: 0.6 },
    chip: { gain: 0.69 },
  },
  comp: {
    voice: "piano",
    from: 0,
    patterns: {
      low: [
        { rows: { low: "X...............", upper: "........X......." } },
        {
          rows: {
            "1": "X...............",
            "2": "....X...........",
            "4": "........X.......",
            "3": "............x...",
          },
        },
      ],
      mid: [
        {
          rows: {
            "1": "X.......x.......",
            "2": "..o.......o.....",
            "4": "....o.......o...",
            "3": "......o.......o.",
          },
        },
        {
          rows: {
            "1": "X...............",
            "2": "..o...........o.",
            "3": "....o.......o...",
            "4": "......o...o.....",
            top: "........o.......",
          },
        },
      ],
      high: [
        { rows: { low: "X...x...x...x...", upper: "..o...o...o...o." } },
        { rows: { low: "X.....x.x.....x.", upper: "x..o..o.o..o..o." }, gate: 0.85 },
      ],
    },
  },
  pad: { voice: ["strings", "choir"], from: 0.3, register: [50, 76], voices: 4 },
  arp: {
    voice: ["pizzicato", "marimba"],
    from: 0.72,
    pattern: ["ostinato"],
    rate: { low: 2, mid: 2, high: 1 },
    register: [55, 79],
    gate: 0.6,
  },
  counter: { voice: ["strings", "flute"], from: 0.55, mode: "guide" },
  bass: {
    voice: "subBass",
    from: 0.25,
    feel: { low: "root", mid: "root", high: "root" },
    register: [31, 45],
    approach: 0.2,
    gate: 0.96,
    // a sub bass that pulses in eighths turns to mush: when the energy is up it still plays long notes
    riffs: { high: ["1.......1.......", "1.....1.1.......", "1.......1.....1."] },
  },
  drums: {
    kit: "cinematic",
    from: 0.52,
    grooves: {
      low: [{ taiko: "X.........o....." }],
      mid: [
        { taiko: "X.....o.x...o...", tomLow: "..............o." },
        { taiko: "X..o..x...x.o..." },
      ],
      high: [
        { taiko: "X..x..x.X..x..x.", snare: "....o.......o.xx" },
        { taiko: "X.x...x.X.x...xx", tomLow: "....x.......x..." },
      ],
    },
    fills: {
      light: [{ tomLow: "............o.x." }, { taiko: "..............ox" }],
      full: [
        {
          tomHigh: "........xx......",
          tomMid: "..........xx....",
          tomLow: "............xx..",
          taiko: "..............XX",
        },
        { taiko: "........x.x.xxXX" },
      ],
    },
    crash: "crash",
    impact: "subBoom",
    swell: true,
    ghost: 0.1,
  },
  swing: 0,
  humanize: { timing: 10, velocity: 0.1 },
  form: { loop: "AB", intro: 1.3, outro: 1.3, tail: 2.8 },
  mix: {
    lead: { gain: 0.84, reverb: 0.34, delay: 0.1 },
    comp: { gain: 0.5, reverb: 0.35 },
    pad: { gain: 0.42, reverb: 0.5 },
    counter: { gain: 0.46, reverb: 0.45 },
    bass: { gain: 0.82, drive: 0.25 },
    kit: { gain: 0.9, reverb: 0.4 },
  },
  space: {
    size: 0.78,
    decay: 2.8,
    damping: 0.4,
    preDelay: 0.025,
    level: 0.6,
    delayBeats: 1,
    delayFeedback: 0.25,
  },
  master: { targetLufs: -16, ceilingDb: -1, character: "clean", tilt: 0.6 },
};
