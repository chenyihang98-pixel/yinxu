import type { StyleDef } from "./types";

/**
 * 伤感抒情 — a slow piano ballad played by one pair of hands: the left rolls
 * broken chords, the right sighs in falling seconds; strings hold underneath.
 * The tempo breathes, and there are no drums unless the energy is raised.
 */
export const sad: StyleDef = {
  id: "sad",
  summary: "缓慢的钢琴独白，左手分解和弦、右手叹息般的下行旋律，弦乐长音铺底，速度随乐句呼吸",
  harmony: {
    modes: {
      major: [
        {
          // bittersweet major: the minor subdominant keeps coming back
          scale: "major",
          bank: {
            verse: [
              ["I", "iii", "IV", "iv"],
              ["I", "V/VII", "vi", "IV"],
              ["I", "vi", "IV", "iv"],
              ["vi", "IV", "I", "V"],
              ["IV", "iv", "I", "vi"],
            ],
            chorus: [
              ["IV", "V", "iii", "vi"],
              ["IV", "iv", "iii", "vi"],
              ["ii", "V", "I", "vi"],
            ],
            bridge: [["vi", "iii", "IV", "iv"]],
          },
        },
      ],
      minor: [
        {
          scale: "naturalMinor",
          weight: 2,
          bank: {
            verse: [
              ["i", "iv", "bVII", "bIII"],
              ["i", "bVI", "bIII", "bVII"],
              ["i", "i/VII", "bVI", "V"],
              ["i", "v", "bVI", "iv"],
              ["i", "bVI", "iv", "V"],
            ],
            chorus: [
              ["bVI", "bVII", "v", "i"],
              ["iv", "bVII", "bIII", "bVI"],
              ["bVI", "bIII", "iv", "V"],
              ["iv", "i", "bVI", "V"],
            ],
            bridge: [
              ["bIII", "bVII", "iv", "V"],
              ["iv", "v", "bVI", "V"],
            ],
          },
        },
        {
          // the same natural-minor tune over progressions that close on the major
          // dominant: the line borrows its leading tone only while that chord sounds
          scale: "naturalMinor",
          bank: {
            verse: [
              ["i", "iv", "i", "V"],
              ["i", "bVI", "iv", "V"],
              ["i", "iv", "V", "i"],
            ],
            chorus: [
              ["iv", "V", "i", "bVI"],
              ["bVI", "iv", "V", "i"],
            ],
          },
        },
      ],
    },
    colour: [0.2, 0.7],
    extensions: { major: ["add9", "maj7"], minor: ["7", "9"], dominant: ["", "7"] },
    variation: 0.5,
    secondary: 0.3,
    borrowed: 0.6,
    sus: 0.6,
    voicing: "open",
    voices: 4,
    register: [50, 74],
    turnaround: { major: ["V", "iv", "Vsus4 V"], minor: ["V", "bVII", "iiø V"] },
    cadence: {
      major: [
        ["IV", "iv"],
        ["ii", "V"],
        ["IV", "Vsus4"],
      ],
      minor: [
        ["iv", "V"],
        ["bVI", "V"],
        ["bVI", "bVII"],
      ],
    },
    final: { major: "Iadd9", minor: "i" },
  },
  melody: {
    density: 0.36,
    syncopation: 0.15,
    motifBars: 2,
    stepBias: 0.8,
    pickup: 0.35,
    ornaments: 0.2,
    space: 0.5,
    chorusLift: 3,
    // a long note leaning on a short one: the sigh
    cells: ["x.....x.", "x...x...", "x.......", "x...x.x.", "__x.x...", "x..x...."],
  },
  // the same piano as the melody, on purpose: one player, two hands
  comp: {
    voice: "piano",
    from: 0,
    patterns: {
      low: [
        { rows: { low: "X...............", upper: "........o......." } },
        { rows: { "1": "X...............", "2": "....o.......o...", "3": "........o......." } },
      ],
      mid: [
        {
          rows: {
            "1": "X...............",
            "2": "..o...o...o...o.",
            "3": "....o.......o...",
            "4": "........o.......",
          },
        },
        {
          rows: {
            "1": "X.......x.......",
            "3": "..o.......o.....",
            "2": "....o.......o...",
            top: "......o.......o.",
          },
        },
      ],
      high: [
        { rows: { low: "X.......x.......", upper: "..o.x.o...o.x.o." } },
        {
          rows: {
            "1": "X...x...X...x...",
            "2": ".o...o...o...o..",
            "3": "..o...o...o...o.",
            "4": "...o...o...o...o",
          },
        },
      ],
    },
  },
  pad: { voice: ["strings", "pad"], from: 0.2, register: [50, 76], voices: 4 },
  counter: { voice: ["strings", "flute"], from: 0.5, mode: "guide" },
  bass: {
    voice: "fingerBass",
    from: 0.45,
    feel: { low: "root", mid: "root", high: "root" },
    register: [31, 43],
    approach: 0.2,
    gate: 0.96,
    calm: true,
  },
  // only when the energy is turned well up
  drums: {
    kit: "soft",
    from: 0.62,
    grooves: {
      low: [{ kick: "o...............", rim: "........o......." }],
      mid: [{ kick: "o...............", rim: "........o......." }],
      high: [{ kick: "x.........o.....", rim: "....o.......o...", shaker: "..g...g...g...g." }],
    },
    crash: null,
    ghost: 0,
  },
  swing: 0,
  rubato: 0.7,
  humanize: { timing: 18, velocity: 0.14 },
  form: { loop: "AB", intro: 1.2, outro: 1.4, tail: 3 },
  mix: {
    lead: { gain: 0.78, reverb: 0.45, delay: 0.05 },
    comp: { gain: 0.5, reverb: 0.4 },
    pad: { gain: 0.36, reverb: 0.55 },
    counter: { gain: 0.34, pan: 0.25, reverb: 0.5 },
    bass: { gain: 0.6 },
    kit: { gain: 0.5, reverb: 0.4 },
  },
  space: {
    size: 0.75,
    decay: 2.8,
    damping: 0.5,
    preDelay: 0.03,
    level: 0.6,
    delayBeats: 1,
    delayFeedback: 0.2,
  },
  master: { targetLufs: -16, ceilingDb: -1, character: "warm", tilt: -0.12 },
};
