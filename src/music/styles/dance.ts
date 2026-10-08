import type { StyleDef } from "./types";

/**
 * 动感电音 — four-on-the-floor house: kick on every beat, open hat on every
 * off-beat, clap on two and four, a bass that answers the kick from the
 * off-beats, and wide synth chords that duck under the kick. Every drop is
 * prepared by a build with a snare roll and a riser.
 */
export const dance: StyleDef = {
  id: "dance",
  summary: "四拍底鼓、反拍开镲与二四拍拍手，贝斯落在反拍，合成器和弦随底鼓侧链呼吸，军鼓滚奏铺垫后进入高潮",
  harmony: {
    modes: {
      major: [
        {
          scale: "major",
          bank: {
            verse: [
              ["vi", "IV", "I", "V"],
              ["I", "V", "vi", "IV"],
              ["IV", "I", "V", "vi"],
            ],
            chorus: [
              ["IV", "V", "vi", "I"],
              ["vi", "IV", "I", "V"],
              ["I", "V", "vi", "IV"],
              ["IV", "vi", "V", "V"],
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
              ["i", "iv", "bVI", "bVII"],
              ["i", "bVII", "bVI", "bVII"],
            ],
            chorus: [
              ["bVI", "bVII", "i", "bIII"],
              ["i", "bVI", "bIII", "bVII"],
              ["bVI", "bVII", "i", "i"],
              ["iv", "bVI", "i", "bVII"],
              ["bVI", "i", "bVII", "bVII"],
            ],
            build: [
              ["bVI", "bVI", "bVII", "bVII"],
              ["iv", "iv", "bVII", "bVII"],
            ],
          },
        },
      ],
    },
    colour: [0.1, 0.55],
    extensions: { major: ["add9", "maj7"], minor: ["7", "9"], dominant: ["", "sus4"] },
    variation: 0.2,
    secondary: 0,
    borrowed: 0.1,
    sus: 0.5,
    voicing: "close",
    voices: 4,
    register: [53, 76],
    turnaround: { major: ["V", "IV V"], minor: ["bVII", "v"] },
    cadence: { major: [["IV", "V"]], minor: [["bVI", "bVII"]] },
    final: { major: "I", minor: "i" },
  },
  melody: {
    density: 0.5,
    syncopation: 0.65,
    motifBars: 2,
    stepBias: 0.62,
    pickup: 0.3,
    ornaments: 0,
    space: 0.25,
    chorusLift: 3,
    gate: 0.85,
    // a hook that is looped, not developed
    hook: 0.7,
    cells: ["x..x..x.", "x.x..x..", "__x...x.", "x..x....", "x.x.x.x.", "x...x.x.", "x..x.x.."],
  },
  // struck and plucked leads are saturated into the mix; soft ones are pushed up to ride over the drop
  lead: {
    piano: { gain: 0.8, drive: 0.2 },
    guitar: { gain: 0.77, drive: 0.2 },
    pluck: { gain: 0.8, drive: 0.2 },
    bell: { gain: 0.72, drive: 0.15 },
    musicbox: { gain: 0.75, drive: 0.15 },
    marimba: { gain: 0.93, drive: 0.2 },
    vibes: { gain: 0.84, drive: 0.15 },
    flute: { gain: 0.94 },
    strings: { gain: 0.94 },
    guzheng: { gain: 0.69, drive: 0.2, highCut: 5500 },
    dizi: { gain: 0.77, highCut: 5500 },
  },
  comp: {
    voice: ["pluck", "epiano"],
    from: 0.3,
    patterns: {
      low: [{ rows: { all: "..x-..o-..x-..o-" } }],
      mid: [{ rows: { all: "..x-..o-..x-..o-" } }, { rows: { all: "X-.x-.o-..x-.o-." } }],
      high: [{ rows: { all: "X-.x-..o-.x-.o-." } }, { rows: { all: "X-.x-.o-X-.x-.o-" } }],
    },
  },
  // the pumping chords: a wide pad that ducks hard under every kick
  pad: { voice: ["pad", "airpad"], from: 0, register: [53, 77], voices: 4 },
  // plucked arpeggio for the groove and the breakdown; the drop belongs to the hook and the chords
  arp: {
    voice: ["bell", "pluck"],
    from: 0.3,
    mute: ["chorus", "intro", "outro"],
    pattern: ["up", "updown"],
    rate: { low: 2, mid: 2, high: 1 },
    octaves: 2,
    register: [60, 84],
    gate: 0.55,
  },
  bass: {
    voice: "synthBass",
    from: 0.12,
    feel: { low: "root", mid: "octave", high: "octave" },
    register: [31, 45],
    approach: 0,
    gate: 0.9,
    riffs: {
      low: ["..1...-...1...-."],
      mid: ["..1.-.1.-.1.-.1."],
      high: ["..1.-.1.-.1.-.1.", "..1.-.1.-.8.-.1.", "..11-.11-.11-.11"],
    },
  },
  drums: {
    kit: "electro",
    from: 0.1,
    grooves: {
      low: [{ kick: "x...x...x...x...", hatClosed: "..o...o...o...o." }],
      mid: [
        { kick: "X...X...X...X...", clap: "....x.......x...", hatOpen: "..o...o...o...o." },
        {
          kick: "X...X...X...X...",
          clap: "....x.......x...",
          hatOpen: "..x...x...x...x.",
          hatClosed: "x...x...x...x...",
        },
      ],
      high: [
        {
          kick: "X...X...X...X...",
          clap: "....X.......X...",
          hatOpen: "..x...x...x...x.",
          hatClosed: "x..gx..gx..gx..g",
        },
        {
          kick: "X...X...X...X...",
          clap: "....X.......X...",
          snare: "....x.......x...",
          hatOpen: "..x...x...x...x.",
          hatClosed: "xg.gxg.gxg.gxg.g",
        },
      ],
    },
    fills: {
      light: [{ clap: "............x.xx" }, { snare: "..............xx" }],
      full: [{ snare: "........x.x.xxxx" }, { snare: "........xxxxxxxx" }],
    },
    crash: "crash",
    impact: "subBoom",
    swell: true,
    ghost: 0,
    buildRoll: "snare",
  },
  perc: {
    from: 0.6,
    grooves: [
      { shaker: "..x.X.x...x.X.x." },
      { tambourine: "....X.......X...", shaker: "X.x.X.x.X.x.X.x." },
    ],
  },
  swing: 0,
  humanize: { timing: 2, velocity: 0.04 },
  form: {
    loop: "AB",
    build: true,
    intro: 0.8,
    outro: 0.8,
    tail: 2.2,
    energy: { verse: [0.72, 0.02], breakdown: [0.4, 0.02] },
  },
  mix: {
    lead: { gain: 0.9, reverb: 0.28, delay: 0.2, chorus: 0.2 },
    comp: { gain: 0.58, pan: 0.15, reverb: 0.2, delay: 0.15, drive: 0.25, duck: 0.6 },
    pad: { gain: 0.5, width: 1.4, reverb: 0.3, chorus: 0.6, lowCut: 180, duck: 0.85 },
    arp: { gain: 0.44, delay: 0.25, duck: 0.4 },
    // short off-beat notes: as loud as the kick when they sound, so the two take turns
    bass: { gain: 1.5, drive: 0.45, duck: 0.55 },
    // the drive rounds the kick's peak off (a clipped kick), which leaves room for everything else
    kit: { gain: 1.24, reverb: 0.08, drive: 0.12 },
    perc: { gain: 1.4 },
  },
  space: {
    size: 0.5,
    decay: 1.8,
    damping: 0.4,
    preDelay: 0.02,
    level: 0.45,
    delayBeats: 0.75,
    delayFeedback: 0.35,
  },
  master: { targetLufs: -16, ceilingDb: -1, character: "punchy", tilt: 0.15 },
};
