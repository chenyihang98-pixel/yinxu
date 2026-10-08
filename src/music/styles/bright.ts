import type { StyleDef } from "./types";

/** 青春欢快 — sunny pop band: piano or guitar comping, finger bass, tight kit. */
export const bright: StyleDef = {
  id: "bright",
  summary: "明亮的流行乐队编配，节奏轻快跳动",
  harmony: {
    modes: {
      major: [
        {
          scale: "major",
          bank: {
            verse: [
              ["I", "V", "vi", "IV"],
              ["I", "vi", "IV", "V"],
              ["I", "IV", "vi", "V"],
              ["I", "iii", "IV", "V"],
              ["I", "V/VII", "vi", "I/V", "IV", "I/III", "ii", "V"],
              ["I", "IV", "I", "V", "vi", "IV", "ii", "V"],
            ],
            chorus: [
              ["IV", "V", "iii", "vi"],
              ["IV", "I", "V", "vi"],
              ["IV", "V", "I", "vi"],
              ["I", "V", "vi", "iii", "IV", "I", "IV", "V"],
              ["ii", "V", "I", "vi"],
            ],
            bridge: [
              ["vi", "iii", "IV", "I"],
              ["ii", "iii", "IV", "V"],
              ["vi", "V", "IV", "V"],
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
              ["i", "bVII", "bVI", "bVII"],
              ["i", "iv", "bVII", "bIII"],
              ["i", "bIII", "bVII", "bVI"],
            ],
            chorus: [
              ["bVI", "bVII", "i", "i"],
              ["bVI", "bIII", "bVII", "i"],
              ["iv", "bVII", "bIII", "bVI"],
            ],
            bridge: [
              ["iv", "i", "bVI", "V"],
              ["bVI", "bVII", "bIII", "V"],
            ],
          },
        },
      ],
    },
    colour: [0, 0.6],
    extensions: { major: ["add9", "maj7"], minor: ["7", "9"], dominant: ["", "7"] },
    variation: 0.6,
    secondary: 0.5,
    borrowed: 0.4,
    sus: 0.5,
    voicing: "close",
    voices: 4,
    register: [52, 77],
    turnaround: { major: ["V", "IV V"], minor: ["bVII", "V"] },
    cadence: {
      major: [
        ["IV", "V"],
        ["ii", "V"],
        ["vi", "IV", "V"],
      ],
      minor: [
        ["bVI", "bVII"],
        ["iv", "V"],
      ],
    },
    final: { major: "I", minor: "i" },
  },
  melody: {
    density: 0.52,
    syncopation: 0.45,
    motifBars: 2,
    stepBias: 0.68,
    pickup: 0.45,
    ornaments: 0.2,
    space: 0.2,
    chorusLift: 4,
    // pop syncopation: pushed three-three-two accents and off-beat entries
    cells: ["x..x..x.", "x.x...x.", "__x.x.x.", "x.x.x...", "x...x.x."],
  },
  comp: {
    voice: ["piano", "guitar"],
    from: 0,
    patterns: {
      low: [
        { rows: { all: "X.......o......." }, strum: 0.012 },
        { rows: { low: "X...............", upper: "....o.......o..." } },
      ],
      mid: [
        { rows: { low: "X.....x.X.......", upper: "....x.......x.x." } },
        { rows: { all: "X..x..x...x.x..." } },
        { rows: { low: "X.......X.......", upper: "..x.x.x...x.x.x." } },
      ],
      high: [
        { rows: { all: "X..x..x.X..x..x." }, gate: 0.9 },
        { rows: { all: "X.x.x.x.X.x.x.x." }, gate: 0.8 },
      ],
    },
  },
  pad: { voice: ["pad", "strings"], from: 0.5, register: [52, 74] },
  arp: {
    voice: ["pluck", "marimba"],
    from: 0.78,
    pattern: ["updown", "broken"],
    rate: { low: 2, mid: 2, high: 2 },
    register: [64, 86],
    gate: 0.7,
  },
  counter: { voice: ["strings", "flute"], from: 0.72, mode: "guide" },
  bass: {
    voice: "fingerBass",
    from: 0.2,
    feel: { low: "root", mid: "syncopated", high: "root" },
    register: [31, 45],
    approach: 0.5,
  },
  drums: {
    kit: "pop",
    from: 0.22,
    grooves: {
      low: [
        { kick: "x.......o.......", rim: "....o.......o...", hatClosed: "o...o...o...o..." },
        { kick: "x.........o.....", rim: "....o.......o...", shaker: "o.g.o.g.o.g.o.g." },
      ],
      mid: [
        { kick: "X.......x.x.....", snare: "....X.......X...", hatClosed: "x.o.x.o.x.o.x.o." },
        { kick: "X.....x...x.....", snare: "....X.......X...", hatClosed: "x.o.x.o.x.o.x.o." },
        { kick: "X..x....x.x.....", snare: "....X.......X...", hatClosed: "x.o.x.o.x.o.x.o." },
      ],
      high: [
        {
          kick: "X.....x.x.x.....",
          snare: "....X.......X...",
          clap: "....x.......x...",
          hatClosed: "x.o.x.o.x.o.x.o.",
          hatOpen: "..............o.",
        },
        {
          kick: "X..x..x...x.x...",
          snare: "....X.......X..g",
          hatClosed: "x.x.x.x.x.x.x.x.",
          hatOpen: "......o.........",
        },
      ],
    },
    crash: "crash",
    swell: true,
    ghost: 0.4,
  },
  perc: {
    from: 0.66,
    grooves: [
      { tambourine: "....x.......x...", shaker: "o.g.o.g.o.g.o.g." },
      { tambourine: "..o...o...o...o." },
    ],
  },
  swing: 0,
  humanize: { timing: 7, velocity: 0.08 },
  form: { loop: "AB", intro: 1, outro: 1 },
  mix: {
    lead: { reverb: 0.25, delay: 0.08 },
    comp: { pan: -0.15 },
    pad: { gain: 0.32 },
    arp: { gain: 0.32 },
  },
  space: {
    size: 0.4,
    decay: 1.3,
    damping: 0.5,
    preDelay: 0.015,
    level: 0.45,
    delayBeats: 0.75,
    delayFeedback: 0.22,
  },
  master: { targetLufs: -16, ceilingDb: -1, character: "clean", tilt: 0.1 },
};
