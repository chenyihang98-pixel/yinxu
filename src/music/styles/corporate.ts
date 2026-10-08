import type { StyleDef } from "./types";

/**
 * 科技商务 — the product-launch sound: a clean plucked motif, a muted-guitar
 * ostinato ticking in eighths, bright piano chords from the I–V–vi–IV family
 * and a steady, light four-on-the-floor. Layers join one by one.
 */
export const corporate: StyleDef = {
  id: "corporate",
  summary: "干净的电子拨弦动机、八分音符固定音型与明亮的钢琴和弦，稳定的四拍，声部逐层加入",
  harmony: {
    modes: {
      major: [
        {
          scale: "major",
          bank: {
            verse: [
              ["I", "V", "vi", "IV"],
              ["vi", "IV", "I", "V"],
              ["I", "IV", "vi", "V"],
              ["IV", "I", "V", "vi"],
              ["I", "V/VII", "vi", "IV"],
            ],
            chorus: [
              ["IV", "I", "V", "vi"],
              ["I", "V", "vi", "IV", "I", "V", "IV", "IV"],
              ["vi", "IV", "I", "V"],
              ["IV", "V", "vi", "I"],
            ],
            bridge: [
              ["ii", "IV", "vi", "V"],
              ["IV", "V", "vi", "V"],
            ],
            build: [["IV", "IV", "V", "V"]],
          },
        },
      ],
      minor: [
        {
          scale: "naturalMinor",
          bank: {
            verse: [
              ["i", "bVI", "bIII", "bVII"],
              ["bVI", "bVII", "i", "i"],
              ["i", "bVII", "bVI", "bVII"],
            ],
            chorus: [
              ["bVI", "bIII", "bVII", "i"],
              ["bIII", "bVII", "i", "bVI"],
            ],
          },
        },
      ],
    },
    colour: [0.1, 0.6],
    // open, modern colours: added ninths and suspensions rather than sevenths
    extensions: { major: ["add9", "add9"], minor: ["7", "9"], dominant: ["", "sus4"] },
    variation: 0.4,
    secondary: 0.15,
    borrowed: 0.1,
    sus: 0.6,
    voicing: "close",
    voices: 4,
    register: [52, 74],
    turnaround: { major: ["V", "Vsus4 V", "IV V"], minor: ["bVII", "v"] },
    cadence: {
      major: [
        ["IV", "V"],
        ["vi", "IV", "V"],
        ["IV", "Vsus4"],
      ],
      minor: [["bVI", "bVII"]],
    },
    final: { major: "Iadd9", minor: "i" },
  },
  melody: {
    density: 0.42,
    syncopation: 0.4,
    motifBars: 2,
    stepBias: 0.7,
    pickup: 0.3,
    ornaments: 0.05,
    space: 0.35,
    chorusLift: 3,
    hook: 0.35,
    cells: ["x.x.x...", "x..x..x.", "x...x...", "__x.x...", "x.....x.", "x..x...."],
  },
  comp: {
    voice: ["piano", "epiano"],
    from: 0,
    patterns: {
      low: [
        { rows: { all: "X..............." }, strum: 0.012 },
        { rows: { all: "X.......x......." } },
      ],
      mid: [
        { rows: { all: "X.....x...x....." } },
        { rows: { low: "X.......x.......", upper: "..x...x...x...x." } },
      ],
      high: [
        { rows: { all: "X..x..x.X..x..x." } },
        { rows: { all: "x.x.x.x.x.x.x.x." }, gate: 0.8 },
      ],
    },
  },
  pad: { voice: ["pad", "strings"], from: 0.55, register: [52, 76] },
  // with the default plucked lead this is a muted guitar; under any other lead it is the pluck itself
  arp: {
    voice: ["pluck", "guitar"],
    from: 0.25,
    pattern: ["ostinato"],
    rate: { low: 2, mid: 2, high: 1 },
    register: [55, 79],
    gate: 0.5,
  },
  counter: { voice: ["strings", "bell"], from: 0.76, mode: "guide" },
  bass: {
    voice: "fingerBass",
    from: 0.22,
    feel: { low: "root", mid: "root", high: "root" },
    register: [31, 45],
    approach: 0.3,
    gate: 0.85,
    riffs: {
      mid: ["1.....1.1.......", "1...1...1...1..."],
      high: ["1.1.1.1.1.1.1.1.", "1.1.1.1.1.1.1.a."],
    },
  },
  drums: {
    kit: "pop",
    from: 0.35,
    grooves: {
      low: [
        { kick: "x.......x.......", clap: "....x.......x..." },
        { kick: "x...x...x...x...", hatClosed: "..x...x...x...x." },
      ],
      mid: [
        { kick: "x.......x.o.....", snare: "....x.......x...", hatClosed: "X.x.X.x.X.x.X.x." },
        { kick: "x...o...x...o...", clap: "....x.......x...", hatClosed: "x.X.x.X.x.X.x.X." },
      ],
      high: [
        {
          kick: "X.....x.x.x.....",
          snare: "....X.......X...",
          hatClosed: "X.x.X.x.X.x.X.x.",
          hatOpen: "..............x.",
        },
        {
          kick: "X...X...X...X...",
          clap: "....X.......X...",
          snare: "....x.......x...",
          hatClosed: "X.x.X.x.X.x.X.x.",
          hatOpen: "..x...x...x...x.",
        },
      ],
    },
    crash: "crash",
    swell: true,
    ghost: 0.1,
    buildRoll: "snare",
  },
  perc: {
    from: 0.55,
    grooves: [
      { shaker: "X.x.X.x.X.x.X.x." },
      { tambourine: "....X.......X...", shaker: "x.X.x.X.x.X.x.X." },
    ],
  },
  // the plucked synth is all attack: saturation rounds it off so the master limiter is not hit on
  // every note. Other leads are set where the pluck sits.
  lead: {
    pluck: { gain: 0.82, drive: 0.25 },
    piano: { gain: 0.74 },
    epiano: { gain: 0.94, drive: 0.3 },
    marimba: { gain: 1.07, drive: 0.3 },
    vibes: { gain: 0.91, drive: 0.2 },
    bell: { gain: 0.73 },
    guzheng: { gain: 0.71 },
    dizi: { gain: 0.67 },
  },
  swing: 0,
  humanize: { timing: 5, velocity: 0.07 },
  // a wider step from verse to chorus than the engine's default, and an intro without the kit
  form: {
    loop: "AB",
    intro: 1,
    outro: 1,
    energy: { intro: [0.5, 0.01], verse: [0.76, 0], chorus: [1, 0.13] },
  },
  // measured at the default faders: lead 3 LU over the chords, ostinato 13–14 LU under the mix and
  // audible as a part, bass 7 and kit 5–6 LU under the mix
  mix: {
    lead: { gain: 0.82, reverb: 0.25, delay: 0.2 },
    comp: { gain: 0.45, pan: -0.25, reverb: 0.2 },
    arp: { gain: 0.6, pan: 0.28, reverb: 0.2, delay: 0.22 },
    pad: { gain: 0.36 },
    bass: { gain: 1.1, duck: 0.3 },
    kit: { gain: 1.38, drive: 0.15 },
    perc: { gain: 1.14, pan: -0.3, width: 1.3 },
  },
  space: {
    size: 0.45,
    decay: 1.5,
    damping: 0.45,
    preDelay: 0.015,
    level: 0.45,
    delayBeats: 0.75,
    delayFeedback: 0.3,
  },
  master: { targetLufs: -16, ceilingDb: -1, character: "clean", tilt: 0.15 },
};
