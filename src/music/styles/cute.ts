import type { StyleDef } from "./types";

/**
 * 可爱俏皮 — staccato marimba hopping over an oom-pah of plucked strings, a
 * music box twinkling on top, sixth chords, cheeky chromatic grace notes and
 * a woodblock in a featherweight kit.
 */
export const cute: StyleDef = {
  id: "cute",
  summary: "跳音马林巴配弦乐拨奏的「嘣嚓」伴奏，八音盒点缀，半音装饰音和木鱼带来俏皮感",
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
      low: [{ rows: { low: "X-......X-......", upper: "....x-......x-.." } }],
      mid: [
        { rows: { low: "X-......x-......", upper: "....x-......x-.." } },
        { rows: { low: "X-..x-..X-..x-..", upper: "..o-..o-..o-..o-" } },
      ],
      high: [
        { rows: { low: "X-..x-..X-..x-..", upper: "..o-..o-..o-.o-." } },
        { rows: { all: "x-x-.o-.x-x-.o-." } },
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
        { kick: "o.......o.......", woodblock: "....x.......x..." },
        { woodblock: "x...o...x.o.o...", shaker: "..x...x...x...x." },
      ],
      mid: [
        {
          kick: "o.......o.......",
          rim: "....X.......X...",
          woodblock: "..x...x...x..ox.",
          hatClosed: "x.x.x.x.x.x.x.x.",
        },
        {
          kick: "o.....o.o.......",
          clap: "....o.......o...",
          hatClosed: "X.o.X.o.X.o.X.o.",
          woodblock: "......x.......x.",
        },
      ],
      high: [
        {
          kick: "x...o...o...o...",
          snare: "....o.......o...",
          hatClosed: "X.x.X.x.X.x.X.x.",
          woodblock: "..x..x....x..x..",
        },
        {
          kick: "x..o..o.o..o....",
          snare: "....o.......o.o.",
          hatClosed: "X.x.X.x.X.x.X.x.",
          tambourine: "..X...X...X...X.",
        },
      ],
    },
    fills: {
      light: [{ woodblock: "............x.ox" }, { snare: "..............oo" }],
      full: [
        {
          tomHigh: "........o.o.....",
          tomMid: "............o...",
          tomLow: "..............o.",
          woodblock: "...............x",
        },
        { snare: "........o.o.oooo" },
      ],
    },
    crash: null,
    ghost: 0.2,
  },
  perc: {
    from: 0.62,
    grooves: [{ shaker: "X.x.X.x.X.x.X.x." }, { tambourine: "....X.......X...", shaker: "..X...X...X...X." }],
  },
  // a mallet stroke is nearly all peak: saturation lets it sit in the mix without the limiter pumping.
  // The marimba is the quietest lead at a given gain, so every other one is set a little lower.
  lead: {
    marimba: { gain: 0.62, drive: 0.4 },
    epiano: { gain: 0.67, drive: 0.3 },
    vibes: { gain: 0.64, drive: 0.2 },
    pluck: { gain: 0.53, drive: 0.35 },
    guzheng: { gain: 0.47 },
    dizi: { gain: 0.46 },
  },
  swing: 0,
  humanize: { timing: 6, velocity: 0.1 },
  form: { loop: "AABA", intro: 0.8, outro: 0.8, tail: 1.6 },
  // everything here is staccato, so the tune sits 3–4 LU over the plucked strings and the kit stays
  // feather-light (8 LU under the mix): kick soft, woodblock, rim and hats written to be heard
  mix: {
    lead: { gain: 0.53, reverb: 0.18, delay: 0.06 },
    comp: { gain: 0.56, pan: -0.25, reverb: 0.15, drive: 0.3 },
    arp: { gain: 0.44, pan: 0.3, reverb: 0.25, delay: 0.1 },
    counter: { gain: 0.4 },
    bass: { gain: 0.7 },
    kit: { gain: 1.3, reverb: 0.1, drive: 0.12 },
    perc: { gain: 0.8 },
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
  // marimba, pizzicato and upright bass are all dark voices: tilted up so the music box can sparkle
  master: { targetLufs: -16, ceilingDb: -1, character: "clean", tilt: 0.35 },
};
