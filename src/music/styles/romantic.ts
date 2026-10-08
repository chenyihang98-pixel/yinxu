import type { StyleDef } from "./types";

/**
 * 浪漫温馨 — a warm piano singing over its own flowing arpeggios, strings that
 * hold the harmony and answer with a counter-melody, and bright major
 * progressions (IV–V–iii–vi, the descending canon bass) coloured by
 * secondary dominants. Brushes join only when the energy rises.
 */
export const romantic: StyleDef = {
  id: "romantic",
  summary: "温暖的钢琴旋律与流动的分解和弦，弦乐铺底并以副旋律应答，明亮的大调和声点缀副属和弦",
  harmony: {
    modes: {
      major: [
        {
          scale: "major",
          bank: {
            verse: [
              ["I", "V/VII", "vi", "I/V", "IV", "I/III", "ii", "V"],
              ["IV", "V", "iii", "vi"],
              ["I", "vi", "IV", "V"],
              ["I", "iii", "IV", "V"],
              ["I", "V/VII", "vi", "IV"],
              ["Imaj7", "vi7", "ii7", "V7"],
            ],
            chorus: [
              ["IV", "V", "iii", "vi", "ii", "V", "I", "I"],
              ["IV", "V", "iii", "vi"],
              ["ii", "V", "I", "vi"],
              ["IV", "I/III", "ii", "V"],
            ],
            bridge: [
              ["vi", "iii", "IV", "V"],
              ["IV", "iv", "I", "V7/ii"],
            ],
          },
        },
      ],
      minor: [
        {
          scale: "naturalMinor",
          bank: {
            verse: [
              ["i", "bVI", "bIII", "bVII"],
              ["i", "iv", "bVII", "bIII"],
              ["i", "bVII", "bVI", "V"],
            ],
            chorus: [
              ["bVI", "bVII", "bIII", "i"],
              ["iv", "bVII", "bIII", "bVI"],
              ["bVI", "V", "i", "i"],
            ],
          },
        },
      ],
    },
    colour: [0.3, 0.8],
    extensions: { major: ["maj7", "maj9"], minor: ["7", "9"], dominant: ["7", "9"] },
    variation: 0.6,
    secondary: 0.7,
    borrowed: 0.5,
    sus: 0.6,
    voicing: "open",
    voices: 4,
    register: [50, 74],
    turnaround: { major: ["V7", "Vsus4 V", "ii7 V7"], minor: ["V", "bVII"] },
    cadence: {
      major: [
        ["IV", "V"],
        ["ii7", "V7"],
        ["IV", "iv"],
      ],
      minor: [
        ["iv", "V"],
        ["bVI", "V"],
      ],
    },
    final: { major: "Iadd9", minor: "i" },
  },
  melody: {
    density: 0.38,
    syncopation: 0.2,
    motifBars: 2,
    stepBias: 0.74,
    pickup: 0.5,
    ornaments: 0.35,
    space: 0.4,
    chorusLift: 4,
    cells: ["x...x.x.", "x.....x.", "x...x...", "x.x.x...", "x.......", "x..x....", "__x.x.x."],
  },
  // the melody's own instrument: a pianist accompanying herself
  comp: {
    voice: "piano",
    from: 0,
    patterns: {
      low: [
        { rows: { "1": "X...............", "2": "....x.......x...", "3": "........x......." } },
        {
          rows: {
            "1": "X...............",
            "3": "....x...........",
            "2": "........x.......",
            top: "............x...",
          },
        },
      ],
      mid: [
        {
          rows: {
            "1": "X...............",
            "2": "..o...o...o...o.",
            "3": "....x.......x...",
            "4": "........x.......",
          },
        },
        {
          rows: {
            "1": "X.......x.......",
            "2": "..o.......o.....",
            "3": "....x.......x...",
            top: "......o.......o.",
          },
        },
      ],
      high: [
        {
          rows: {
            "1": "X.......x.......",
            "2": "..o...o...o...o.",
            "3": "....x.......x...",
            top: "......x.......x.",
          },
        },
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
  pad: { voice: ["strings", "pad"], from: 0.2, register: [52, 76], voices: 4 },
  counter: { voice: ["strings", "flute"], from: 0.4, mode: "guide" },
  bass: {
    voice: "fingerBass",
    from: 0.45,
    feel: { low: "root", mid: "root", high: "root" },
    register: [31, 45],
    approach: 0.3,
    gate: 0.95,
  },
  drums: {
    kit: "brush",
    from: 0.5,
    grooves: {
      low: [{ kick: "o...............", brushSnare: "....x.......x..." }],
      mid: [{ kick: "o.........g.....", brushSnare: "....X.......X...", hatClosed: "..x...x...x...x." }],
      high: [{ kick: "o.....g.o.......", brushSnare: "....X.......X...", ride: "x.x.x.x.x.x.x.x." }],
    },
    fills: {
      light: [{ brushSnare: "............o.xx" }],
      full: [{ brushSnare: "........x.o.x.xx", tomLow: "..............o." }],
    },
    crash: null,
    swell: true,
    ghost: 0.2,
  },
  perc: { from: 0.62, grooves: [{ shaker: "..x...x...x...x." }] },
  // sustained leads do not decay the way the piano does, so they are set back; mellow keys come forward
  lead: {
    epiano: { gain: 1.03, drive: 0.3 },
    marimba: { gain: 1.16, drive: 0.3 },
    vibes: { gain: 1, drive: 0.2 },
    synth: { gain: 0.74, highCut: 7000 },
    strings: { gain: 0.75 },
    guzheng: { gain: 0.73 },
    dizi: { gain: 0.66, highCut: 7000 },
    chip: { gain: 0.76, highCut: 5500 },
  },
  swing: 0,
  rubato: 0.45,
  humanize: { timing: 14, velocity: 0.12 },
  form: { loop: "AB", intro: 1.2, outro: 1.3, tail: 3 },
  // the tune 3–4 LU over left hand and strings together, the two of them about level; brushes and
  // shaker (only when the energy is raised) are written and mixed loud enough to be heard at all
  mix: {
    lead: { gain: 0.8, reverb: 0.42, delay: 0.06 },
    comp: { gain: 0.5, reverb: 0.35 },
    pad: { gain: 0.32, reverb: 0.5 },
    counter: { gain: 0.4, pan: 0.25, reverb: 0.5 },
    bass: { gain: 0.66 },
    kit: { gain: 1.5, reverb: 0.3 },
    perc: { gain: 1.2 },
  },
  space: {
    size: 0.7,
    decay: 2.4,
    damping: 0.45,
    preDelay: 0.025,
    level: 0.55,
    delayBeats: 1,
    delayFeedback: 0.2,
  },
  master: { targetLufs: -16, ceilingDb: -1, character: "warm", tilt: 0.25 },
};
