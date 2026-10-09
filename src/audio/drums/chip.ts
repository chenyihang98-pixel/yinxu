/**
 * The 8-bit console kit, plus the two noise-channel kinds (noiseHit,
 * noiseTick) that sound like a console in every kit.
 *
 * Everything is made the way a 2A03-style sound chip makes it: a 15-bit LFSR
 * noise channel (long, or the short "metallic" sequence), pulse waves with
 * fixed duty cycles and a 16-step staircase triangle. A sound is a list of
 * register writes at 240 Hz — a 4-bit volume and a pitch (or noise clock)
 * per tick — so envelopes move in steps and pitches jump, never glide.
 * Nothing is filtered: the output only ever takes a few discrete levels.
 */
import { CYMBAL_SWELL_SECONDS } from "../../music/score";
import type { DrumKind } from "../../music/score";
import type { Hit, Kit } from "./core";
import { byVel } from "./core";

type Source = "noise" | "metal" | "pulse" | "tri";

interface Layer {
  src: Source;
  /** 4-bit volume per tick */
  vol: readonly number[];
  /** noise clock or pitch in Hz per tick; the last value holds */
  hz: readonly number[];
  /** pulse duty cycle */
  duty: number;
  gain: number;
}
type Patch = readonly Layer[];

/** Ticks (register writes) per second. */
const RATE = 240;
/** A clock this fast gives a new noise bit on every sample: white. */
const WHITE = 56000;
/** The fastest clock that still darkens audibly when a soft hit slows it down. */
const TICK = 28000;

const rep = (value: number, count: number): number[] =>
  Array.from({ length: count }, () => value);
/** `count` volumes from a to b in a straight line. */
const ramp = (a: number, b: number, count: number): number[] =>
  Array.from({ length: count }, (_, i) =>
    Math.round(a + ((b - a) * i) / Math.max(1, count - 1)),
  );
/** `count` pitches from a to b, equal ratio per tick. */
const glide = (a: number, b: number, count: number): number[] =>
  Array.from({ length: count }, (_, i) =>
    Math.round(a * Math.pow(b / a, i / Math.max(1, count - 1))),
  );
/** `count` ticks cycling through the given pitches. */
const arpeggio = (notes: readonly number[], count: number): number[] =>
  Array.from({ length: count }, (_, i) => notes[i % notes.length]);
const layer = (
  src: Source,
  vol: readonly number[],
  hz: readonly number[],
  gain = 1,
  duty = 0.5,
): Layer => ({ src, vol, hz, duty, gain });

/** Volume of the rising noise of a swell (432 ticks for 1.8 s), steeper towards the end. */
const SWELL_TICKS = Math.round(CYMBAL_SWELL_SECONDS * RATE);
const swellVol = Array.from(
  { length: SWELL_TICKS },
  (_, t) => 1 + Math.floor(14.999 * Math.pow(t / (SWELL_TICKS - 1), 1.7)),
);
const swellHz = Array.from({ length: SWELL_TICKS }, (_, t) =>
  Math.round(2300 * Math.pow(WHITE / 2300, t / (SWELL_TICKS - 1))),
);

const tom = (from: number, to: number): Patch => [
  layer("tri", [...rep(15, 22), 11, 8, 5, 3, 2, 1], glide(from, to, 20)),
  layer("noise", [6, 3, 1], [7000], 0.4),
];

