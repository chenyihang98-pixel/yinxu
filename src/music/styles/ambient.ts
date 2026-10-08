import type { StyleDef } from "./types";

/** 氛围冥想 — no drum kit at all: slow chords on two evolving pads, a drone, sparse bells. */
export const ambient: StyleDef = {
  id: "ambient",
  summary: "缓慢呼吸的长音铺底与零星的钟声，没有鼓",
  harmony: {
    modes: {
      major: [
        {
          scale: "major",
          weight: 2,
          bank: {
            // written plain: the complexity control decides how much seventh and ninth they carry
            verse: [
              ["I", "IV"],
              ["Iadd9", "vi", "IV", "IV"],
              ["I", "iii", "IV", "I"],
              ["IV", "I", "IV", "vi"],
            ],
            chorus: [
              ["vi", "IV", "I", "I"],
              ["IV", "vi", "IV", "I"],
            ],
          },
        },
        {
          scale: "lydian",
          bank: {
            verse: [["I", "II/I"]],
            chorus: [["vi", "II/I", "I", "I"]],
          },
        },
      ],
      minor: [
        {
          scale: "naturalMinor",
          weight: 2,
          bank: {
            verse: [
              ["i", "bVI"],
              ["i", "bVI", "bIII", "bVI"],
              ["i", "iv", "bVI", "bVI"],
            ],
            chorus: [["bVI", "bIII", "i", "i"]],
          },
        },
        {
          scale: "dorian",
          bank: {
            verse: [["i", "IV"]],
            chorus: [["bIII", "IV", "i", "i"]],
          },
        },
      ],
    },
    // from mostly bare triads to ninths everywhere; the style's own setting sits on sevenths
    colour: [0.4, 1],
    extensions: { major: ["maj7", "maj9"], minor: ["7", "9"], dominant: ["sus4", "7sus4"] },
    variation: 0.2,
    secondary: 0,
    borrowed: 0.3,
    sus: 0,
    voicing: "open",
    voices: 3,
    register: [43, 67],
    // chords drift: every bank entry lasts two bars
    barsPerChord: () => 2,
    turnaround: { major: [], minor: [] },
    cadence: { major: [["IVmaj7"]], minor: [["bVImaj7"]] },
    final: { major: "Imaj9", minor: "i9" },
  },
  melody: {
    density: 0.05,
    syncopation: 0.1,
    motifBars: 2,
    stepBias: 0.6,
    pickup: 0.05,
    ornaments: 0,
    space: 0.9,
    chorusLift: 2,
    // single bell strokes
    cells: ["x.......", "____x..."],
    introLead: true,
  },
  comp: {
    voice: ["pad", "choir"],
    from: 0,
    patterns: {
      low: [{ rows: { all: "X..............." } }],
      mid: [{ rows: { all: "X..............." } }],
      high: [{ rows: { all: "X..............." } }],
    },
  },
  pad: { voice: ["airpad", "choir"], from: 0, register: [55, 81], voices: 4 },
  arp: {
    voice: ["musicbox", "pluck"],
    from: 0.5,
    pattern: ["random", "updown"],
    rate: { low: 8, mid: 4, high: 2 },
    octaves: 2,
    gate: 1.5,
    register: [64, 91],
  },
  counter: { voice: ["choir", "strings"], from: 0.45, mode: "guide" },
  bass: {
    voice: "subBass",
    from: 0.18,
    feel: { low: "pedal", mid: "root", high: "root" },
    register: [28, 40],
    approach: 0,
    gate: 0.98,
    calm: true,
  },
  swing: 0,
  humanize: { timing: 20, velocity: 0.12 },
  form: { loop: "AB", intro: 1.4, outro: 1.5, tail: 3 },
  mix: {
    lead: { gain: 0.6, reverb: 0.7, delay: 0.4 },
    comp: { gain: 0.42, pan: 0, width: 1.4, reverb: 0.6, chorus: 0.5, lowCut: 120 },
    pad: { gain: 0.42, reverb: 0.7, chorus: 0.6, width: 1.5, lowCut: 250 },
    arp: { gain: 0.28, reverb: 0.7, delay: 0.45 },
    counter: { reverb: 0.7 },
    bass: { gain: 0.6, reverb: 0.1 },
  },
  space: {
    size: 1,
    decay: 6,
    damping: 0.3,
    preDelay: 0.04,
    level: 0.9,
    delayBeats: 1,
    delayFeedback: 0.5,
  },
  master: { targetLufs: -16, ceilingDb: -1, character: "wide", tilt: -0.1 },
};
