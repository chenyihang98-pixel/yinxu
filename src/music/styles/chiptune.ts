import type { StyleDef } from "./types";

/**
 * 像素 8-bit — three tone channels and a noise channel: square lead, fast
 * pulse arpeggio as the harmony, triangle bass, noise drums. Almost dry.
 */
export const chiptune: StyleDef = {
  id: "chiptune",
  summary: "方波旋律、脉冲波快速琶音、三角波贝斯与噪声鼓",
  harmony: {
    modes: {
      major: [
        {
          scale: "major",
          bank: {
            verse: [
              ["I", "IV", "V", "I"],
              ["I", "V", "vi", "IV"],
              ["I", "vi", "IV", "V"],
              ["I", "bVII", "IV", "I"],
              ["I", "IV", "I", "V"],
            ],
            chorus: [
              ["IV", "V", "iii", "vi"],
              ["IV", "V", "I", "I"],
              ["IV", "V", "vi", "vi"],
              ["bVI", "bVII", "I", "I"],
            ],
            bridge: [["vi", "IV", "ii", "V"]],
          },
        },
      ],
      minor: [
        {
          scale: "naturalMinor",
          bank: {
            verse: [
              ["i", "bVII", "bVI", "V"],
              ["i", "bVI", "bVII", "i"],
              ["i", "iv", "V", "i"],
              ["i", "bIII", "bVII", "bVI"],
            ],
            chorus: [
              ["bVI", "bVII", "i", "i"],
              ["iv", "V", "i", "i"],
              ["bVI", "bIII", "bVII", "i"],
            ],
            bridge: [["iv", "bVII", "bIII", "V"]],
          },
        },
      ],
    },
    colour: [0, 0.2],
    extensions: { major: ["", ""], minor: ["", ""], dominant: ["", "7"] },
    variation: 0.5,
    secondary: 0.3,
    borrowed: 0.5,
    sus: 0.3,
    voicing: "close",
    voices: 3,
    register: [55, 79],
    turnaround: { major: ["V"], minor: ["V", "bVII"] },
    cadence: {
      major: [
        ["IV", "V"],
        ["bVI", "bVII"],
      ],
      minor: [
        ["bVI", "bVII"],
        ["iv", "V"],
      ],
    },
    final: { major: "I", minor: "i" },
  },
  melody: {
    density: 0.66,
    syncopation: 0.5,
    motifBars: 2,
    stepBias: 0.62,
    pickup: 0.45,
    ornaments: 0,
    space: 0.15,
    chorusLift: 3,
    // busy and bouncing: running eighths with bursts of sixteenths
    cells: ["x.x.x.x.", "x.xxx.x.", "xxx.x...", "x.x.xx..", "x..x..x.", "x...x.x."],
    gate: 0.85,
  },
  // forced on by a hint only: the pulse channel is normally busy with the arpeggio
  pad: { voice: "chipPulse", from: 2, register: [52, 76] },
  counter: { voice: "chipPulse", from: 2, mode: "guide" },
  arp: {
    voice: "chipPulse",
    from: 0,
    pattern: ["up", "updown", "broken"],
    rate: { low: 2, mid: 1, high: 1 },
    gate: 0.8,
    register: [55, 79],
  },
  bass: {
    voice: "chipBass",
    from: 0,
    feel: { low: "root", mid: "octave", high: "octave" },
    register: [36, 50],
    approach: 0.35,
    gate: 0.8,
  },
  drums: {
    kit: "chip",
    from: 0.15,
    grooves: {
      low: [{ noiseTick: "x...o...x...o..." }, { noiseTick: "x.o.x.o.x.o.x.o." }],
      mid: [
        { noiseTick: "x.o.x.o.x.o.x.o.", noiseHit: "....X.......X..." },
        { noiseTick: "x.oxx.o.x.oxx.o.", noiseHit: "....X.......X..." },
      ],
      high: [
        { noiseTick: "x.xxx.xxx.xxx.xx", noiseHit: "....X.......X.x." },
        { noiseTick: "xxoxxxoxxxoxxxox", noiseHit: "....X..x....X..." },
      ],
    },
    fills: {
      light: [{ noiseHit: "..............xx" }, { noiseHit: "............x.xx" }],
      full: [
        { noiseHit: "........x.x.xxxx" },
        { noiseHit: "........xx.xx.xx", noiseTick: "..........x..x.." },
      ],
    },
    crash: null,
    ghost: 0,
    remap: {
      kick: "noiseTick",
      snare: "noiseHit",
      rim: "noiseTick",
      clap: "noiseHit",
      hatClosed: "noiseTick",
      hatOpen: "noiseTick",
      ride: "noiseTick",
      crash: "noiseHit",
      tomLow: "noiseHit",
      tomMid: "noiseHit",
      tomHigh: "noiseHit",
      shaker: "noiseTick",
      tambourine: "noiseTick",
      woodblock: "noiseTick",
      brushSnare: "noiseHit",
      taiko: "noiseHit",
      cymbalSwell: null,
      subBoom: null,
      sleighBell: "noiseTick",
      gong: null,
      fingerSnap: "noiseHit",
    },
  },
  swing: 0,
  humanize: { timing: 0, velocity: 0.02 },
  form: { loop: "AB", intro: 0.6, outro: 0.8, tail: 1.6 },
  mix: {
    lead: { gain: 0.7, width: 0.5, reverb: 0.04, delay: 0.14 },
    arp: { gain: 0.34, pan: 0.2, width: 0.6, reverb: 0.03, delay: 0.05 },
    counter: { gain: 0.34, pan: -0.2, width: 0.6, reverb: 0.03 },
    pad: { gain: 0.3, width: 0.6, reverb: 0.03, chorus: 0, lowCut: 0 },
    bass: { gain: 0.75, reverb: 0 },
    kit: { gain: 0.6, width: 0.4, reverb: 0.02 },
    perc: { gain: 0.4, width: 0.4, reverb: 0.02 },
  },
  space: {
    size: 0.15,
    decay: 0.45,
    damping: 0.3,
    preDelay: 0.005,
    level: 0.12,
    delayBeats: 0.75,
    delayFeedback: 0.3,
  },
  master: { targetLufs: -16, ceilingDb: -1, character: "bitcrush", tilt: 0.1 },
};