// prettier-ignore
const PATCHES: Record<DrumKind, Patch> = {
  // triangle dive with a tick of low noise
  kick: [
    layer("tri", [...rep(15, 20), 11, 8, 5, 3, 2, 1], glide(190, 46, 16)),
    layer("noise", [10, 5, 2], [3500], 0.5),
  ],
  // noise channel plus a triangle blip for the body
  snare: [
    layer("noise", [15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 6, 5, 5, 4, 4, 3, 3, 3, 2, 2, 2, 2, 1, 1, 1, 1], [14000, 9000, 7000], 0.8),
    layer("tri", [15, 15, 15, 12, 8, 4], glide(340, 190, 6), 0.6),
  ],
  rim: [
    layer("pulse", [12, 6, 3, 1], [1760], 1, 0.125),
    layer("noise", [8], [28000], 0.5),
  ],
  // three re-triggered bursts, then the decay
  clap: [layer("noise", [13, 6, 0, 13, 6, 0, 14, 12, 10, 8, 7, 6, 5, 4, 3, 3, 2, 2, 1, 1, 1], [11200])],
  hatClosed: [layer("noise", [11, 7, 4, 2, 1], [TICK])],
  hatOpen: [layer("noise", ramp(12, 1, 34), [WHITE])],
  // short-sequence noise is pitched and metallic; a thin pulse pings on top
  ride: [
    layer("metal", [10, 9, 8, 7, 6, 5, 5, 4, 4, 3, 3, 3, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1], [44700], 0.8),
    layer("pulse", [8, 4, 2, 1], [3520], 0.5, 0.125),
  ],
  // the noise clock steps down as the volume falls: it darkens like a cymbal
  crash: [layer("noise", ramp(15, 1, 150), [...rep(WHITE, 10), ...rep(28000, 18), ...rep(18600, 26), ...rep(14000, 36), 11200])],
  tomLow: tom(175, 87),
  tomMid: tom(233, 117),
  tomHigh: tom(311, 156),
  shaker: [layer("noise", [2, 4, 6, 8, 7, 5, 4, 3, 2, 1, 1], [WHITE])],
  tambourine: [
    layer("metal", [10, 6, 3, 9, 7, 5, 4, 3, 3, 2, 2, 1, 1, 1], [111900], 0.8),
    layer("noise", [6, 3, 1], [WHITE], 0.5),
  ],
  woodblock: [layer("pulse", [13, 9, 5, 3, 1], [1245, 1109, 988], 1, 0.25)],
  brushSnare: [layer("noise", [1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 7, 7, 6, 6, 6, 5, 5, 5, 4, 4, 4, 4, 3, 3, 3, 3, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1], [9000])],
  taiko: [
    layer("tri", [...rep(15, 56), ...ramp(14, 1, 28)], glide(150, 52, 30)),
    layer("noise", [12, 9, 6, 4, 3, 2, 1, 1], [1760], 0.6),
  ],
  // rising volume steps and a rising clock, cut after 1.8 s
  cymbalSwell: [layer("noise", [...swellVol, 10, 6, 3, 1], swellHz)],
  subBoom: [
    layer("tri", [...rep(15, 100), ...ramp(14, 1, 56)], glide(104, 33, 60)),
    layer("noise", [10, 10, 8, 8, 6, 6, 5, 5, 4, 4, 3, 3, 3, 2, 2, 2, 1, 1, 1, 1], [1760], 0.4),
  ],
  noiseHit: [layer("noise", [15, 13, 12, 11, 10, 9, 8, 7, 6, 6, 5, 5, 4, 4, 3, 3, 2, 2, 2, 1, 1, 1, 1], [18600, 11200, 9000, 7000])],
  noiseTick: [layer("noise", [12, 8, 5, 3, 2, 1], [TICK])],
  // a fast arpeggio of thin pulses: C8 E8 G8
  sleighBell: [
    layer("pulse", [9, 9, 11, 11, 10, 10, 9, 9, 8, 8, 7, 7, 6, 6, 6, 5, 5, 5, 4, 4, 4, 3, 3, 3, 3, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1], arpeggio([4186, 5274, 6272], 36), 1, 0.125),
    layer("metal", [5, 4, 3, 3, 2, 2, 1, 1, 1], [111900], 0.5),
  ],
  // two pulses an inharmonic interval apart swell and fade; metallic noise blooms behind them
  gong: [
    layer("pulse", [...ramp(4, 12, 10), ...rep(12, 20), ...ramp(12, 1, 270)], [98], 1, 0.25),
    layer("pulse", [...ramp(2, 9, 14), ...rep(9, 16), ...ramp(9, 1, 200)], [146], 0.8, 0.25),
    layer("metal", [...ramp(0, 5, 30), ...rep(5, 20), ...ramp(5, 1, 110)], [22400], 0.5),
  ],
  fingerSnap: [
    layer("noise", [3, 0, 12, 7, 4, 2, 1, 1], [14000]),
    layer("pulse", [0, 0, 8, 3], [2400], 0.5, 0.25),
  ],
};

const ticks = (patch: Patch): number =>
  patch.reduce((most, l) => Math.max(most, l.vol.length), 0);

interface Flavour {
  /** multiplies every noise clock (darker below 1) */
  clock: number;
  /** multiplies the tick length */
  stretch: number;
  lowpass: number;
  grit: number;
}

/** How noiseHit / noiseTick are coloured inside the other kits. */
// prettier-ignore
const FLAVOUR: Record<Kit, Flavour> = {
  pop: { clock: 1, stretch: 1, lowpass: 0, grit: 0 },
  lofi: { clock: 0.55, stretch: 0.9, lowpass: 6000, grit: 0.08 },
  electro: { clock: 1.2, stretch: 0.9, lowpass: 0, grit: 0 },
  acoustic: { clock: 0.9, stretch: 1.1, lowpass: 0, grit: 0 },
  brush: { clock: 0.8, stretch: 1, lowpass: 9000, grit: 0 },
  cinematic: { clock: 0.7, stretch: 1.6, lowpass: 0, grit: 0 },
  soft: { clock: 0.5, stretch: 0.9, lowpass: 5000, grit: 0 },
};
const PLAIN: Flavour = FLAVOUR.pop;

