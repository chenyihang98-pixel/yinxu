import type { Groove, StyleDef } from "./types";

/** 咚咚锵: drum, cymbal and gong for a lunar-new-year tune led by guzheng or dizi. */
const LUOGU: Groove[] = [
  { tomLow: "x.x.....x.x.....", hatOpen: "....x.......x...", woodblock: "..........o...o." },
  {
    tomLow: "x..x..x.x..x....",
    hatOpen: "......x.......x.",
    gong: "X...............|................",
  },
];

/**
 * 节日喜庆 — bells and a music box over a bouncing root-and-fifth bass, sleigh
 * bells jingling in eighths and a tambourine on the backbeat. With a guzheng
 * or dizi in the lead the tune turns pentatonic and the sleigh bells give way
 * to drum, cymbal and gong: the same style serves Christmas and the new year.
 */
export const festive: StyleDef = {
  id: "festive",
  summary: "明亮跳跃的节日旋律与根音五度贝斯，铃声主奏配雪橇铃和铃鼓，古筝或竹笛主奏则配五声音阶与锣鼓",
  harmony: {
    modes: {
      major: [
        {
          scale: "major",
          leads: { guzheng: 0, dizi: 0 },
          bank: {
            verse: [
              ["I", "IV", "I", "V"],
              ["I", "vi", "IV", "V"],
              ["I", "V", "vi", "iii", "IV", "I", "IV", "V"],
              ["I", "I/III", "IV", "V"],
              ["I", "V/VII", "vi", "V"],
            ],
            chorus: [
              ["IV", "V", "I", "vi"],
              ["IV", "I", "V", "I"],
              ["I", "IV", "V", "I"],
              ["IV", "V", "iii", "vi", "ii", "V", "I", "I"],
            ],
            bridge: [
              ["vi", "ii", "V", "I"],
              ["IV", "V", "vi", "V"],
            ],
          },
        },
        {
          scale: "majorPentatonic",
          weight: 0.3,
          leads: { guzheng: 1, dizi: 1 },
          bank: {
            verse: [
              ["I", "vi", "ii", "V"],
              ["I", "IV", "V", "I"],
              ["I", "vi", "IV", "V"],
              ["I", "V", "vi", "iii"],
            ],
            chorus: [
              ["IV", "V", "I", "vi"],
              ["ii", "V", "I", "I"],
              ["IV", "V", "iii", "vi"],
            ],
          },
        },
      ],
      minor: [
        {
          scale: "naturalMinor",
          leads: { guzheng: 0, dizi: 0 },
          bank: {
            verse: [
              ["i", "bVII", "bVI", "V"],
              ["i", "iv", "bVII", "bIII"],
              ["i", "iv", "V", "i"],
            ],
            chorus: [
              ["bIII", "bVII", "i", "V"],
              ["bVI", "bVII", "i", "i"],
              ["iv", "bVII", "bIII", "V"],
            ],
          },
        },
        {
          scale: "minorPentatonic",
          weight: 0.3,
          leads: { guzheng: 1, dizi: 1 },
          bank: {
            verse: [
              ["i", "bVII", "bVI", "bVII"],
              ["i", "bIII", "bVII", "i"],
              ["i", "iv", "bVII", "bIII"],
            ],
            chorus: [
              ["bVI", "bVII", "i", "i"],
              ["bIII", "bVII", "i", "i"],
            ],
          },
        },
      ],
    },
    colour: [0, 0.45],
    extensions: { major: ["6", "add9"], minor: ["7", "7"], dominant: ["7", "7"] },
    variation: 0.5,
    secondary: 0.5,
    borrowed: 0.2,
    sus: 0.3,
    voicing: "close",
    voices: 4,
    register: [55, 77],
    turnaround: { major: ["V", "V7", "IV V"], minor: ["V", "bVII"] },
    cadence: {
      major: [
        ["IV", "V"],
        ["ii", "V7"],
      ],
      minor: [
        ["iv", "V"],
        ["bVI", "bVII"],
      ],
    },
    final: { major: "I", minor: "i" },
  },
  melody: {
    density: 0.55,
    syncopation: 0.3,
    motifBars: 2,
    stepBias: 0.62,
    pickup: 0.5,
    ornaments: 0.2,
    space: 0.2,
    chorusLift: 3,
    tremolo: 0.2,
    // jingling: three even notes and a long one, skipping dotted figures
    cells: ["x.x.x...", "x.x.x.x.", "x..xx...", "x...x.x.", "xx..x...", "x.x...x."],
  },
  comp: {
    voice: ["piano", "marimba"],
    from: 0,
    patterns: {
      low: [{ rows: { low: "x.......x.......", upper: "....o.......o..." } }],
      mid: [
        { rows: { low: "X.......x.......", upper: "....x.x.....x.x." } },
        { rows: { low: "X...x...X...x...", upper: "..o...o...o...o." } },
      ],
      high: [
        { rows: { low: "X...x...X...x...", upper: "..x.x.x...x.x.x." } },
        { rows: { all: "X.x.x.x.X.x.x.x." }, gate: 0.7 },
      ],
    },
  },
  pad: { voice: ["strings", "pad"], from: 0.6, register: [52, 74] },
  arp: {
    voice: ["musicbox", "pluck"],
    from: 0.55,
    pattern: ["updown", "broken"],
    rate: { low: 2, mid: 2, high: 2 },
    register: [67, 91],
    gate: 0.6,
  },
  counter: { voice: ["brass", "strings"], from: 0.78, mode: "guide" },
  bass: {
    voice: "fingerBass",
    from: 0.2,
    feel: { low: "root", mid: "root", high: "octave" },
    register: [33, 47],
    approach: 0.4,
    gate: 0.75,
    riffs: {
      low: ["1...-...5...-..."],
      mid: ["1...-...5...-...", "1...-.1.5...-..."],
      high: ["1.-.5.-.1.-.5.-.", "1.-.1.-.5.-.5.-a"],
    },
  },
  drums: {
    kit: "pop",
    from: 0.25,
    grooves: {
      low: [{ kick: "x.......x.......", tambourine: "....o.......o..." }],
      mid: [
        { kick: "X.......x.x.....", snare: "....x.......x...", hatClosed: "x.o.x.o.x.o.x.o." },
        { kick: "X...x...X...x...", clap: "....x.......x...", hatClosed: "o.x.o.x.o.x.o.x." },
      ],
      high: [
        {
          kick: "X.....x.x.x.....",
          snare: "....X.......X...",
          clap: "....x.......x...",
          hatClosed: "x.x.x.x.x.x.x.x.",
          hatOpen: "..............o.",
        },
        {
          kick: "X...X...X...X...",
          snare: "....X.......X.x.",
          hatClosed: "x.x.x.x.x.x.x.x.",
          tambourine: "..x...x...x...x.",
        },
      ],
    },
    crash: "crash",
    swell: true,
    ghost: 0.2,
  },
  perc: {
    from: 0.2,
    grooves: [
      { sleighBell: "x.o.x.o.x.o.x.o." },
      { sleighBell: "x.o.x.o.x.o.x.o.", tambourine: "....x.......x..." },
    ],
    byLead: { guzheng: LUOGU, dizi: LUOGU },
  },
  swing: 0,
  humanize: { timing: 6, velocity: 0.09 },
  form: { loop: "AB", intro: 0.8, outro: 0.9, tail: 2.5 },
  mix: {
    lead: { gain: 0.78, reverb: 0.3, delay: 0.1 },
    comp: { gain: 0.5, pan: -0.15 },
    arp: { gain: 0.26, pan: 0.3, delay: 0.12 },
    pad: { gain: 0.3 },
    counter: { gain: 0.4, pan: 0.2 },
    bass: { gain: 0.72 },
    kit: { gain: 0.75 },
    perc: { gain: 0.34, pan: 0.25, width: 1.3 },
  },
  space: {
    size: 0.5,
    decay: 1.6,
    damping: 0.4,
    preDelay: 0.015,
    level: 0.45,
    delayBeats: 0.75,
    delayFeedback: 0.2,
  },
  master: { targetLufs: -16, ceilingDb: -1, character: "clean", tilt: 0.18 },
};
