import type { StyleDef } from "./types";

/**
 * 嘻哈律动 — a half-time beat: the snare and clap land on beat three, hats
 * swing lazily with rolls, an 808 follows the kick and slides between notes,
 * and a short electric-piano riff loops over two- and four-chord vamps.
 */
export const hiphop: StyleDef = {
  id: "hiphop",
  summary: "军鼓与拍手落在第三拍的半拍律动，带滚奏的慵懒踩镲，808 低音跟随底鼓并滑音，电钢琴短句循环",
  harmony: {
    modes: {
      major: [
        {
          scale: "major",
          bank: {
            verse: [
              ["IVmaj7", "iii7", "vi7", "vi7"],
              ["Imaj7", "iii7", "IVmaj7", "V7sus4"],
              ["ii7", "iii7", "IVmaj7", "iii7"],
              ["Imaj7", "vi7"],
            ],
            chorus: [
              ["IVmaj7", "V7", "iii7", "vi7"],
              ["vi7", "IVmaj7", "Imaj7", "V7"],
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
              ["i7", "bVImaj7"],
              ["i7", "iv7", "bVImaj7", "v7"],
              ["i7", "bVII", "bVImaj7", "bVII"],
              ["bVImaj7", "v7", "i7", "i7"],
              ["i7", "bIIImaj7", "iv7", "bVImaj7"],
            ],
            chorus: [
              ["bVImaj7", "bVII", "i7", "i7"],
              ["iv7", "v7", "i7", "bIIImaj7"],
              ["bVImaj7", "v7", "i7", "i7"],
              ["iv7", "i7", "bVImaj7", "V7"],
            ],
          },
        },
        {
          scale: "dorian",
          bank: {
            verse: [
              ["i7", "IV7"],
              ["i7", "IV7", "i7", "bVIImaj7"],
            ],
            chorus: [["bIIImaj7", "IV7", "i7", "i7"]],
          },
        },
      ],
    },
    colour: [0.45, 0.9],
    variation: 0.3,
    secondary: 0.3,
    borrowed: 0.3,
    sus: 0.2,
    voicing: "close",
    voices: 4,
    register: [50, 70],
    turnaround: { major: ["V7sus4", "ii7 V7"], minor: ["V7", "bVII", "v7"] },
    cadence: {
      major: [["ii7", "V7"]],
      minor: [
        ["iv7", "V7"],
        ["bVImaj7", "bVII"],
      ],
    },
    final: { major: "Imaj9", minor: "i9" },
  },
  melody: {
    density: 0.4,
    syncopation: 0.6,
    motifBars: 2,
    stepBias: 0.62,
    pickup: 0.25,
    ornaments: 0.15,
    space: 0.45,
    register: 2,
    chorusLift: 2,
    // a riff, sampled and looped
    hook: 0.85,
    cells: ["x..x..x.", "__x.x...", "x.x...x.", "x..x....", "xx.x....", "x_..x.x.", "__x...x."],
  },
  // struck and plucked leads are squeezed like a chopped sample; the brightest ones lose their top
  lead: {
    piano: { gain: 0.75, drive: 0.15 },
    guitar: { gain: 0.73, drive: 0.15 },
    synth: { gain: 0.75, highCut: 5000 },
    pluck: { drive: 0.15, highCut: 6000 },
    bell: { gain: 0.74, drive: 0.12, highCut: 4000 },
    musicbox: { gain: 0.73 },
    marimba: { drive: 0.15 },
    vibes: { drive: 0.12 },
    flute: { gain: 0.75 },
    strings: { gain: 0.82, highCut: 2800 },
    guzheng: { gain: 0.72, drive: 0.15, highCut: 2800 },
    dizi: { gain: 0.74, highCut: 2800 },
    chip: { gain: 0.75, highCut: 4500 },
  },
  // the same electric piano as the riff: the whole loop sounds like one sample
  comp: {
    voice: "epiano",
    from: 0,
    patterns: {
      low: [{ rows: { all: "X..............." }, strum: 0.02 }],
      mid: [
        { rows: { all: "X.........o....." }, strum: 0.018 },
        { rows: { all: "x......x-......." } },
      ],
      high: [{ rows: { all: "X.....x-..o....." } }, { rows: { all: "x..x-.....x..x-." } }],
    },
  },
  pad: { voice: ["pad", "airpad"], from: 0.5, register: [50, 72] },
  arp: {
    voice: ["bell", "musicbox"],
    from: 0.6,
    pattern: ["random", "broken"],
    rate: { low: 4, mid: 2, high: 2 },
    register: [72, 91],
    gate: 0.8,
  },
  bass: {
    voice: "bass808",
    from: 0.2,
    // "syncopated" locks every note to a kick
    feel: { low: "root", mid: "syncopated", high: "syncopated" },
    register: [28, 43],
    approach: 0.2,
    gate: 0.95,
    slide: 0.3,
  },
  drums: {
    kit: "electro",
    from: 0.15,
    grooves: {
      low: [{ kick: "x.........x.....", snare: "........o.......", hatClosed: "o.o.o.o.o.o.o.o." }],
      mid: [
        {
          kick: "X.....x...x.....",
          snare: "........X.......",
          clap: "........x.......",
          hatClosed: "x.o.x.o.x.orx.o.",
        },
        {
          kick: "X..x......x..x..",
          snare: "........X.......",
          clap: "........x.......",
          hatClosed: "x.o.x.r.x.o.x.or",
        },
      ],
      high: [
        {
          kick: "X..x..x...x..x..",
          snare: "........X.......",
          clap: "........X.......",
          hatClosed: "xoxoxrxoxoxoxrxo",
          hatOpen: "..............o.",
        },
        {
          kick: "X.....x..xx...x.",
          snare: "........X.....g.",
          clap: "........X.......",
          hatClosed: "x.xrx.x.xrx.x.rr",
          hatOpen: "......o.........",
        },
      ],
    },
    fills: {
      light: [{ snare: "..............rr" }, { hatClosed: "............rrrr" }],
      full: [
        { snare: "............x.rr", tomLow: "........o.o....." },
        { hatClosed: "........rrrrrrrr", snare: "..............xx" },
      ],
    },
    crash: null,
    ghost: 0.15,
    // the backbeat drags
    lag: { snare: 14, clap: 18 },
  },
  perc: {
    from: 0.45,
    grooves: [
      { fingerSnap: "........x......." },
      { fingerSnap: "........x.......", shaker: "..o...o...o...o." },
      { fingerSnap: "........x.....o.", rim: "...o......o....." },
    ],
  },
  swing: 0.3,
  swingGrid: 16,
  humanize: { timing: 12, velocity: 0.1 },
  form: { loop: "AB", intro: 0.8, outro: 0.8, tail: 2 },
  mix: {
    lead: { gain: 0.8, reverb: 0.2, delay: 0.12, chorus: 0.15, highCut: 8000 },
    comp: { gain: 0.6, width: 1.3, chorus: 0.4, highCut: 5000, drive: 0.1 },
    arp: { gain: 0.3, reverb: 0.35, delay: 0.3 },
    pad: { gain: 0.3, highCut: 4000 },
    bass: { gain: 0.9, reverb: 0, drive: 0.25, highCut: 1500, duck: 0.45 },
    kit: { gain: 1.01, reverb: 0.06, drive: 0.1, lowCut: 40 },
    perc: { gain: 0.8, reverb: 0.15 },
  },
  space: {
    size: 0.3,
    decay: 1,
    damping: 0.65,
    preDelay: 0.01,
    level: 0.35,
    delayBeats: 0.75,
    delayFeedback: 0.28,
  },
  master: { targetLufs: -16, ceilingDb: -1, character: "punchy", tilt: -0.1 },
};
