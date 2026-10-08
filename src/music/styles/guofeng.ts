import type { StyleDef } from "./types";

/**
 * 国风古韵 — a pentatonic guzheng tune with slides and tremolo over rolled and
 * broken chords, a dizi answering in the gaps, and a few drum, woodblock and
 * gong strokes. Time breathes; a lot is left unsaid.
 */
export const guofeng: StyleDef = {
  id: "guofeng",
  summary: "五声音阶的古筝旋律带滑音与摇指，竹笛在留白处应答，点缀木鱼、鼓与锣",
  harmony: {
    modes: {
      major: [
        {
          // 宫调式
          scale: "majorPentatonic",
          bank: {
            verse: [
              ["I", "vi", "IV", "V"],
              ["IV", "V", "iii", "vi"],
              ["I", "V/VII", "vi", "iii", "IV", "I/III", "ii", "V"],
              ["vi", "IV", "V", "I"],
              ["I", "iii", "IV", "V"],
              ["Isus2", "vi7", "ii7", "Vsus4"],
            ],
            chorus: [
              ["IV", "V", "iii", "vi", "ii", "V", "I", "I"],
              ["vi", "IV", "I", "V"],
              ["IV", "V", "vi", "I"],
              ["ii", "V", "I", "vi"],
            ],
            bridge: [
              ["ii", "iii", "IV", "V"],
              ["vi", "iii", "IV", "V"],
            ],
          },
        },
      ],
      minor: [
        {
          // 羽调式: no leading tone, the dominant stays minor
          scale: "minorPentatonic",
          bank: {
            verse: [
              ["i", "bVII", "bVI", "bVII"],
              ["i", "bIII", "bVII", "i"],
              ["bVI", "bVII", "i", "i"],
              ["i", "iv", "bVII", "bIII"],
              ["i", "bVI", "bIII", "bVII"],
            ],
            chorus: [
              ["bVI", "bVII", "v", "i"],
              ["bVI", "bVII", "bIII", "i"],
              ["iv", "bVII", "bIII", "bVI"],
              ["bIII", "bVII", "i", "i"],
            ],
            bridge: [["iv", "v", "bVI", "bVII"]],
          },
        },
      ],
    },
    colour: [0.1, 0.55],
    // colour without the two notes the scale leaves out: added ninths, sixths, suspended dominants
    extensions: { major: ["add9", "69"], minor: ["7", "7"], dominant: ["sus4", "sus4"] },
    variation: 0.4,
    secondary: 0,
    borrowed: 0,
    sus: 0.5,
    voicing: "open",
    voices: 3,
    register: [50, 72],
    turnaround: { major: ["V", "Vsus4", "ii V"], minor: ["bVII", "v"] },
    cadence: {
      major: [
        ["IV", "V"],
        ["ii", "V"],
        ["vi", "Vsus4"],
      ],
      minor: [
        ["bVI", "bVII"],
        ["iv", "v"],
      ],
    },
    final: { major: "Iadd9", minor: "i" },
  },
  melody: {
    density: 0.46,
    syncopation: 0.25,
    motifBars: 2,
    stepBias: 0.72,
    pickup: 0.35,
    ornaments: 0.6,
    space: 0.5,
    // the zither's singing register, clear of its own accompaniment
    register: 4,
    chorusLift: 3,
    introLead: true,
    tremolo: 0.42,
    // a long note, then a quick turn of two or three: the gait of a plucked zither
    cells: ["x.....xx", "x...x.xx", "x..xx...", "x.xxx...", "x.x.x...", "x.......", "xx..x..."],
  },
  comp: {
    voice: ["guzheng", "nylon"],
    from: 0,
    patterns: {
      low: [
        { rows: { all: "X..............." }, strum: 0.05 },
        { rows: { "1": "X...............", "3": "....o...........", top: "........o......." } },
      ],
      mid: [
        {
          rows: {
            "1": "X.......x.......",
            "2": "..o.......o.....",
            "3": "....o.......o...",
            top: "......o.......o.",
          },
        },
        { rows: { low: "X...............", upper: "........o......." }, strum: 0.04 },
        {
          rows: {
            "1": "X...............",
            "2": "..o...o...o...o.",
            "3": "....o.......o...",
            top: "........o.......",
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
            top: "...o...o...o...o",
          },
        },
      ],
    },
  },
  pad: { voice: ["strings", "pad"], from: 0.48, register: [52, 74] },
  // the flute floats above the zither rather than underneath it
  counter: { voice: ["dizi", "strings"], from: 0.3, mode: "guide", placement: "above" },
  bass: {
    voice: "fingerBass",
    from: 0.45,
    feel: { low: "root", mid: "root", high: "root" },
    register: [33, 45],
    approach: 0.1,
    gate: 0.95,
    calm: true,
  },
  drums: {
    kit: "acoustic",
    from: 0.3,
    grooves: {
      low: [
        { woodblock: "....o.......o..." },
        { woodblock: "o.......o...o...|o.......o......." },
      ],
      mid: [
        { tomLow: "x.........o.....", woodblock: "....o.......o.o." },
        { tomLow: "x.......o.......", woodblock: "..o...o...o...o." },
      ],
      high: [
        { tomLow: "X.....x.x.......", woodblock: "..x...x...x.x.x." },
        { taiko: "X.......x.....x.", tomLow: "....x.......x...", woodblock: "..o...o...o...o." },
      ],
    },
    fills: {
      light: [{ woodblock: "............o.oo" }, { tomLow: "..............o." }],
      full: [
        { tomLow: "........o...o.oo" },
        { tomHigh: "........o.o.....", tomLow: "............o.oX" },
      ],
    },
    crash: "gong",
    ghost: 0,
  },
  swing: 0,
  rubato: 0.5,
  humanize: { timing: 14, velocity: 0.12 },
  form: { loop: "AB", intro: 1.2, outro: 1.3, tail: 3 },
  mix: {
    lead: { reverb: 0.4, delay: 0.12 },
    comp: { gain: 0.48, pan: -0.2, reverb: 0.35 },
    counter: { gain: 0.42, pan: 0.3, reverb: 0.5 },
    pad: { gain: 0.3, reverb: 0.5 },
    bass: { gain: 0.6 },
    kit: { gain: 0.6, reverb: 0.4 },
  },
  space: {
    size: 0.7,
    decay: 2.6,
    damping: 0.45,
    preDelay: 0.025,
    level: 0.6,
    delayBeats: 1,
    delayFeedback: 0.25,
  },
  master: { targetLufs: -16, ceilingDb: -1, character: "warm", tilt: 0 },
};
