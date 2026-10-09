// The quality gate: what leaves the engine at the app's default faders, for
// every style, as a loop and as a piece that ends. Nobody listens to the
// engine while it is built, so everything that can be said about a mix
// without ears is said here as a bound that all 22 styles keep:
//
//   loudness      -16 LUFS ± 0.3, and the master never falls short of it
//   peak          under the limiter's ceiling (the soft clipper stays idle)
//   clean         no isolated sample steps (clicks), no DC, finite
//   balance       every track that plays can be heard, none outweighs the mix,
//                 the tune carries more of the 500 Hz–6 kHz band than the
//                 chords and is the louder of the two at its loudest moment
//   stereo        the mix and every stem keep their channels related, and
//                 what is under 80 Hz sits in the middle
//   ends          a loop wraps without a step or a kink; a piece that ends
//                 starts on zero, dies away and ends in digital silence
//   repeatable    a second render of the same config is bit-identical
//
// The numbers behind a failure:
//   npx tsx scripts/audio-audit.ts --style <id> --both --duration 20 --seed 20261 --solo-parts
// The per-style balances the mix reviews arrived at are pinned in
// tests/style-mix-*.test.ts; this file is the floor under all of them.
import test from "node:test";
import assert from "node:assert/strict";
import {
  LIMITS,
  LOW_END_HZ,
  auditConfig,
  clicksOf,
} from "../scripts/audio-audit";
import type { Audit, StemAudit } from "../scripts/audio-audit";
import { LIMITER_CEILING, MIN_STEM_CORRELATION } from "../src/audio/master";
import { renderScore } from "../src/audio/render";
import type { StereoPcm } from "../src/audio/render-types";
import { STYLE_IDS } from "../src/music/catalog";
import { compose } from "../src/music/compose";
import { DEFAULT_CONFIG, stylePreset } from "../src/music/defaults";
import { TRACKS } from "../src/music/score";
import type { TrackName } from "../src/music/score";
import type { MusicConfig } from "../src/types";

const DURATION = 20;
const SEED = 20261;

/** The gate. Every bound holds for all 22 styles, loop and one-shot, with room for another seed. */
const GATE = {
  /** integrated loudness within this of the target, LU */
  lufsTolerance: 0.3,
  /** sample peak of the mix before the soft clipper (the limiter's ceiling plus its 2 % interpolation slack) */
  peak: LIMITER_CEILING * 1.02,
  /** 4× oversampled peak after the soft clipper, dBFS */
  truePeakDb: -1,
  /** share of samples past the soft clipper's knee */
  kneeShare: 0.001,
  /** peak over RMS of the mix, dB: neither crushed nor all transient */
  crest: [9.5, 18.5] as const,
  /** octave-band slope, dB per octave (pink 0): from the darkest lo-fi to the brightest chip tune */
  slope: [-5, 0.3] as const,
  /** no band of the six may hold more than this share of the energy */
  bandShare: 0.8,
  /** the loudest 400 ms of a track that plays, LUFS at the default fader */
  audibleLufs: -40,
  /**
   * The tune against the chords: power between 500 Hz and 6 kHz over the whole
   * piece (dB), and the loudest 400 ms of each (LU). The first cannot hold
   * where the tune is a bell struck now and then over pads that never stop
   * (PAD_LED): there only the second is asked.
   */
  leadOverChordsDb: 0.5,
  leadOverChordsPeakLu: 0,
  /** L/R correlation of the mix and of every stem */
  correlation: 0.35,
  stemCorrelation: MIN_STEM_CORRELATION - 0.02,
  /** L/R correlation under LOW_END_HZ (where there is a low end at all) */
  lowCorrelation: 0.95,
  /** loop seam: the step and the kink across the wrap against the usual ones around it */
  seamRatio: 1.5,
  kinkRatio: 2,
  /** a piece that ends: last 50 ms RMS, dBFS; and no more than this of trailing silence, seconds */
  endDb: -90,
  silentTail: 2.6,
  /** master: limiter activity and depth, mean compression */
  limiterActive: 0.22,
  limiterDb: 6,
  compressorMeanDb: 2,
};

/** Styles whose harmony is a continuous bed and whose tune is sparse by design. */
const PAD_LED: readonly string[] = ["ambient"];

