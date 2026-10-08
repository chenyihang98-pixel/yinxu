import type { StyleDef } from "./types";

/** 梦幻空灵 — glassy pad, a flowing plucked arpeggio and a bell melody in a big space. */
export const dreamy: StyleDef = {
  id: "dreamy",
  summary: "空气感垫音、流动的琶音与清澈的钟琴旋律",
  harmony: {
    modes: {
      major: [
        {
          scale: "major",
          weight: 2,
          bank: {
            verse: [
              ["Imaj7", "IVmaj7", "Imaj7", "IVmaj7"],
              ["Iadd9", "iii7", "IVmaj7", "IVmaj7"],
              ["Imaj7", "vi7", "IVmaj7", "V"],
              ["IVmaj7", "Imaj7", "IVmaj7", "V6"],
            ],
            chorus: [
              ["IVmaj7", "V", "vi7", "Imaj7"],
              ["vi7", "IVmaj7", "Imaj7", "V"],
              ["IVmaj7", "iii7", "ii7", "Imaj7"],
            ],
            bridge: [["ii7", "iii7", "IVmaj7", "V"]],
          },
        },
        {
          scale: "lydian",
          bank: {
            verse: [
              ["Imaj7", "II/I", "Imaj7", "II/I"],
              ["Imaj7", "II", "vi7", "II"],
            ],
            chorus: [
              ["II", "Imaj7", "II", "Imaj7"],
              ["vi7", "II", "Imaj7", "Imaj7"],
            ],
          },
        },
      ],
      minor: [
        {
          scale: "naturalMinor",
          weight: 2,
          bank: {
            verse: [
              ["i7", "bVImaj7", "bIIImaj7", "bVII"],
              ["bVImaj7", "bVII", "i7", "i7"],
              ["i7", "bIIImaj7", "bVImaj7", "iv7"],
            ],
            chorus: [
              ["bVImaj7", "bIIImaj7", "bVII", "i7"],
              ["iv7", "bVImaj7", "bIIImaj7", "bVII"],
            ],
          },
        },
        {
          scale: "dorian",
          bank: {
            verse: [
              ["i7", "IV", "i7", "IV"],
              ["i7", "IV", "bVIImaj7", "IV"],
            ],
            chorus: [["bIIImaj7", "IV", "i7", "i7"]],
          },
        },
      ],
    },
    colour: [0.35, 0.9],
    variation: 0.3,
    secondary: 0.15,
    borrowed: 0.5,
    sus: 0.4,
    voicing: "open",
    voices: 4,
    register: [50, 76],
    turnaround: { major: ["V", "IV/V"], minor: ["bVII", "v7"] },
    cadence: {
      major: [
        ["IVmaj7", "V"],
        ["ii7", "IV/V"],
      ],
      minor: [
        ["bVImaj7", "bVII"],
        ["iv7", "bVII"],
      ],
    },
    final: { major: "Imaj9", minor: "i9" },
  },
  melody: {
    density: 0.34,
    syncopation: 0.3,
    motifBars: 2,
    stepBias: 0.64,
    pickup: 0.3,
    ornaments: 0.2,
    space: 0.5,
    chorusLift: 3,
    // floating: notes that arrive late and ring
    cells: ["x.....x.", "__x.....", "x...x...", "x.x.....", "____x..."],
  },
  comp: {
    voice: ["epiano", "piano"],
    from: 0.5,
    patterns: {
      low: [{ rows: { all: "X..............." }, strum: 0.03 }],
      mid: [{ rows: { all: "X.........o....." }, strum: 0.03 }],
      high: [{ rows: { all: "X.....o...x....." }, strum: 0.02 }],
    },
  },
  pad: { voice: ["airpad", "pad"], from: 0, register: [52, 79], voices: 4 },
  arp: {
    voice: ["pluck", "musicbox"],
    from: 0.12,
    pattern: ["updown", "up", "broken"],
    rate: { low: 2, mid: 2, high: 1 },
    octaves: 2,
    gate: 1.2,
    register: [50, 76],
  },
  counter: { voice: ["choir", "flute"], from: 0.6, mode: "guide" },
  bass: {
    voice: "subBass",
    from: 0.2,
    feel: { low: "root", mid: "root", high: "root" },
    register: [29, 43],
    approach: 0.2,
    gate: 0.97,
    calm: true,
  },
  drums: {
    kit: "soft",
    from: 0.48,
    grooves: {
      low: [{ kick: "o...............", rim: "........o.......", shaker: "..g...g...g...g." }],
      mid: [{ kick: "x.........o.....", rim: "....o.......o...", shaker: "o.g.o.g.o.g.o.g." }],
      high: [{ kick: "x.....o...x.....", snare: "....o.......o...", hatClosed: "o.g.o.g.o.g.o.g." }],
    },
    crash: null,
    swell: true,
    ghost: 0.1,
  },
  swing: 0,
  humanize: { timing: 12, velocity: 0.1 },
  form: { loop: "AB", intro: 1.2, outro: 1.2, tail: 3 },
  mix: {
    lead: { reverb: 0.5, delay: 0.25 },
    arp: { gain: 0.36, reverb: 0.45, delay: 0.3 },
    pad: { gain: 0.45, reverb: 0.6, chorus: 0.5, width: 1.5 },
    comp: { gain: 0.45, reverb: 0.4, chorus: 0.3 },
  },
  space: {
    size: 0.88,
    decay: 3.6,
    damping: 0.35,
    preDelay: 0.03,
    level: 0.75,
    delayBeats: 0.75,
    delayFeedback: 0.42,
  },
  master: { targetLufs: -16, ceilingDb: -1, character: "wide", tilt: 0.1 },
};
