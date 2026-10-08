import type { StyleDef } from "./types";

/** 爵士小馆 — swung ride, walking upright bass, rootless seventh / ninth comping. */
export const jazz: StyleDef = {
  id: "jazz",
  summary: "摇摆的叮叮镲、行走的低音提琴与七、九和弦的钢琴伴奏",
  harmony: {
    modes: {
      major: [
        {
          scale: "major",
          bank: {
            verse: [
              ["Imaj7", "vi7", "ii7", "V7"],
              ["Imaj7", "V7/ii", "ii7", "V7"],
              ["ii7", "V7", "Imaj7", "vi7"],
              ["Imaj7", "#idim7", "ii7", "V7"],
              ["Imaj7", "IV7", "iii7 V7/ii", "ii7 V7"],
              ["Imaj7", "vi7", "ii7", "V7", "iii7", "V7/ii", "ii7", "V7"],
            ],
            chorus: [
              ["IVmaj7", "iv7 bVII7", "iii7", "V7/ii"],
              ["V7/vi", "V7/ii", "V7/V", "V7"],
              ["ii7", "V7", "Imaj7", "I7"],
              ["iii7", "V7/ii", "ii7", "V7"],
            ],
            bridge: [["V7/vi", "V7/ii", "V7/V", "V7"]],
          },
        },
      ],
      minor: [
        {
          scale: "naturalMinor",
          bank: {
            verse: [
              ["i7", "iv7", "iiø V7", "i7"],
              ["i7", "bVImaj7", "iiø", "V7"],
              ["i7", "iiø V7", "i7", "iiø V7"],
              ["i6", "iv7", "bVII7", "bIIImaj7"],
            ],
            chorus: [
              ["iv7", "bVII7", "bIIImaj7", "bVImaj7"],
              ["iiø", "V7", "i7", "V7/iv"],
              ["bVImaj7", "iiø V7", "i7", "i7"],
            ],
          },
        },
      ],
    },
    colour: [0.75, 1],
    extensions: { major: ["maj7", "maj9"], minor: ["7", "9"], dominant: ["7", "13"] },
    variation: 0.5,
    secondary: 0.7,
    borrowed: 0.5,
    sus: 0.3,
    voicing: "rootless",
    voices: 4,
    register: [52, 74],
    turnaround: { major: ["ii7 V7", "V7"], minor: ["iiø V7", "V7"] },
    cadence: {
      major: [
        ["ii7", "V7"],
        ["iii7 V7/ii", "ii7 V7"],
      ],
      minor: [
        ["iiø", "V7"],
        ["iv7", "V7"],
      ],
    },
    final: { major: "I69", minor: "i6" },
  },
  melody: {
    density: 0.58,
    syncopation: 0.75,
    motifBars: 2,
    stepBias: 0.62,
    pickup: 0.65,
    ornaments: 0.35,
    space: 0.3,
    chorusLift: 3,
    // swung eighth-note lines that start off the beat and anticipate the next one
    cells: ["__x.x.x.", "x.x...x.", "__x...x.", "x.x.x.x.", "x.....x.", "__x.x..."],
  },
  comp: {
    voice: ["piano", "epiano"],
    from: 0,
    patterns: {
      low: [{ rows: { all: "......x.-......." } }, { rows: { all: "x.-.......o.-..." } }],
      mid: [
        { rows: { all: "x.-...x.-......." } },
        { rows: { all: "......x.-.....x." }, push: true },
        { rows: { all: "..x.-.....x.-..." } },
        { rows: { all: "x.-.........x.-." } },
      ],
      high: [
        { rows: { all: "x.-...x.-...x.-." } },
        { rows: { all: "..x.-.x.-.....x." }, push: true },
      ],
    },
  },
  // only when a hint asks for it
  pad: { voice: "organ", from: 2, register: [48, 70] },
  counter: { voice: ["flute", "epiano"], from: 0.85, mode: "guide" },
  bass: {
    voice: "uprightBass",
    from: 0,
    feel: { low: "root", mid: "walking", high: "walking" },
    register: [31, 48],
    approach: 0.8,
    gate: 0.9,
  },
  drums: {
    kit: "brush",
    from: 0.08,
    grooves: {
      low: [
        { brushSnare: "o...o...o...o...", hatClosed: "....o.......o..." },
        { ride: "o...o.g.o...o.g.", hatClosed: "....o.......o..." },
      ],
      mid: [
        {
          ride: "x...x.o.x...x.o.",
          hatClosed: "....x.......x...",
          kick: "o.........g.....",
          brushSnare: "......g........g",
        },
        {
          ride: "x...x.o.x...x.o.",
          hatClosed: "....x.......x...",
          kick: "g...g...g...g...",
          brushSnare: "..........g..g..",
        },
      ],
      high: [
        {
          ride: "X...x.x.X...x.x.",
          hatClosed: "....x.......x...",
          kick: "o.....g...o.....",
          snare: "......g.....o...",
        },
        {
          ride: "X...x.x.X...x.x.",
          hatClosed: "....x.......x...",
          kick: "o...g...o..g....",
          snare: "..........o...g.",
        },
      ],
    },
    fills: {
      light: [{ brushSnare: "............g.oo" }, { snare: "..............go" }],
      full: [
        { snare: "........o.g.o.ox", kick: "..............o." },
        { tomHigh: "..........o.....", tomLow: "............o...", snare: "........g.....ox" },
      ],
    },
    crash: "crash",
    ghost: 0.5,
  },
  swing: 0.6,
  swingGrid: 8,
  humanize: { timing: 11, velocity: 0.12 },
  form: { loop: "AABA", intro: 1, outro: 1 },
  mix: {
    lead: { reverb: 0.25 },
    comp: { gain: 0.5, pan: -0.2 },
    bass: { gain: 0.8 },
    kit: { gain: 0.7, reverb: 0.18 },
  },
  space: {
    size: 0.35,
    decay: 1.1,
    damping: 0.6,
    preDelay: 0.012,
    level: 0.4,
    delayBeats: 0.75,
    delayFeedback: 0.15,
  },
  master: { targetLufs: -16, ceilingDb: -1, character: "warm", tilt: -0.05 },
};
