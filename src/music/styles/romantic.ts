import type { StyleDef } from "./types";

/**
 * 浪漫温馨 — a warm piano singing over its own flowing arpeggios, strings that
 * hold the harmony and answer with a counter-melody, and bright major
 * progressions (IV–V–iii–vi, the descending canon bass) coloured by
 * secondary dominants. Brushes join only when the energy rises.
 */
export const romantic: StyleDef = {
  id: "romantic",
  summary: "温暖的钢琴旋律与流动的分解和弦，弦乐铺底并以副旋律应答，明亮的大调和声点缀副属和弦",
  harmony: {
    modes: {
      major: [
        {
          scale: "major",
          bank: {
            verse: [
              ["I", "V/VII", "vi", "I/V", "IV", "I/III", "ii", "V"],
              ["IV", "V", "iii", "vi"],
              ["I", "vi", "IV", "V"],
              ["I", "iii", "IV", "V"],
              ["I", "V/VII", "vi", "IV"],
              ["Imaj7", "vi7", "ii7", "V7"],
            ],
            chorus: [
              ["IV", "V", "iii", "vi", "ii", "V", "I", "I"],
              ["IV", "V", "iii", "vi"],
              ["ii", "V", "I", "vi"],
              ["IV", "I/III", "ii", "V"],
            ],
            bridge: [
              ["vi", "iii", "IV", "V"],
              ["IV", "iv", "I", "V7/ii"],
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
              ["i", "iv", "bVII", "bIII"],
              ["i", "bVII", "bVI", "V"],
            ],
            chorus: [
              ["bVI", "bVII", "bIII", "i"],
              ["iv", "bVII", "bIII", "bVI"],
              ["bVI", "V", "i", "i"],
            ],
          },
        },
      ],
    },
    colour: [0.3, 0.8],
    extensions: { major: ["maj7", "maj9"], minor: ["7", "9"], dominant: ["7", "9"] },
    variation: 0.6,
    secondary: 0.7,
    borrowed: 0.5,
    sus: 0.6,
    voicing: "open",
    voices: 4,
    register: [50, 74],
    turnaround: { major: ["V7", "Vsus4 V", "ii7 V7"], minor: ["V", "bVII"] },
    cadence: {
      major: [
        ["IV", "V"],
        ["ii7", "V7"],
        ["IV", "iv"],
      ],
      minor: [
        ["iv", "V"],
        ["bVI", "V"],
      ],
    },
    final: { major: "Iadd9", minor: "i" },
  },
  melody: {
    density: 0.38,
    syncopation: 0.2,
    motifBars: 2,
    stepBias: 0.74,
    pickup: 0.5,
    ornaments: 0.35,
    space: 0.4,
    chorusLift: 4,
    cells: ["x...x.x.", "x.....x.", "x...x...", "x.x.x...", "x.......", "x..x....", "__x.x.x."],
  },
  // the melody's own instrument: a pianist accompanying herself
  comp: {
    voice: "piano",
    from: 0,
    patterns: {
      low: [
        { rows: { "1": "X...............", "2": "....o.......o...", "3": "........o......." } },
        {
          rows: {
            "1": "X...............",
            "3": "....o...........",
            "2": "........o.......",
            top: "............o...",
          },
        },
      ],
      mid: [
        {
          rows: {
            "1": "X...............",
            "2": "..o...o...o...o.",
            "3": "....o.......o...",
            "4": "........o.......",
          },
        },
        {
          rows: {
            "1": "X.......x.......",
            "2": "..o.......o.....",
            "3": "....o.......o...",
            top: "......o.......o.",
          },
        },
      ],
      high: [
        {
          rows: {
            "1": "X.......x.......",
            "2": "..o...o...o...o.",
            "3": "....o.......o...",
            top: "......x.......x.",
          },
        },
        {
          rows: {
            "1": "X...x...X...x...",
            "2": ".o...o...o...o..",
            "3": "..o...o...o...o.",
            "4": "...o...o...o...o",
          },
        },
      ],
    },
  },
  pad: { voice: ["strings", "pad"], from: 0.25, register: [52, 76], voices: 4 },
  counter: { voice: ["strings", "flute"], from: 0.4, mode: "guide" },
  bass: {
    voice: "fingerBass",
    from: 0.45,
    feel: { low: "root", mid: "root", high: "root" },
    register: [31, 45],
    approach: 0.3,
    gate: 0.95,
  },
  drums: {
    kit: "brush",
    from: 0.5,
    grooves: {
      low: [{ kick: "o...............", brushSnare: "....o.......o..." }],
      mid: [{ kick: "x.........o.....", brushSnare: "....o.......o...", hatClosed: "..g...g...g...g." }],
      high: [{ kick: "x.....o.x.......", brushSnare: "....x.......x...", ride: "o.o.o.o.o.o.o.o." }],
    },
    fills: {
      light: [{ brushSnare: "............g.oo" }],
      full: [{ brushSnare: "........o.g.o.oo", tomLow: "..............o." }],
    },
    crash: null,
    swell: true,
    ghost: 0.2,
  },
  perc: { from: 0.62, grooves: [{ shaker: "..g...g...g...g." }] },
  swing: 0,
  rubato: 0.45,
  humanize: { timing: 14, velocity: 0.12 },
  form: { loop: "AB", intro: 1.2, outro: 1.3, tail: 3 },
  mix: {
    lead: { gain: 0.78, reverb: 0.42, delay: 0.06 },
    comp: { gain: 0.5, reverb: 0.35 },
    pad: { gain: 0.4, reverb: 0.5 },
    counter: { gain: 0.4, pan: 0.25, reverb: 0.5 },
    bass: { gain: 0.62 },
    kit: { gain: 0.5, reverb: 0.3 },
    perc: { gain: 0.25 },
  },
  space: {
    size: 0.7,
    decay: 2.4,
    damping: 0.45,
    preDelay: 0.025,
    level: 0.55,
    delayBeats: 1,
    delayFeedback: 0.2,
  },
  master: { targetLufs: -16, ceilingDb: -1, character: "warm", tilt: 0.02 },
};
