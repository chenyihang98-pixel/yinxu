import type { StyleDef } from "./types";

/**
 * 可爱俏皮 — staccato marimba hopping over an oom-pah of plucked strings, a
 * music box twinkling on top, sixth chords, cheeky chromatic grace notes and
 * a woodblock in a featherweight kit.
 */
export const cute: StyleDef = {
  id: "cute",
  summary: "跳音马林巴配弦乐拨奏的“嘣嚓”伴奏，八音盒点缀，半音装饰音和木鱼带来俏皮感",
  harmony: {
    modes: {
      major: [
        {
          scale: "major",
          bank: {
            verse: [
              ["I", "IV", "I", "V"],
              ["I", "vi", "ii", "V"],
              ["I", "#idim7", "ii", "V"],
              ["I", "V/VII", "vi", "V"],
              ["I", "iii", "IV", "V"],
              ["I", "I", "IV", "V"],
            ],
            chorus: [
              ["IV", "V", "I", "vi"],
              ["IV", "I", "ii", "V"],
              ["IV", "V", "iii", "vi"],
              ["ii", "V", "I", "I"],
            ],
            bridge: [
              ["vi", "ii", "V", "I"],
              ["IV", "V", "vi", "V"],
            ],
          },
        },
      ],
      minor: [
        {
          // a tiptoeing minor with a proper dominant (the tune takes its leading tone from that chord only)
          scale: "naturalMinor",
          bank: {
            verse: [
              ["i", "iv", "i", "V"],
              ["i", "bVI", "iv", "V"],
              ["i", "V", "i", "V"],
            ],
            chorus: [
              ["bIII", "bVII", "i", "V"],
              ["iv", "bVII", "bIII", "V"],
              ["bVI", "V", "i", "i"],
            ],
          },
        },
      ],
    },
    colour: [0, 0.5],
    extensions: { major: ["6", "add9"], minor: ["7", "7"], dominant: ["7", "7"] },
    variation: 0.5,
    secondary: 0.6,
    borrowed: 0.3,
    sus: 0.2,
    voicing: "close",
    voices: 3,
    register: [55, 74],
    turnaround: { major: ["V", "ii V", "V7"], minor: ["V", "V7"] },
    cadence: {
      major: [
        ["IV", "V"],
        ["ii", "V7"],
      ],
      minor: [
        ["iv", "V"],
        ["bVI", "V"],
      ],
    },
    final: { major: "I6", minor: "i" },
  },
  melody: {
    density: 0.56,
    syncopation: 0.3,
    // a tiny idea, said again a step higher
    motifBars: 1,
    stepBias: 0.6,
    pickup: 0.5,
    ornaments: 0.25,
    space: 0.2,
    // mallets and music boxes sparkle an octave above the plucked strings
    register: 4,
    chorusLift: 3,
    staccato: 0.5,
    chromatic: 0.25,
    cells: ["x.x.x...", "x.xxx...", "x..xx...", "x.x.x.x.", "xx.xx...", "x...x.x.", "x.x_x.x."],
  },
  comp: {
    voice: ["pizzicato", "piano"],
    from: 0,
    patterns: {
      low: [{ rows: { low: "x-......x-......", upper: "....o-......o-.." } }],
      mid: [
        { rows: { low: "X-......x-......", upper: "....x-......x-.." } },
        { rows: { low: "X-..x-..X-..x-..", upper: "..o-..o-..o-..o-" } },
      ],
      high: [
        { rows: { low: "X-..x-..X-..x-..", upper: "..x-..x-..x-.x-." } },
        { rows: { all: "x-x-.x-.x-x-.x-." } },
      ],
    },
  },
  arp: {
    voice: ["musicbox", "bell"],
    from: 0.5,
    pattern: ["broken", "updown"],
    rate: { low: 4, mid: 2, high: 2 },
    register: [72, 96],
    gate: 0.5,
  },
  counter: { voice: ["flute", "vibes"], from: 0.74, mode: "guide" },
  bass: {
    voice: "uprightBass",
    from: 0.15,
    feel: { low: "root", mid: "root", high: "octave" },
    register: [33, 47],
    approach: 0.4,
    gate: 0.7,
    riffs: {
      low: ["1...-...5...-..."],
      mid: ["1...-...5...-...", "1...-.1.5...-..."],
      high: ["1.-.5.-.1.-.5.-.", "1.-.1.-.5.-.5.-a"],
    },
  },
  drums: {
    kit: "pop",
    from: 0.2,
    grooves: {
      low: [
        { kick: "o.......o.......", woodblock: "....o.......o..." },
        { woodblock: "o...o...o.o.o...", shaker: "..g...g...g...g." },
      ],
      mid: [
        {
          kick: "x.......x.......",
          rim: "....o.......o...",
          woodblock: "..o...o...o..oo.",
          hatClosed: "o.o.o.o.o.o.o.o.",
        },
        {
          kick: "x.....x.x.......",
          clap: "....o.......o...",
          hatClosed: "o.g.o.g.o.g.o.g.",
          woodblock: "......o.......o.",
        },
      ],
      high: [
        {
          kick: "X...x...X...x...",
          snare: "....x.......x...",
          hatClosed: "x.o.x.o.x.o.x.o.",
          woodblock: "..o..o....o..o..",
        },
        {
          kick: "X..x..x.X..x....",
          snare: "....x.......x.x.",
          hatClosed: "x.x.x.x.x.x.x.x.",
          tambourine: "..o...o...o...o.",
        },
      ],
    },
    fills: {
      light: [{ woodblock: "............o.oo" }, { snare: "..............oo" }],
      full: [
        {
          tomHigh: "........o.o.....",
          tomMid: "............o...",
          tomLow: "..............o.",
          woodblock: "...............o",
        },
        { snare: "........o.o.oooo" },
      ],
    },
    crash: null,
    ghost: 0.2,
  },
  perc: {
    from: 0.62,
    grooves: [{ shaker: "o.g.o.g.o.g.o.g." }, { tambourine: "....o.......o...", shaker: "..g...g...g...g." }],
  },
  swing: 0,
  humanize: { timing: 6, velocity: 0.1 },
  form: { loop: "AABA", intro: 0.8, outro: 0.8, tail: 1.8 },
  mix: {
    lead: { gain: 0.8, reverb: 0.18, delay: 0.06 },
    comp: { gain: 0.5, pan: -0.2, reverb: 0.15 },
    arp: { gain: 0.26, pan: 0.3, reverb: 0.25, delay: 0.1 },
    counter: { gain: 0.36 },
    bass: { gain: 0.7 },
    kit: { gain: 0.68, reverb: 0.1 },
    perc: { gain: 0.3 },
  },
  space: {
    size: 0.3,
    decay: 0.9,
    damping: 0.5,
    preDelay: 0.008,
    level: 0.35,
    delayBeats: 0.5,
    delayFeedback: 0.18,
  },
  master: { targetLufs: -16, ceilingDb: -1, character: "clean", tilt: 0.15 },
};
