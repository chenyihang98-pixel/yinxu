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
  comp: {
    voice: "piano",
    from: 0,
    patterns: {
      low: [
        { rows: { low: "X...............", upper: "........o......." } },
        {
          rows: {
            "1": "X...............",
            "2": "....o...........",
            "4": "........o.......",
            "3": "............o...",
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
        { rows: { low: "X...x...x...x...", upper: "..x...x...x...x." } },
        { rows: { all: "X..x..x.X..x..x." }, gate: 0.85 },
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
    register: [28, 43],
    approach: 0.2,
    gate: 0.96,
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
    lead: { reverb: 0.4, delay: 0.1 },
    comp: { reverb: 0.35 },
    pad: { gain: 0.45, reverb: 0.5 },
    counter: { reverb: 0.45 },
    kit: { reverb: 0.35 },
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
  master: { targetLufs: -16, ceilingDb: -1, character: "warm", tilt: 0 },
};
