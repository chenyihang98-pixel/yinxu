import type { StyleDef } from "./types";

/** 史诗燃向 — trailer score: string melody, brass stabs, pizzicato ostinato, taiko and booms. */
export const epic: StyleDef = {
  id: "epic",
  summary: "弦乐主题、铜管重音与固定音型，太鼓层层推向高潮",
  harmony: {
    modes: {
      major: [
        {
          scale: "major",
          bank: {
            verse: [
              ["I", "V", "vi", "IV"],
              ["I", "bVII", "IV", "I"],
              ["I", "IV", "bVII", "IV"],
              ["vi", "IV", "I", "V"],
            ],
            chorus: [
              ["IV", "V", "vi", "I"],
              ["bVI", "bVII", "I", "I"],
              ["I", "V/VII", "vi", "IV"],
            ],
            bridge: [["vi", "IV", "ii", "V"]],
            build: [["IV", "IV", "V", "V"]],
          },
        },
      ],
      minor: [
        {
          scale: "naturalMinor",
          bank: {
            verse: [
              ["i", "bVI", "bIII", "bVII"],
              ["i", "bVII", "bVI", "V"],
              ["i", "i", "bVI", "bVII"],
              ["i", "bVI", "iv", "V"],
              ["i", "bIII", "bVII", "iv"],
            ],
            chorus: [
              ["bVI", "bVII", "i", "i"],
              ["bVI", "bIII", "bVII", "i"],
              ["i", "bVI", "bIII", "V"],
              ["bVI", "bVII", "i", "bIII"],
            ],
            bridge: [["iv", "bVI", "bVII", "V"]],
            build: [
              ["bVI", "bVI", "bVII", "V"],
              ["iv", "iv", "V", "V"],
            ],
          },
        },
      ],
    },
    colour: [0, 0.3],
    extensions: { major: ["", "add9"], minor: ["", "add9"], dominant: ["", ""] },
    variation: 0.35,
    secondary: 0.15,
    borrowed: 0.4,
    sus: 0.6,
    voicing: "open",
    voices: 3,
    register: [50, 72],
    turnaround: { major: ["V", "bVII"], minor: ["V", "bVII"] },
    cadence: {
      major: [
        ["bVI", "bVII"],
        ["IV", "V"],
      ],
      minor: [
        ["bVI", "bVII"],
        ["iv", "V"],
        ["bVI", "V"],
      ],
    },
    final: { major: "I", minor: "i" },
  },
  melody: {
    density: 0.42,
    syncopation: 0.25,
    motifBars: 2,
    stepBias: 0.64,
    pickup: 0.35,
    ornaments: 0.15,
    space: 0.25,
    chorusLift: 5,
    // heroic: held notes, dotted fanfare figures, marching eighths
    cells: ["x.....x.", "x...x.x.", "x..x..x.", "x.......", "x.x.x...", "x..xx..."],
    gate: 0.97,
  },
  comp: {
    voice: "brass",
    from: 0.5,
    mute: ["breakdown"],
    patterns: {
      low: [{ rows: { all: "X..............." } }],
      mid: [{ rows: { all: "X.......x-..x-.." } }, { rows: { all: "X.....x-x......." } }],
      high: [{ rows: { all: "X.....x-X.x-x-.." } }, { rows: { all: "X-.x-.x-X-.x-.x-" } }],
    },
  },
  pad: { voice: ["strings", "choir"], from: 0.2, register: [48, 74], voices: 4 },
  arp: {
    voice: ["pizzicato", "marimba"],
    from: 0.45,
    pattern: ["ostinato"],
    rate: { low: 2, mid: 2, high: 1 },
    register: [50, 74],
    gate: 0.6,
  },
  counter: { voice: ["brass", "choir"], from: 0.82, mode: "double" },
  bass: {
    voice: "synthBass",
    from: 0.25,
    feel: { low: "pedal", mid: "root", high: "root" },
    register: [29, 43],
    approach: 0.15,
    gate: 0.9,
  },
  drums: {
    kit: "cinematic",
    from: 0.3,
    grooves: {
      low: [{ taiko: "X.........x....." }, { taiko: "X.....o...x....." }],
      mid: [
        { taiko: "X..x..x...x.x...", tomLow: "..............x." },
        { taiko: "X.....x.X..x..x." },
      ],
      high: [
        { taiko: "X..x..x.X..x..x.", snare: "..o...o...o.o.xx", tomLow: "....x.......x..." },
        { taiko: "X.x.X.x.X.x.X.xx", snare: "....x.......x.xx" },
      ],
    },
    fills: {
      light: [{ taiko: "............x.xx" }, { tomLow: "............x.x.", taiko: "..............X." }],
      full: [
        {
          tomHigh: "........xx......",
          tomMid: "..........xx....",
          tomLow: "............xx..",
          taiko: "..............XX",
        },
        { taiko: "........x.xxx.xX", snare: "........oooxxxxX" },
      ],
    },
    crash: "crash",
    impact: "subBoom",
    swell: true,
    ghost: 0.1,
  },
  swing: 0,
  humanize: { timing: 5, velocity: 0.07 },
  form: { loop: "AB", intro: 1, outro: 1.2, tail: 2.8 },
  mix: {
    lead: { gain: 0.82, reverb: 0.4 },
    comp: { gain: 0.55, pan: 0.15, reverb: 0.4 },
    pad: { gain: 0.45, reverb: 0.5 },
    arp: { gain: 0.42, pan: -0.2, reverb: 0.3, delay: 0 },
    counter: { gain: 0.48, pan: 0.2, reverb: 0.4 },
    bass: { drive: 0.2 },
    kit: { gain: 0.9, reverb: 0.35 },
  },
  space: {
    size: 0.9,
    decay: 3.2,
    damping: 0.4,
    preDelay: 0.03,
    level: 0.6,
    delayBeats: 0.5,
    delayFeedback: 0.2,
  },
  master: { targetLufs: -16, ceilingDb: -1, character: "punchy", tilt: 0.05 },
};
