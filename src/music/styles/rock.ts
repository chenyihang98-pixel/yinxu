import type { StyleDef } from "./types";

/**
 * 摇滚能量 — overdriven power chords in fifths, a finger bass driving eighth
 * notes under them, a roomy acoustic kit with a crash at every section and
 * tom fills, and a pentatonic lead on top.
 */
export const rock: StyleDef = {
  id: "rock",
  summary: "失真吉他的五度强力和弦、八分音符推进的贝斯、原声鼓组的镲片与通鼓过门，五声音阶主奏",
  harmony: {
    modes: {
      major: [
        {
          scale: "majorPentatonic",
          bank: {
            verse: [
              ["I", "IV", "V", "IV"],
              ["I", "V", "vi", "IV"],
              ["I", "bVII", "IV", "I"],
              ["I", "IV", "I", "V"],
            ],
            chorus: [
              ["IV", "V", "I", "vi"],
              ["IV", "I", "V", "V"],
              ["bVI", "bVII", "I", "I"],
              ["vi", "IV", "I", "V"],
            ],
            bridge: [["ii", "IV", "V", "V"]],
            build: [["IV", "IV", "V", "V"]],
          },
        },
      ],
      minor: [
        {
          scale: "minorPentatonic",
          bank: {
            verse: [
              ["i", "bVI", "bIII", "bVII"],
              ["i", "bVII", "bVI", "bVII"],
              ["i", "bIII", "bVII", "iv"],
              ["i", "i", "bVI", "bVII"],
              ["i", "bVII", "iv", "i"],
            ],
            chorus: [
              ["bVI", "bVII", "i", "i"],
              ["bVI", "bIII", "bVII", "i"],
              ["bIII", "bVII", "i", "bVI"],
              ["iv", "bVI", "bVII", "i"],
            ],
            bridge: [["iv", "bVI", "bVII", "bVII"]],
            build: [["bVI", "bVI", "bVII", "bVII"]],
          },
        },
      ],
    },
    // power chords have no third to colour
    colour: [0, 0.15],
    extensions: { major: ["", ""], minor: ["", ""], dominant: ["", ""] },
    variation: 0.2,
    secondary: 0,
    borrowed: 0.2,
    sus: 0.3,
    voicing: "power",
    voices: 3,
    register: [40, 59],
    turnaround: { major: ["V", "bVII", "IV V"], minor: ["bVII", "v", "bVI bVII"] },
    cadence: {
      major: [
        ["IV", "V"],
        ["bVI", "bVII"],
      ],
      minor: [["bVI", "bVII"]],
    },
    final: { major: "I", minor: "i" },
  },
  melody: {
    density: 0.5,
    syncopation: 0.45,
    motifBars: 2,
    stepBias: 0.62,
    pickup: 0.45,
    ornaments: 0.15,
    space: 0.25,
    // a guitar solo sits on the upper strings, clear of the chords
    register: 5,
    chorusLift: 4,
    hook: 0.3,
    cells: ["x..x..x.", "x.x.x...", "x...x.x.", "__x.x.x.", "x.x.x.x.", "x.xx....", "x.....x."],
  },
  // every lead goes through the same amp (mix.lead.drive); quiet, fast-decaying ones are turned up against the guitars
  lead: {
    piano: { gain: 0.7 },
    epiano: { gain: 0.75 },
    pluck: { gain: 0.7 },
    marimba: { gain: 0.85 },
    vibes: { gain: 0.72 },
    guzheng: { gain: 0.64, highCut: 5500 },
    dizi: { gain: 0.58, highCut: 5500 },
  },
  comp: {
    voice: "overdrive",
    from: 0,
    patterns: {
      low: [{ rows: { all: "X.......x......." } }],
      mid: [
        { rows: { all: "X...x.x...x.x..." } },
        { rows: { all: "x.x.x.x.x.x.x.x." }, gate: 0.6 },
      ],
      high: [
        { rows: { all: "X.x.x.X.x.x.X.x." }, gate: 0.7 },
        { rows: { all: "X..x..x.X..x..x." }, push: true },
        { rows: { all: "X.xxx.xxX.xxx.xx" }, gate: 0.6 },
      ],
    },
  },
  pad: { voice: ["organ", "pad"], from: 0.78, register: [52, 72] },
  bass: {
    voice: "fingerBass",
    from: 0.15,
    feel: { low: "root", mid: "root", high: "root" },
    register: [28, 43],
    approach: 0.35,
    gate: 0.85,
    riffs: {
      mid: ["1.1.1.1.1.1.1.1."],
      // roots only, like the guitar above: fifths and octaves would rub against the power chords
      high: ["1.1.1.1.1.1.1.1.", "1.1.1.1.1.1.1.a."],
    },
  },
  drums: {
    kit: "acoustic",
    from: 0.1,
    grooves: {
      low: [{ kick: "x.......x.......", snare: "....x.......x...", hatClosed: "x...o...x...o..." }],
      mid: [
        { kick: "X.......x.x.....", snare: "....X.......X...", hatClosed: "x.x.x.x.x.x.x.x." },
        {
          kick: "X.....x.x.......",
          snare: "....X.......X...",
          hatClosed: "x.x.x.x.x.x.x.x.",
          hatOpen: "..............o.",
        },
      ],
      // verses keep the hats closed and tight; the chorus opens them up or moves to the ride
      high: [
        {
          kick: "X.....x.x.x.....",
          snare: "....X.......X...",
          hatClosed: "x.x.x.x.x.x.x.x.",
          hatOpen: "..............x.",
        },
        {
          kick: "X..x..x.X..x..x.",
          snare: "....X.......X...",
          hatOpen: "x...x...x...x...",
          hatClosed: "..x...x...x...x.",
        },
        { kick: "X.x...x.X.x.....", snare: "....X.......X..x", ride: "x.x.x.x.x.x.x.x." },
        { kick: "X.....x.x.x.....", snare: "....X.......X...", hatOpen: "x.x.x.x.x.x.x.x." },
      ],
    },
    fills: {
      light: [{ snare: "............x.xx" }, { tomHigh: "............xx..", tomLow: "..............xx" }],
      full: [
        {
          snare: "........xx......",
          tomHigh: "..........xx....",
          tomMid: "............xx..",
          tomLow: "..............xX",
        },
        { snare: "........x.x.xxxx" },
        { tomHigh: "........x.x.....", tomMid: "..........x.x...", tomLow: "............x.xX" },
      ],
    },
    crash: "crash",
    ghost: 0.3,
    buildRoll: "snare",
  },
  perc: { from: 0.8, grooves: [{ tambourine: "..x...x...x...x." }] },
  swing: 0,
  humanize: { timing: 8, velocity: 0.09 },
  // verses pull back to palm-muted chugs and closed hats, so the chorus has somewhere to go
  form: { loop: "AB", intro: 0.8, outro: 0.8, tail: 2.5, energy: { verse: [0.74, 0.02] } },
  mix: {
    lead: { gain: 0.64, reverb: 0.22, delay: 0.12, drive: 0.25 },
    // one guitar part: an ensemble chorus spreads it left and right the way a double-tracked take would sit
    comp: { gain: 0.39, pan: 0, width: 1.5, reverb: 0.15, chorus: 0.5, lowCut: 80, drive: 0.5 },
    pad: { gain: 0.2 },
    bass: { gain: 0.8, drive: 0.2 },
    // as loud as PartMix allows: everything else is set against the kit
    kit: { gain: 1.5, reverb: 0.28, drive: 0.12 },
    perc: { gain: 0.75 },
  },
  space: {
    size: 0.45,
    decay: 1.4,
    damping: 0.5,
    preDelay: 0.015,
    level: 0.4,
    delayBeats: 0.75,
    delayFeedback: 0.2,
  },
  master: { targetLufs: -16, ceilingDb: -1, character: "punchy", tilt: 0.08 },
};
