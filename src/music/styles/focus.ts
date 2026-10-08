import type { StyleDef } from "./types";

/** 安静专注 — restrained piano over a steady, quiet pulse; nothing asks for attention. */
export const focus: StyleDef = {
  id: "focus",
  summary: "克制的钢琴旋律与稳定安静的律动",
  harmony: {
    modes: {
      major: [
        {
          scale: "major",
          bank: {
            verse: [
              ["I", "IV", "vi", "IV"],
              ["I", "vi", "IV", "I"],
              ["Iadd9", "V/VII", "vi7", "IV"],
              ["IV", "I", "V", "vi"],
              ["I", "iii", "IV", "IV"],
            ],
            chorus: [
              ["IV", "I", "V", "vi"],
              ["vi", "IV", "I", "V"],
              ["ii", "IV", "I", "V"],
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
              ["i", "bIII", "bVI", "bVI"],
              ["i", "iv", "i", "bVII"],
            ],
            chorus: [
              ["bVI", "bIII", "bVII", "i"],
              ["iv", "bVI", "bIII", "bVII"],
            ],
          },
        },
      ],
    },
    colour: [0.15, 0.65],
    extensions: { major: ["add9", "maj7"], minor: ["7", "9"], dominant: ["", "7"] },
    variation: 0.4,
    secondary: 0.15,
    borrowed: 0.2,
    sus: 0.4,
    voicing: "close",
    voices: 3,
    register: [52, 74],
    turnaround: { major: ["V", "IV"], minor: ["bVII"] },
    cadence: {
      major: [
        ["IV", "V"],
        ["ii", "V"],
      ],
      minor: [["bVI", "bVII"]],
    },
    final: { major: "Iadd9", minor: "i" },
  },
  melody: {
    density: 0.26,
    syncopation: 0.15,
    motifBars: 2,
    stepBias: 0.74,
    pickup: 0.2,
    ornaments: 0.1,
    space: 0.55,
    chorusLift: 2,
    // plain and even: nothing that asks for attention
    cells: ["x.......", "x...x...", "____x...", "x.....x."],
  },
  comp: {
    voice: "piano",
    from: 0,
    patterns: {
      low: [
        { rows: { low: "X...............", upper: "........o......." } },
        { rows: { all: "X..............." }, strum: 0.02 },
      ],
      mid: [
        { rows: { low: "X.......o.......", upper: "....o.......o..." } },
        { rows: { "1": "X.......o.......", "2": "....o.......o...", top: "..o...o...o...o." } },
      ],
      high: [{ rows: { low: "X...o...o...o...", upper: "..o...o...o...o." } }],
    },
  },
  pad: { voice: ["pad", "airpad"], from: 0.2, register: [50, 74] },
  arp: {
    voice: ["marimba", "pluck"],
    from: 0.55,
    pattern: ["broken", "alberti"],
    rate: { low: 2, mid: 2, high: 2 },
    register: [60, 81],
    gate: 0.7,
  },
  bass: {
    voice: "subBass",
    from: 0.3,
    feel: { low: "root", mid: "root", high: "root" },
    register: [31, 45],
    approach: 0.2,
  },
  drums: {
    kit: "soft",
    from: 0.42,
    grooves: {
      low: [{ kick: "x.......o.......", rim: "....o.......o..." }],
      mid: [{ kick: "x.......o.o.....", rim: "....o.......o...", hatClosed: "o.g.o.g.o.g.o.g." }],
      high: [{ kick: "x.....o.x.......", snare: "....o.......o...", hatClosed: "o.g.o.g.o.g.o.g." }],
    },
    crash: null,
    ghost: 0.1,
  },
  perc: {
    from: 0.28,
    grooves: [{ shaker: "o.g.o.g.o.g.o.g." }, { shaker: "..o...o...o...o." }],
  },
  swing: 0,
  humanize: { timing: 8, velocity: 0.08 },
  form: { loop: "AB", intro: 1, outro: 1 },
  mix: {
    lead: { gain: 0.72, reverb: 0.3 },
    comp: { gain: 0.5 },
    pad: { gain: 0.34 },
    perc: { gain: 0.28 },
    kit: { gain: 0.6 },
  },
  space: {
    size: 0.42,
    decay: 1.5,
    damping: 0.55,
    preDelay: 0.012,
    level: 0.45,
    delayBeats: 0.75,
    delayFeedback: 0.2,
  },
  master: { targetLufs: -16, ceilingDb: -1, character: "warm", tilt: -0.1 },
};
