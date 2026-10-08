import type { StyleDef } from "./types";

/** 慵懒松弛 — lo-fi: electric-piano sevenths, lazy sixteenth swing, dusty kit, warm master. */
export const chill: StyleDef = {
  id: "chill",
  summary: "Lo-fi 电钢琴七和弦与慵懒摇摆的鼓点",
  harmony: {
    modes: {
      major: [
        {
          scale: "major",
          bank: {
            verse: [
              ["Imaj7", "vi7", "ii7", "V7"],
              ["IVmaj7", "iii7", "ii7", "Imaj7"],
              ["ii7", "V7", "Imaj7", "vi7"],
              ["Imaj7", "IVmaj7", "iii7", "vi7"],
              ["IVmaj7", "V7", "iii7", "vi7"],
              ["Imaj7", "iii7", "IVmaj7", "iv6"],
            ],
            chorus: [
              ["IVmaj7", "iii7", "ii7", "V7"],
              ["ii7", "V7", "iii7", "vi7"],
              ["IVmaj7", "V7", "Imaj7", "Imaj7"],
              ["vi7", "ii7", "V7", "Imaj7"],
            ],
            bridge: [
              ["vi7", "ii7", "V7", "Imaj7"],
              ["IVmaj7", "iv6", "iii7", "V7/ii"],
            ],
          },
        },
      ],
      minor: [
        {
          scale: "naturalMinor",
          bank: {
            verse: [
              ["i7", "bVImaj7", "bIIImaj7", "bVII7"],
              ["i7", "iv7", "i7", "v7"],
              ["iv7", "bVII7", "bIIImaj7", "bVImaj7"],
              ["i7", "bIIImaj7", "iv7", "V7"],
            ],
            chorus: [
              ["bVImaj7", "bVII7", "i7", "i7"],
              ["iv7", "bVII7", "bIIImaj7", "bVImaj7"],
              ["bVImaj7", "v7", "i7", "bIIImaj7"],
            ],
            bridge: [["iv7", "v7", "bVImaj7", "V7"]],
          },
        },
      ],
    },
    colour: [0.5, 0.95],
    variation: 0.4,
    secondary: 0.55,
    borrowed: 0.5,
    sus: 0.3,
    voicing: "close",
    voices: 4,
    register: [50, 72],
    turnaround: { major: ["V7sus4", "ii7 V7"], minor: ["V7", "bVII7", "iiø V7"] },
    cadence: {
      major: [
        ["ii7", "V7"],
        ["IVmaj7", "V7sus4"],
      ],
      minor: [
        ["iv7", "V7"],
        ["bVImaj7", "bVII7"],
      ],
    },
    final: { major: "Imaj9", minor: "i9" },
  },
  melody: {
    density: 0.42,
    syncopation: 0.6,
    motifBars: 2,
    stepBias: 0.68,
    pickup: 0.4,
    ornaments: 0.3,
    space: 0.45,
    register: 2,
    chorusLift: 2,
    // behind the beat: late entries, dotted pushes, air between the notes
    cells: ["__x.x...", "x..x....", "x.....x.", "__x...x.", "x.x..x..", "x...__x."],
  },
  comp: {
    voice: "epiano",
    from: 0,
    patterns: {
      low: [
        { rows: { all: "X..............." }, strum: 0.022 },
        { rows: { all: "X.........o....." }, strum: 0.02 },
      ],
      mid: [
        { rows: { all: "X.....o.....g..." }, strum: 0.018 },
        { rows: { all: "x.....x...o....." }, strum: 0.015 },
        { rows: { low: "X.......o.......", upper: "..o...o...o...g." } },
      ],
      high: [
        { rows: { all: "X..x..o...x...o." }, strum: 0.012 },
        { rows: { all: "x.....x.x.....o." }, strum: 0.012, push: true },
      ],
    },
  },
  pad: { voice: ["pad", "airpad"], from: 0.42, register: [50, 72] },
  counter: { voice: ["vibes", "flute"], from: 0.78, mode: "guide" },
  bass: {
    voice: "fingerBass",
    from: 0.15,
    feel: { low: "root", mid: "root", high: "syncopated" },
    register: [31, 45],
    approach: 0.55,
    gate: 0.9,
  },
  drums: {
    kit: "lofi",
    from: 0.12,
    grooves: {
      low: [
        { kick: "x.......o.x.....", rim: "....x.......x...", hatClosed: "o...o...o...o..." },
        { kick: "X.........x.....", rim: "....x.......x...", hatClosed: "o.g.o.g.o.g.o.g." },
      ],
      mid: [
        { kick: "X.....x...x.....", snare: "....X.......X...", hatClosed: "x.o.x.o.x.o.x.og" },
        { kick: "X..x......x..g..", snare: "....X.......X...", hatClosed: "x.o.x.o.x.o.x.o." },
      ],
      high: [
        {
          kick: "X.....x.x..x....",
          snare: "....X.......X..g",
          hatClosed: "x.oxx.o.x.oxx.o.",
        },
        {
          kick: "X..x....x.x.....",
          snare: "....X..g....X...",
          hatClosed: "xgogxgogxgogxgog",
          hatOpen: "..............o.",
        },
      ],
    },
    fills: {
      light: [{ snare: "..............og" }, { kick: "..............o.", snare: "...............o" }],
      full: [
        { snare: "............o.gx" },
        { tomMid: "..........o.....", tomLow: "............o...", snare: "..............ox" },
      ],
    },
    crash: null,
    ghost: 0.5,
    lag: { snare: 12, rim: 10, clap: 12 },
  },
  perc: {
    from: 0.5,
    grooves: [
      { shaker: "..o...o...o...o." },
      { fingerSnap: "....o.......o...", shaker: "..g...g...g...g." },
    ],
  },
  swing: 0.42,
  swingGrid: 16,
  humanize: { timing: 14, velocity: 0.12 },
  form: { loop: "AB", intro: 1, outro: 1 },
  mix: {
    lead: { reverb: 0.25, highCut: 9000, drive: 0.12, chorus: 0.15 },
    comp: { gain: 0.6, chorus: 0.3, highCut: 6500, drive: 0.1 },
    bass: { highCut: 2500 },
    kit: { highCut: 9000, drive: 0.15 },
  },
  space: {
    size: 0.32,
    decay: 1.1,
    damping: 0.72,
    preDelay: 0.01,
    level: 0.4,
    delayBeats: 0.75,
    delayFeedback: 0.25,
  },
  master: { targetLufs: -16, ceilingDb: -1, character: "lofi", tilt: -0.35 },
};