/** FNV-1a over the bits of every sample of the four stems. */
function hashStems(stems: Record<TrackName, StereoPcm>): string {
  let hash = 0x811c9dc5;
  for (const track of TRACKS)
    for (const channel of stems[track]) {
      const words = new Uint32Array(
        channel.buffer,
        channel.byteOffset,
        channel.length,
      );
      for (let i = 0; i < words.length; i++) {
        hash ^= words[i];
        hash = Math.imul(hash, 0x01000193);
      }
    }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Power of a stem between 500 Hz and 6 kHz against the whole mix, dB. */
function voiceBand(stem: StemAudit): number {
  const bands = stem.spectrum?.bands;
  return bands
    ? 10 * Math.log10(10 ** (bands.mid / 10) + 10 ** (bands.presence / 10))
    : -Infinity;
}

/** Every bound of the gate the audit is outside of. */
function violations(audit: Audit): string[] {
  const found: string[] = [];
  const { mix, stems, seam, edges } = audit;
  const master = audit.render.master;
  const within = (
    name: string,
    value: number,
    [low, high]: readonly [number, number],
  ) => {
    if (!(value >= low && value <= high))
      found.push(`${name} ${value} outside ${low} … ${high}`);
  };
  if (!mix.finite) found.push("non-finite samples");
  if (!(Math.abs(mix.lufs - mix.targetLufs) <= GATE.lufsTolerance))
    found.push(
      `mix at ${mix.lufs} LUFS (target ${mix.targetLufs} ± ${GATE.lufsTolerance})`,
    );
  if (master.shortfallLu !== 0)
    found.push(`master stayed ${master.shortfallLu} LU short of the target`);
  if (!(mix.prePeak <= GATE.peak))
    found.push(`mix peaks at ${mix.prePeak}, over the limiter's ceiling`);
  if (!(mix.truePeakDb <= GATE.truePeakDb))
    found.push(`true peak ${mix.truePeakDb} dBFS`);
  if (!(mix.kneeShare <= GATE.kneeShare))
    found.push(
      `${(mix.kneeShare * 100).toFixed(3)} % of the samples past the clipper's knee`,
    );
  within("crest factor (dB)", mix.crestDb, GATE.crest);
  within(
    "spectral slope (dB/octave)",
    mix.spectrum.slopeDbPerOctave,
    GATE.slope,
  );
  for (const [band, level] of Object.entries(mix.spectrum.bands))
    if (!(10 ** (level / 10) <= GATE.bandShare))
      found.push(
        `the ${band} band carries ${(10 ** (level / 10) * 100).toFixed(0)} % of the energy`,
      );
  if (!(Math.max(Math.abs(mix.dc[0]), Math.abs(mix.dc[1])) <= LIMITS.dc))
    found.push(`DC offset ${mix.dc.join(" / ")}`);
  if (mix.clicks.count !== 0)
    found.push(
      `${mix.clicks.count} click(s): a step of ${mix.clicks.worstStep} at ${mix.clicks.at} s, ${mix.clicks.worstRatio}× its surroundings`,
    );
  if (!(mix.correlation >= GATE.correlation))
    found.push(`stereo correlation ${mix.correlation}`);
  if (
    mix.lowEndDb > LIMITS.lowEndFloorDb &&
    !(mix.correlationLow >= GATE.lowCorrelation)
  )
    found.push(
      `correlation ${mix.correlationLow} under ${LOW_END_HZ} Hz: the low end is not in the middle`,
    );

  let sounding = 0;
  for (const track of TRACKS) {
    const stem = stems[track];
    if (stem.empty) {
      if (Number.isFinite(stem.rawLufs))
        found.push(
          `${track} has no part but is not silent (${stem.rawLufs} LUFS)`,
        );
      continue;
    }
    sounding++;
    if (!(stem.momentaryMax > GATE.audibleLufs))
      found.push(
        `${track} cannot be heard: its loudest 400 ms reach ${stem.momentaryMax} LUFS`,
      );
    // ungated on both sides: a stem that outweighs the whole mix means the stems cancel each other
    if (!(stem.belowMixLu >= -LIMITS.stemOverMixLu))
      found.push(
        `${track} alone is ${-stem.belowMixLu} LU louder than the mix it is part of`,
      );
    if (!(stem.correlation >= GATE.stemCorrelation))
      found.push(`${track} stem: L/R correlation ${stem.correlation}`);
  }
  if (sounding < 2) found.push(`only ${sounding} track sounds`);
  if (stems.melody.empty) found.push("no tune");
  else if (!stems.chords.empty) {
    const lead = voiceBand(stems.melody) - voiceBand(stems.chords);
    if (
      !PAD_LED.includes(audit.score.style) &&
      !(lead >= GATE.leadOverChordsDb)
    )
      found.push(
        `between 500 Hz and 6 kHz the tune is ${lead.toFixed(1)} dB against the chords`,
      );
    const peak = stems.melody.momentaryMax - stems.chords.momentaryMax;
    if (!(peak >= GATE.leadOverChordsPeakLu))
      found.push(
        `at its loudest the tune is ${peak.toFixed(1)} LU against the chords at theirs`,
      );
  }

  if (audit.score.loop) {
    if (!seam) found.push("no seam measurement");
    else {
      if (!(seam.jumpRatio <= GATE.seamRatio))
        found.push(
          `the loop seam steps ${seam.jump}: ${seam.jumpRatio}× the usual step around it`,
        );
      if (!(seam.kinkRatio <= GATE.kinkRatio))
        found.push(
          `the loop seam bends ${seam.kinkRatio}× the usual bend around it`,
        );
    }
  } else if (!edges) found.push("no edge measurement");
  else {
    if (edges.firstSample !== 0)
      found.push(`starts at sample value ${edges.firstSample}`);
    if (edges.lastSample !== 0)
      found.push(`ends at sample value ${edges.lastSample}`);
    if (!(edges.endDb <= GATE.endDb))
      found.push(`the last 50 ms are at ${edges.endDb} dBFS`);
    if (!(edges.silentTail <= GATE.silentTail))
      found.push(`${edges.silentTail} s of silence at the end`);
  }

  if (!(master.limiter.activeRatio <= GATE.limiterActive))
    found.push(
      `limiter busy ${(master.limiter.activeRatio * 100).toFixed(0)} % of the time`,
    );
  if (!(master.limiter.maxReductionDb <= GATE.limiterDb))
    found.push(`limiter down ${master.limiter.maxReductionDb.toFixed(1)} dB`);
  if (!(master.compressor.meanReductionDb <= GATE.compressorMeanDb))
    found.push(
      `compressor ${master.compressor.meanReductionDb.toFixed(1)} dB on average`,
    );
  return found;
}

STYLE_IDS.forEach((style, index) =>
  test(`audio quality: ${style} (loop and one-shot, ${DURATION} s)`, async (t) => {
    const failures: string[] = [];
    for (const loop of [true, false]) {
      const mode = loop ? "loop" : "song";
      const config: MusicConfig = {
        ...DEFAULT_CONFIG,
        ...stylePreset(style),
        duration: DURATION,
        loop,
        seed: SEED,
      };
      let hash = "";
      const audit = await auditConfig(config, {
        onAudio: (audio) => (hash = hashStems(audio.stems)),
      });
      // the piece has the length it was asked for (a loop: its whole bars)
      if (loop)
        assert.ok(
          Math.abs(audit.score.duration - DURATION) <=
            240 / audit.score.bpm + 1e-3,
          `loop of ${audit.score.duration} s`,
        );
      else assert.equal(audit.score.duration, DURATION);
      const stems = TRACKS.map((track) =>
        audit.stems[track].empty ? "–" : audit.stems[track].lufs.toFixed(1),
      ).join(" / ");
      const lead = audit.stems.chords.empty
        ? "–"
        : `${(voiceBand(audit.stems.melody) - voiceBand(audit.stems.chords)).toFixed(1)} dB / ${(audit.stems.melody.momentaryMax - audit.stems.chords.momentaryMax).toFixed(1)} LU`;
      t.diagnostic(
        `${mode}: ${audit.mix.lufs.toFixed(2)} LUFS, peak ${audit.mix.peakDb.toFixed(1)} dBFS, crest ${audit.mix.crestDb.toFixed(1)}, slope ${audit.mix.spectrum.slopeDbPerOctave}, corr ${audit.mix.correlation}, stems ${stems}, tune over chords ${lead}, ${
          audit.seam
            ? `seam ×${audit.seam.jumpRatio}`
            : `end ${audit.edges?.endDb} dBFS`
        }, ${hash}`,
      );
      for (const problem of violations(audit))
        failures.push(`${mode}: ${problem}`);
      // repeatable: one mode per style is rendered a second time, from the config up
      if (loop === (index % 2 === 0)) {
        const again = await renderScore(compose(config));
        assert.equal(
          hashStems(again.stems),
          hash,
          `${style} ${mode}: a second render differs from the first`,
        );
      }
    }
    assert.deepEqual(failures, [], `${style}: ${failures.join("; ")}`);
  }),
);

test("audio quality: the click detector sees a step and ignores drums, square waves and steady tones", () => {
  const frames = 48000;
  const tone = Float32Array.from(
    { length: frames },
    (_, i) => 0.3 * Math.sin((2 * Math.PI * 220 * i) / 48000),
  );
  assert.equal(clicksOf([tone], frames, 48000, false).count, 0);
  // a tone with a whole number of cycles wraps cleanly; cut anywhere else, the wrap is a click
  assert.equal(clicksOf([tone], frames, 48000, true).count, 0);
  const cut = tone.subarray(0, 24055);
  assert.equal(clicksOf([cut], cut.length, 48000, false).count, 0);
  assert.equal(clicksOf([cut], cut.length, 48000, true).count, 1);
  // a note cut off without a fade
  const chopped = Float32Array.from(tone);
  chopped.fill(0, 30030);
  const found = clicksOf([chopped], frames, 48000, false);
  assert.equal(found.count, 1);
  assert.ok(
    Math.abs(found.at - 30030 / 48000) < 0.001 &&
      found.worstRatio > LIMITS.clickRatio,
  );
  // a square wave is all steps and no click; so is a burst of noise with an abrupt start
  const square = Float32Array.from({ length: frames }, (_, i) =>
    Math.floor(i / 55) % 2 ? 0.25 : -0.25,
  );
  assert.equal(clicksOf([square], frames, 48000, false).count, 0);
  let seed = 9;
  const noise = Float32Array.from({ length: frames }, (_, i) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return i > 20000 && i < 26000
      ? (seed / 2147483648 - 1) * 0.4 * Math.exp(-(i - 20000) / 1500)
      : 0;
  });
  assert.equal(clicksOf([noise], frames, 48000, false).count, 0);
});
