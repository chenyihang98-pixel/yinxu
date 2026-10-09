import type { StyleDef } from "./types";

/**
 * 悬疑紧张 — a low pulse that never leaves the tonic, string clusters built
 * from minor-add9, minor-major-seventh and Neapolitan chords, a ticking
 * clock, and isolated drum and gong hits. Nothing ever resolves brightly.
 */
export const tension: StyleDef = {
  id: "tension",
  summary: "主音上不停的低音脉冲、不协和的弦乐音簇与稀疏的重击，始终不给明亮的解决",
  harmony: {
    modes: {
      major: [
        {
          // a major key made uneasy: the floating raised fourth
          scale: "lydian",
          bank: {
            verse: [
              ["I", "II/I", "I", "vii"],
              ["Imaj7", "II/I", "vii", "II/I"],
            ],
            chorus: [
              ["vi", "II/I", "vii", "I"],
              ["II", "vii", "vi", "II/I"],
            ],
          },
          // (the style's bVI and bII cadences carry the natural fourth)
          cadence: [["vii", "II/I"], ["vi", "II"]],
          turnaround: ["II/I", "vii"],
        },
        {
          // chromatic mediants and the rising augmented line of spy films
          scale: "major",
          bank: {
            verse: [
              ["I", "Iaug", "I6", "Iaug"],
              ["I", "bVI", "I", "bII/I"],
            ],
            chorus: [
              ["bVI", "bII", "I", "Iaug"],
              ["iv", "bVI", "bII", "I"],
            ],
          },
        },
      ],
      minor: [
        {
          scale: "naturalMinor",
          bank: {
            verse: [
              ["iadd9", "bVImaj7", "iadd9", "bII/I"],
              ["imaj7", "i7", "i6", "bVImaj7"],
              ["i", "#iv°/I", "i", "bVI"],
              ["i", "v", "bVI", "v"],
              ["iadd9", "iv6", "iadd9", "bVImaj7"],
            ],
            chorus: [
              ["bVI", "v", "i", "bII/I"],
              ["iv", "bVI", "bII", "i"],
              ["bVI", "bVII", "i", "#iv°/I"],
              ["i", "bIII", "bII", "i"],
            ],
            build: [
              ["iv", "bVI", "bII", "V"],
              ["bVI", "bVI", "bII", "bII"],
            ],
          },
        },
        {
          // the lowered second hanging a semitone over the tonic
          scale: "phrygian",
          weight: 1.2,
          bank: {
            verse: [
              ["i", "bII", "i", "bvii"],
              ["i", "bII/I", "i", "bII"],
              ["i", "bvii", "bII", "i"],
            ],
            chorus: [
              ["bII", "i", "bvii", "i"],
              ["bVI", "bII", "i", "i"],
              ["iv", "bII", "i", "bvii"],
            ],
            build: [["iv", "iv", "bII", "bII"]],
          },
          // the mode's own endings: the Neapolitan falls onto the tonic, and
          // the rub in the last chord is the lowered second itself (the style's
          // "iadd9" would bring back the natural second the mode has given up)
          cadence: [["bII"], ["bvii", "bII"], ["iv", "bII"]],
          turnaround: ["bII", "bvii"],
          final: "iaddb9",
        },
      ],
    },
    colour: [0.2, 0.75],
    extensions: { major: ["maj7", "maj7#11"], minor: ["add9", "add9"], dominant: ["", "7b9"] },
    variation: 0.15,
    secondary: 0,
    borrowed: 0,
    sus: 0,
    voicing: "close",
    voices: 4,
    register: [50, 72],
    // suspense holds its chords: two bars each until the music is pushed forward
    barsPerChord: ({ section }) => (section === "chorus" || section === "build" ? 1 : 2),
    turnaround: { major: ["bII", "v"], minor: ["bII", "v", "bvii"] },
    cadence: {
      major: [
        ["bVI", "bII"],
        ["iv", "bII"],
      ],
      minor: [
        ["bVI", "bII"],
        ["iv", "v"],
        ["bII"],
      ],
    },
    // no bright ending: the tonic comes back with a rub in it
    final: { major: "Isus2", minor: "iadd9" },
  },
  melody: {
    density: 0.28,
    syncopation: 0.3,
    motifBars: 2,
    stepBias: 0.76,
    pickup: 0.15,
    ornaments: 0.1,
    space: 0.6,
    register: -3,
    chorusLift: 2,
    gate: 0.98,
    // isolated notes, a late entry, a short stab followed by silence
    cells: ["x.......", "__x.....", "x.....x.", "x_......", "x...__x.", "____x..."],
  },
  comp: {
    // always the plucked tick: bowed strings are the cluster above it
    voice: "pizzicato",
    from: 0.2,
    patterns: {
      low: [
        { rows: { top: "x-..o-..x-..o-.." } },
        { rows: { "2": "x-......x-......", "3": "....o-......o-.." } },
      ],
      mid: [
        { rows: { low: "x...............", upper: "..x-..o-..x-..o-" } },
        { rows: { all: "x-..o-..o-..o-.." } },
      ],
      high: [
        { rows: { low: "X-.x-.x-X-.x-.x-", upper: "x-.o-.o-x-.o-.o-" } },
        { rows: { low: "x-o-x-o-x-o-x-o-", upper: "x-g-o-g-o-g-o-g-" } },
      ],
    },
  },
  // struck and plucked leads carry little above 1 kHz this low and need more level against the
  // strings; the flutes cut through them and need less
  lead: {
    marimba: { gain: 0.96 },
    vibes: { gain: 0.92 },
    epiano: { gain: 0.92 },
    piano: { gain: 0.88 },
    guitar: { gain: 0.88 },
    musicbox: { gain: 0.86 },
    pluck: { gain: 1 },
    flute: { gain: 0.66 },
    dizi: { gain: 0.62 },
  },
  // always strings, even under a string melody: this is the cluster itself
  pad: { voice: "strings", from: 0, register: [53, 77], voices: 4, voicing: "close" },
  counter: { voice: ["airpad", "choir"], from: 0.62, mode: "guide", placement: "above" },
  bass: {
    voice: "synthBass",
    from: 0,
    feel: { low: "pedal", mid: "pedal", high: "pedal" },
    // the tonic between G1 and G2: a pulse small speakers can still reproduce
    register: [31, 43],
    approach: 0,
    gate: 0.7,
    // the long low-tier drone is trimmed against the pulse of the busier tiers
    level: { low: 0.8 },
  },
  drums: {
    kit: "cinematic",
    from: 0.4,
    grooves: {
      low: [
        { subBoom: "x...............|................", rim: "......o.........|....o.....o....." },
        { rim: "....o.....o.....|........o......." },
      ],
      mid: [
        {
          taiko: "x.........o.....|......o.........",
          rim: "....o.......o...|....o.......o.o.",
        },
        { taiko: "X.....o.........", woodblock: "....o..o....o..." },
      ],
      high: [
        { taiko: "X..x..x...x.x...", rim: "....x.......x...", hatClosed: "x.o.x.o.x.o.x.o." },
        { taiko: "X.x...x.X.x...x.", snare: "....o.......o..x", hatClosed: "xgxgxgxgxgxgxgxg" },
      ],
    },
    fills: {
      light: [{ taiko: "..............oo" }, { rim: "............o.oo" }],
      full: [
        { taiko: "........x...x.xX" },
        { tomLow: "........o.o.o.xx", taiko: "..............XX" },
      ],
    },
    crash: "gong",
    impact: "subBoom",
    swell: true,
    ghost: 0,
  },
  // the clock on the wall
  perc: {
    kit: "cinematic",
    from: 0.22,
    grooves: [{ rim: "x...o...x...o..." }, { woodblock: "x...o...x...o..." }],
  },
  swing: 0,
  humanize: { timing: 5, velocity: 0.08 },
  form: { loop: "AB", intro: 1.2, outro: 1.2, tail: 3 },
  mix: {
    lead: { gain: 0.8, reverb: 0.4, delay: 0.15 },
    comp: { gain: 0.5, pan: 0.2, reverb: 0.35 },
    pad: { gain: 0.36, reverb: 0.55, chorus: 0.2, lowCut: 180 },
    counter: { gain: 0.32, reverb: 0.7 },
    bass: { gain: 0.74, drive: 0.25, highCut: 1800 },
    kit: { gain: 0.72, reverb: 0.5 },
    perc: { gain: 0.9, pan: -0.3, reverb: 0.4 },
  },
  space: {
    size: 0.85,
    decay: 3.4,
    damping: 0.5,
    preDelay: 0.03,
    level: 0.65,
    delayBeats: 0.75,
    delayFeedback: 0.4,
  },
  master: { targetLufs: -16, ceilingDb: -1, character: "warm", tilt: -0.02 },
};