/** 16-step staircase triangle, -1..1. */
const TRIANGLE = Float32Array.from({ length: 32 }, (_, step) => {
  const value = step < 16 ? 15 - step : step - 16;
  return (value - 7.5) / 7.5;
});

function play(h: Hit, l: Layer, flavour: Flavour, accent: boolean): void {
  const { sr, n, vel, mid } = h;
  const tick = (sr / RATE) * flavour.stretch;
  // a console has no velocity: softer hits start from a lower volume and so end sooner
  const scale = Math.min(1, 0.45 + 0.6875 * vel);
  const noisy = l.src === "noise" || l.src === "metal";
  const tune = noisy ? flavour.clock * byVel(h, 0.7, 1.075) : 1;
  const tap = l.src === "metal" ? 6 : 1;
  let register = 1 + ((h.dice.uniform() * 32766) | 0);
  let value = register & 1 ? -1 : 1;
  let phase = l.src === "tri" ? 7 / 32 : 0;
  // the two things a console can do for a harder hit besides volume: a
  // thinner (brighter) pulse, and more of the noise burst on a triangle drum
  const duty =
    l.src === "pulse" && vel < 0.55 ? Math.min(0.5, l.duty * 2) : l.duty;
  const gain = accent ? l.gain * byVel(h, 0.4, 1.15) : l.gain;
  const high = 2 * (1 - duty);
  const low = -2 * duty;
  // a soft hit eases in: its first couple of milliseconds play at half volume
  const ease = vel < 0.5 ? Math.round(0.002 * sr) : 0;
  for (let t = 0; t < l.vol.length; t++) {
    let from = Math.round(t * tick);
    if (from >= n) break;
    const to = Math.min(n, Math.round((t + 1) * tick));
    const volume = Math.round(l.vol[t] * scale);
    const hz = l.hz[t < l.hz.length ? t : l.hz.length - 1] * tune;
    const inc = hz / sr;
    const amp = (volume / 15) * gain;
    if (volume === 0) {
      // the channel keeps running while it is silent
      phase += inc * (to - from);
      phase -= Math.floor(phase);
      continue;
    }
    for (let part = t === 0 && ease > 0 ? 0 : 1; part < 2; part++) {
      const level = part === 0 ? (Math.ceil(volume / 2) / 15) * gain : amp;
      const stop = part === 0 ? Math.min(to, from + ease) : to;
      if (noisy)
        for (let i = from; i < stop; i++) {
          phase += inc;
          while (phase >= 1) {
            phase -= 1;
            const bit = (register ^ (register >> tap)) & 1;
            register = (register >> 1) | (bit << 14);
            value = register & 1 ? -1 : 1;
          }
          mid[i] += value * level;
        }
      else if (l.src === "pulse")
        for (let i = from; i < stop; i++) {
          mid[i] += (phase < duty ? high : low) * level;
          phase += inc;
          if (phase >= 1) phase -= 1;
        }
      else
        for (let i = from; i < stop; i++) {
          mid[i] += TRIANGLE[(phase * 32) | 0] * level;
          phase += inc;
          if (phase >= 1) phase -= 1;
        }
      from = stop;
    }
  }
}

function render(h: Hit, kind: DrumKind, flavour: Flavour): void {
  const patch = PATCHES[kind];
  for (const l of patch)
    play(h, l, flavour, patch[0].src === "tri" && l.src === "noise");
  // undo the volume scaling of soft hits: level belongs to the velocity law
  h.trim = 1 / Math.min(1, 0.45 + 0.6875 * h.vel);
  h.lowpass = flavour.lowpass;
  h.grit = flavour.grit;
}

/** Seconds after the last tick: room for the closing fade. */
const TAIL = 0.005;

/** The console kit: every kind. */
export const CHIP = {
  length: (kind: DrumKind): number => ticks(PATCHES[kind]) / RATE + TAIL,
  render: (h: Hit, kind: DrumKind): void => render(h, kind, PLAIN),
};

/** noiseHit / noiseTick inside any other kit. */
export const NOISE_CHANNEL = {
  length: (kind: "noiseHit" | "noiseTick", kit: Kit): number =>
    (ticks(PATCHES[kind]) / RATE) * FLAVOUR[kit].stretch + TAIL,
  render: (h: Hit, kind: "noiseHit" | "noiseTick", kit: Kit): void =>
    render(h, kind, FLAVOUR[kit]),
};
