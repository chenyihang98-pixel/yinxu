import type { StyleDef } from "./types";

/** 治愈木吉他 — fingerpicked and strummed guitar, gentle bass, shaker and brushed kit. */
export const acoustic: StyleDef = {
  id: "acoustic",
  summary: "木吉他分解和弦与扫弦，配轻柔的沙锤和鼓",
  harmony: {
    modes: {
      major: [
        {
          scale: "major",
          bank: {
            verse: [
              ["I", "V/VII", "vi", "IV"],
              ["I", "IV", "I", "V"],
              ["I", "V", "vi", "IV"],
              ["I", "iii", "IV", "V"],
              ["I", "I/III", "IV", "V"],
              ["vi", "IV", "I", "V"],
            ],
            chorus: [
              ["IV", "I", "V", "vi"],
              ["IV", "V", "I", "vi"],
              ["IV", "I/III", "ii", "V"],
            ],
            bridge: [
              ["vi", "V", "IV", "V"],
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
              ["i", "bVII", "bVI", "bVII"],
              ["i", "bIII", "bVII", "iv"],
              ["i", "iv", "bVII", "bIII"],
            ],
            chorus: [
              ["bVI", "bIII", "bVII", "i"],
              ["bIII", "bVII", "i", "bVI"],
            ],
            bridge: [["iv", "bVI", "bIII", "bVII"]],
          },
        },
      ],
    },
    colour: [0.15, 0.65],
    extensions: { major: ["add9", "maj7"], minor: ["7", "9"], dominant: ["", "7"] },
    variation: 0.6,
    secondary: 0.35,
    borrowed: 0.4,
    sus: 0.6,
    voicing: "open",
    voices: 4,
    register: [50, 76],
    turnaround: { major: ["V", "Vsus4 V"], minor: ["bVII", "V"] },
    cadence: {
      major: [
        ["IV", "V"],
        ["ii", "V"],
        ["IV", "Vsus4 V"],
      ],
      minor: [
        ["bVI", "bVII"],
        ["iv", "V"],
      ],
    },
    final: { major: "Iadd9", minor: "i" },
  },
  melody: {
    density: 0.44,
    syncopation: 0.35,
    motifBars: 2,
    stepBias: 0.7,
    pickup: 0.5,
    ornaments: 0.2,
    space: 0.35,
    // the tune sits on the upper strings, above the picking pattern
    register: 3,
    chorusLift: 3,
    // a sung folk line: quarter and two eighths, gentle pickups
    cells: ["x...x.x.", "x.x.x...", "x.....x.", "__x.x.x.", "x..x...."],
  },
  comp: {
    voice: ["guitar", "nylon"],
    from: 0,
    patterns: {
      // alone in an intro the picking is played out (mf), not whispered under a tune that is not there yet
      low: [
        {
          rows: {
            "1": "X...............",
            "2": "....X...........",
            "3": "........X.......",
            top: "............X...",
          },
        },
        {
          rows: {
            "1": "X.......X.......",
            "3": "..x.......x.....",
            "2": "....X.......X...",
            top: "......x.......x.",
          },
        },
      ],
      mid: [
        {
          rows: {
            "1": "X.......x.......",
            "2": "..o...o...o...o.",
            "3": "....x.......x...",
            top: "......x.......o.",
          },
        },
        { rows: { all: "X...x.o...o.x.o." }, strum: 0.016, strumAlternate: true },
      ],
      high: [
        { rows: { all: "x...x.o.g.o.x.o." }, strum: 0.014, strumAlternate: true },
        { rows: { all: "X..o..x.x..o..x." }, strum: 0.012 },
      ],
    },
  },
  pad: { voice: ["pad", "strings"], from: 0.6, register: [52, 74] },
  counter: { voice: ["flute", "strings"], from: 0.72, mode: "guide" },
  bass: {
    voice: "fingerBass",
    from: 0.32,
    feel: { low: "root", mid: "root", high: "syncopated" },
    register: [31, 45],
    approach: 0.45,
  },
  drums: {
    kit: "acoustic",
    from: 0.4,
    grooves: {
      low: [{ kick: "x.........o.....", rim: "....x.......x..." }],
      mid: [
        { kick: "x.....o.x.......", snare: "....x.......x...", hatClosed: "x.o.x.o.x.o.x.o." },
        { kick: "x.......x.o.....", rim: "....X.......X...", hatClosed: "x.o.x.o.x.o.x.o." },
      ],
      high: [
        {
          kick: "X.....x.x.x.....",
          snare: "....X.......X...",
          hatClosed: "X.x.X.x.X.x.X.x.",
          hatOpen: "..............x.",
        },
      ],
    },
    crash: "crash",
    ghost: 0.3,
  },
  perc: {
    from: 0.28,
    grooves: [
      { shaker: "x.o.x.o.x.o.x.o." },
      { shaker: "x.o.x.o.x.o.x.o.", tambourine: "....x.......x..." },
    ],
  },
  // other leads are set where the guitar sits: mellow keys and mallets up, the piercing dizi and guzheng down
  lead: {
    piano: { gain: 0.87 },
    epiano: { gain: 1, drive: 0.3 },
    pluck: { gain: 0.88, drive: 0.2 },
    marimba: { gain: 1.1, drive: 0.3 },
    vibes: { gain: 1, drive: 0.2 },
    guzheng: { gain: 0.73 },
    dizi: { gain: 0.72 },
  },
  swing: 0,
  humanize: { timing: 11, velocity: 0.11 },
  form: { loop: "AB", intro: 1, outro: 1, tail: 1.7 },
  // two guitars a little apart in a small room; the kit (chorus only) stays some 10 LU under the mix
  mix: {
    lead: { pan: 0.1, reverb: 0.32 },
    comp: { gain: 0.62, pan: -0.3, width: 1.1, reverb: 0.3 },
    bass: { gain: 0.72 },
    perc: { gain: 1.2, pan: 0.3 },
    kit: { gain: 1.34, drive: 0.12, reverb: 0.2 },
  },
  space: {
    size: 0.45,
    decay: 1.5,
    damping: 0.5,
    preDelay: 0.012,
    level: 0.5,
    delayBeats: 0.75,
    delayFeedback: 0.18,
  },
  // the string voices carry little above 6 kHz and "warm" shelves that down again: tilted back up
  master: { targetLufs: -16, ceilingDb: -1, character: "warm", tilt: 0.3 },
};
