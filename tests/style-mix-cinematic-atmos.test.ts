// Mix review of the six cinematic and atmospheric styles — cinematic, epic,
// tension, dreamy, ambient, guofeng — locked in as measurements. Nobody can
// listen to the engine while it is developed, so what a mix engineer would
// judge by ear is asserted here from the rendered audio: who sits on top, how
// much low end there is, how bright, wide, wet and dynamic the mix is, that
// loops close evenly and that pieces which end grow and then die away.
//
// Every window is the value the review arrived at, with room for the engine
// to move a little: a failure means a style's balance has changed audibly.
// The numbers behind a failure (and the same tables for other settings):
//   npx tsx scripts/audio-audit.ts --style <id> --both --solo-parts --seed 20261
//
// Per style: its 24 s loop with every part also rendered alone, the shortest
// piece that ends and has both a verse and a chorus (30 to 45 s), and three
// 16 s loops at other settings. About 40 s for the whole file.
//
// Spectral slope is the audit's: least-squares over the octave bands 63 Hz to
// 8 kHz with pink noise at 0, so the familiar "-4.5 dB per octave" of finished
// music (power per hertz) reads -1.5 here.
//
// Engine finalisation moved two sets of windows without changing a style's
// balance: the crest windows came down 1.5–3 dB and the limiter may now work
// up to a fifth of the time, because the master gained a density stage (a
// drum-bus peak compressor and, per character, a lower limiter ceiling).
import test from "node:test";
import assert from "node:assert/strict";
import { auditConfig } from "../scripts/audio-audit";
import type { Audit } from "../scripts/audio-audit";
import { Biquad } from "../src/audio/dsp";
import { REFERENCE_VOLUMES } from "../src/audio/render-types";
import type { InstrumentId, StyleId } from "../src/music/catalog";
import { compose } from "../src/music/compose";
import { DEFAULT_CONFIG, stylePreset } from "../src/music/defaults";
import { TRACKS } from "../src/music/score";
import type { TrackName } from "../src/music/score";
import { getStyle } from "../src/music/styles";
import { scoreProblems } from "../src/music/validate";
import type { MusicConfig } from "../src/types";

const SEED = 20261;
/** length asked for when a style is rendered with other settings than its own (loops snap to whole bars) */
const VARIANT_SECONDS = 16;

type Range = readonly [low: number, high: number];

interface Expect {
  /** seconds asked for: the loop, and the shortest piece that ends and still has a verse and a chorus */
  loop: number;
  song: number;
  /** melody stem over chords stem at the default faders, LU */
  melodyOverChords: Range;
  /** LU the bass / drums stem sits under the mix (null: the style has no drums at its own energy) */
  bassUnderMix: Range;
  drumsUnderMix: Range | null;
  /** every supporting part alone against the raw mix, LU (the lead is checked separately) */
  support: Range;
  /** dB per octave, pink = 0 */
  slope: Range;
  /** most the sub band (< 60 Hz) and least the air band (> 6 kHz) may carry, dB against the whole mix */
  subMax: number;
  airMin: number;
  correlation: Range;
  crest: Range;
  /** reverb return of the melody track against its dry signal, dB */
  melodyReverb: Range;
  /** chorus over verse in the piece that ends, LU */
  chorusOverVerse: Range;
  /** melody over chords with the energy at 0.9: the tune must not drown when everything plays */
  loudMelodyOverChords: number;
  /** least the melody track must have over everything else between 1 and 4 kHz, dB */
  leadPresence: number;
  /** a lead far from the style's own */
  otherLead: InstrumentId;
}

const EXPECT: Record<string, Expect> = {
  cinematic: {
    loop: 24,
    song: 36,
    melodyOverChords: [1, 5],
    bassUnderMix: [5.5, 10],
    drumsUnderMix: [5, 11],
    support: [-16, -4],
    slope: [-3.2, -1.6],
    subMax: -13,
    airMin: -33,
    correlation: [0.55, 0.92],
    crest: [10, 17.5],
    melodyReverb: [-11, -4.5],
    chorusOverVerse: [0.3, 4],
    loudMelodyOverChords: 0.5,
    leadPresence: 1,
    otherLead: "guzheng",
  },
  epic: {
    loop: 24,
    song: 30,
    melodyOverChords: [1.5, 5],
    bassUnderMix: [5, 9.5],
    drumsUnderMix: [4.5, 8.5],
    support: [-16, -4],
    slope: [-3.2, -1.2],
    subMax: -9,
    airMin: -30,
    correlation: [0.6, 0.95],
    crest: [9, 16.5],
    melodyReverb: [-11, -5],
    chorusOverVerse: [0.5, 4],
    loudMelodyOverChords: 1,
    leadPresence: 0.5,
    otherLead: "piano",
  },
  tension: {
    loop: 24,
    song: 30,
    melodyOverChords: [1.5, 5.5],
    bassUnderMix: [4.5, 9.5],
    drumsUnderMix: [4.5, 10],
    support: [-27, -4],
    slope: [-3.8, -1.6],
    subMax: -10,
    airMin: -37,
    correlation: [0.55, 0.92],
    crest: [10, 17.5],
    melodyReverb: [-10, -4],
    chorusOverVerse: [0.3, 4],
    loudMelodyOverChords: 0.5,
    leadPresence: 1.5,
    otherLead: "marimba",
  },
  dreamy: {
    loop: 24,
    song: 40,
    melodyOverChords: [1.5, 5.5],
    bassUnderMix: [5.5, 10.5],
    drumsUnderMix: null,
    support: [-14, -4],
    slope: [-2.8, -0.6],
    subMax: -12,
    airMin: -32,
    correlation: [0.48, 0.85],
    crest: [9, 17.5],
    melodyReverb: [-8, -2.5],
    chorusOverVerse: [-0.5, 3],
    loudMelodyOverChords: 0.5,
    leadPresence: 0.5,
    otherLead: "strings",
  },
  ambient: {
    loop: 24,
    song: 45,
    // single bell strokes over held pads: the pads carry more loudness over time, the bell is on top when it strikes
    melodyOverChords: [-4, 1.5],
    bassUnderMix: [5, 10.5],
    drumsUnderMix: null,
    support: [-14, -3.5],
    slope: [-4, -1.5],
    subMax: -15,
    airMin: -38,
    correlation: [0.45, 0.88],
    crest: [8, 16.5],
    melodyReverb: [-6, 0],
    chorusOverVerse: [-1, 2.5],
    loudMelodyOverChords: -4,
    leadPresence: -6,
    otherLead: "flute",
  },
  guofeng: {
    loop: 24,
    song: 36,
    melodyOverChords: [1, 5.5],
    bassUnderMix: [5, 10],
    drumsUnderMix: [10, 19],
    support: [-19, -4],
    slope: [-2.8, -0.8],
    subMax: -18,
    airMin: -34,
    correlation: [0.55, 0.92],
    crest: [10, 18.5],
    melodyReverb: [-11, -5],
    chorusOverVerse: [0.3, 4],
    loudMelodyOverChords: 0.5,
    leadPresence: 4,
    otherLead: "piano",
  },
};

const STYLES = Object.keys(EXPECT) as StyleId[];

/* ------------------------------------------------------------------ */
/* measuring                                                           */
/* ------------------------------------------------------------------ */

interface Measured {
  audit: Audit;
  /** RMS of the last two seconds over the first two, dB (loops: how big the step at the wrap is) */
  tailOverHead: number;
  /** RMS of the last second, and of the second before it, against the whole piece, dB */
  lastSecond: number;
  secondBeforeLast: number;
  /** melody stem against everything else between 1 and 4 kHz, dB */
  leadPresence: number;
}

const db = (power: number) => (power > 0 ? 10 * Math.log10(power) : -Infinity);

function meanSquare(
  left: Float32Array,
  right: Float32Array,
  from: number,
  to: number,
): number {
  let sum = 0;
  const a = Math.max(0, Math.floor(from));
  const b = Math.min(left.length, Math.max(a + 1, Math.floor(to)));
  for (let i = a; i < b; i++) sum += left[i] * left[i] + right[i] * right[i];
  return sum / (2 * (b - a));
}

/** Energy between 1 and 4 kHz (fourth-order Butterworth edges). */
function presenceEnergy(
  left: Float32Array,
  right: Float32Array,
  frames: number,
  sampleRate: number,
): number {
  const buffer = new Float32Array(frames);
  let total = 0;
  for (const channel of [left, right]) {
    buffer.set(channel.subarray(0, frames));
    for (const q of [0.5412, 1.3066]) {
      new Biquad().setHighpass(1000, q, sampleRate).process(buffer, frames);
      new Biquad().setLowpass(4000, q, sampleRate).process(buffer, frames);
    }
    for (let i = 0; i < frames; i++) total += buffer[i] * buffer[i];
  }
  return total;
}

const cache = new Map<string, Promise<Measured>>();

/** One render per distinct config, shared by the tests that look at it. */
function measure(
  style: StyleId,
  over: Partial<MusicConfig>,
  soloParts = false,
): Promise<Measured> {
  const config: MusicConfig = {
    ...DEFAULT_CONFIG,
    ...stylePreset(style),
    seed: SEED,
    ...over,
  };
  const key = JSON.stringify([config, soloParts]);
  let pending = cache.get(key);
  if (!pending) {
    pending = (async () => {
      const result = {
        tailOverHead: 0,
        lastSecond: 0,
        secondBeforeLast: 0,
        leadPresence: 0,
      };
      const audit = await auditConfig(config, {
        soloParts,
        onAudio: ({ mix, stems, sampleRate }) => {
          const [left, right] = mix;
          const frames = left.length;
          const two = Math.min(frames >> 1, 2 * sampleRate);
          result.tailOverHead = db(
            meanSquare(left, right, frames - two, frames) /
              meanSquare(left, right, 0, two),
          );
          const whole = meanSquare(left, right, 0, frames);
          result.lastSecond = db(
            meanSquare(left, right, frames - sampleRate, frames) / whole,
          );
          result.secondBeforeLast = db(
            meanSquare(
              left,
              right,
              frames - 2 * sampleRate,
              frames - sampleRate,
            ) / whole,
          );
          let others = 0;
          for (const track of TRACKS)
            if (track !== "melody")
              others +=
                presenceEnergy(
                  stems[track][0],
                  stems[track][1],
                  frames,
                  sampleRate,
                ) *
                REFERENCE_VOLUMES[track] ** 2;
          const melody =
            presenceEnergy(
              stems.melody[0],
              stems.melody[1],
              frames,
              sampleRate,
            ) *
            REFERENCE_VOLUMES.melody ** 2;
          result.leadPresence = db(melody / Math.max(1e-30, others));
        },
      });
      return { audit, ...result };
    })();
    cache.set(key, pending);
  }
  return pending;
}

const within = (value: number, [low, high]: Range, what: string) =>
  assert.ok(
    value >= low && value <= high,
    `${what}: ${value.toFixed(2)} is outside ${low} … ${high}`,
  );
const fixed = (value: number, digits = 1) =>
  Number.isFinite(value) ? value.toFixed(digits) : String(value);
const under = (audit: Audit, track: TrackName) =>
  audit.mix.lufs - audit.stems[track].lufs;
const melodyOverChords = (audit: Audit) =>
  audit.stems.melody.lufs - audit.stems.chords.lufs;

/** What every render has to satisfy, whatever the settings. */
function assertMastered(audit: Audit, label: string): void {
  assert.deepEqual(
    audit.flags.filter((flag) => !flag.includes("inaudible")),
    [],
    `${label}: ${audit.flags.join("; ")}`,
  );
  within(audit.mix.lufs, [-16.5, -15.5], `${label} loudness`);
  assert.ok(
    audit.render.master.shortfallLu <= 0.05,
    `${label}: master ${audit.render.master.shortfallLu} LU short of the target`,
  );
  assert.ok(
    audit.mix.kneeShare < 0.002,
    `${label}: ${(audit.mix.kneeShare * 100).toFixed(2)} % of the samples reach the soft clipper`,
  );
  // (a denser master lowers the limiter's ceiling until it works up to a fifth of the time: DENSE_BUSY_RATIO in master.ts)
  assert.ok(
    audit.render.master.limiter.activeRatio < 0.22,
    `${label}: limiter busy ${(audit.render.master.limiter.activeRatio * 100).toFixed(0)} % of the time`,
  );
  assert.ok(
    audit.mix.correlationLow > 0.9,
    `${label}: low end not mono (${audit.mix.correlationLow})`,
  );
  assert.ok(
    audit.mix.correlation > 0.35,
    `${label}: stereo correlation ${audit.mix.correlation}`,
  );
  for (const track of TRACKS) {
    const stem = audit.stems[track];
    if (stem.empty) continue;
    // every track that plays can be heard, and none of them is fighting its own channels
    assert.ok(
      stem.momentaryMax > -42,
      `${label}: ${track} only reaches ${stem.momentaryMax} LUFS`,
    );
    assert.ok(
      stem.correlation > 0.1,
      `${label}: ${track} stem correlation ${stem.correlation}`,
    );
  }
}

/* ------------------------------------------------------------------ */
/* the tests                                                           */
/* ------------------------------------------------------------------ */

for (const style of STYLES) {
  const expect = EXPECT[style];

  test(`${style}: the loop at its own settings is balanced, toned and closes evenly`, async (t) => {
    const { audit, tailOverHead, leadPresence } = await measure(
      style,
      { loop: true, duration: expect.loop },
      true,
    );
    const { mix, stems } = audit;
    const bands = mix.spectrum.bands;
    t.diagnostic(
      `${fixed(mix.lufs, 2)} LUFS, crest ${fixed(mix.crestDb)}, corr ${fixed(mix.correlation, 2)}, slope ${fixed(mix.spectrum.slopeDbPerOctave, 2)}, bands ${Object.values(
        bands,
      )
        .map((v) => fixed(v, 0))
        .join("/")}, ` +
        `stems ${TRACKS.map((track) => (stems[track].empty ? "–" : fixed(stems[track].lufs))).join("/")}, m−c ${fixed(melodyOverChords(audit))}, bass↓ ${fixed(under(audit, "bass"))}, drums↓ ${stems.drums.empty ? "–" : fixed(under(audit, "drums"))}, ` +
        `lead 1–4k ${fixed(leadPresence)}, reverb ${fixed(stems.melody.reverbDb)}, seam ×${audit.seam?.jumpRatio}, tail/head ${fixed(tailOverHead)} dB, parts ${audit.parts?.map((part) => `${part.id} ${fixed(part.relLu)}`).join(" ")}`,
    );
    assertMastered(audit, `${style} loop`);

    // balance at the default faders
    within(
      melodyOverChords(audit),
      expect.melodyOverChords,
      `${style}: melody over chords (LU)`,
    );
    assert.ok(!stems.bass.empty, `${style}: no bass at its own settings`);
    within(
      under(audit, "bass"),
      expect.bassUnderMix,
      `${style}: bass under the mix (LU)`,
    );
    if (expect.drumsUnderMix)
      within(
        under(audit, "drums"),
        expect.drumsUnderMix,
        `${style}: drums under the mix (LU)`,
      );
    else assert.ok(stems.drums.empty, `${style}: drums at its own energy`);
    assert.ok(
      leadPresence >= expect.leadPresence,
      `${style}: the melody track has only ${fixed(leadPresence)} dB over the rest between 1 and 4 kHz`,
    );

    // every part on its own: the lead leads, nothing is lost, nothing crowds it
    const parts = audit.parts ?? [];
    const lead = parts.find((part) => part.role === "lead");
    assert.ok(lead, `${style}: no lead part`);
    for (const part of parts) {
      if (part === lead) continue;
      within(
        part.relLu,
        expect.support,
        `${style}: ${part.id} (${part.voice}) against the mix`,
      );
      // the pads of ambient hold while its bell rings out, so there the comparison is made on the loudest moments below
      if (style !== "ambient")
        assert.ok(
          part.relLu < lead.relLu + (part.track === "drums" ? 0.5 : 0),
          `${style}: ${part.id} (${fixed(part.relLu)}) is louder than the lead (${fixed(lead.relLu)})`,
        );
    }
    assert.ok(
      stems.melody.momentaryMax > stems.chords.momentaryMax,
      `${style}: at its loudest the melody track (${stems.melody.momentaryMax} LUFS) is under the chords (${stems.chords.momentaryMax})`,
    );
    within(lead.relLu, [-7, -1.5], `${style}: lead against the mix`);

    // tone
    within(
      mix.spectrum.slopeDbPerOctave,
      expect.slope,
      `${style}: spectral slope`,
    );
    assert.ok(
      bands.sub <= expect.subMax,
      `${style}: sub band at ${bands.sub} dB`,
    );
    assert.ok(
      bands.air >= expect.airMin,
      `${style}: air band at ${bands.air} dB`,
    );
    assert.ok(
      bands.lowMid <= -6,
      `${style}: low-mid band at ${bands.lowMid} dB (mud)`,
    );
    assert.ok(
      bands.presence <= -5,
      `${style}: presence band at ${bands.presence} dB (harsh)`,
    );

    // space, width and dynamics
    within(mix.correlation, expect.correlation, `${style}: stereo correlation`);
    within(mix.crestDb, expect.crest, `${style}: crest factor`);
    within(
      stems.melody.reverbDb,
      expect.melodyReverb,
      `${style}: melody reverb against dry (dB)`,
    );

    // the loop repeats without a click or a jump in level
    assert.ok(
      audit.seam && audit.seam.jumpRatio <= 3,
      `${style}: seam ×${audit.seam?.jumpRatio}`,
    );
    assert.ok(
      audit.seam.endDipDb > -30,
      `${style}: the loop ends in a hole (${audit.seam.endDipDb} dB)`,
    );
    within(
      tailOverHead,
      [-3.5, 3.5],
      `${style}: last two seconds over the first two (dB)`,
    );
    assert.ok(mix.lra <= 5, `${style}: loop loudness range ${mix.lra} LU`);
  });

  test(`${style}: a piece that ends grows into its chorus and dies away`, async (t) => {
    const { audit, lastSecond, secondBeforeLast } = await measure(style, {
      loop: false,
      duration: expect.song,
    });
    const sections = audit.sections.map(
      (section) => `${section.type} ${fixed(section.lufs)}`,
    );
    t.diagnostic(
      `${sections.join(" → ")}; LRA ${fixed(audit.mix.lra)}, m−c ${fixed(melodyOverChords(audit))}, corr ${fixed(audit.mix.correlation, 2)}, last 2 s ${fixed(secondBeforeLast)} → ${fixed(lastSecond)} dB, end ${audit.edges?.endDb} dBFS, silent ${audit.edges?.silentTail} s`,
    );
    assertMastered(audit, `${style} song`);
    assert.equal(audit.score.duration, expect.song);

    const of = (type: string) =>
      audit.sections.find((section) => section.type === type);
    const verse = of("verse");
    const chorus = of("chorus");
    const outro = of("outro");
    assert.ok(
      verse && chorus && outro,
      `${style}: form is ${audit.sections.map((section) => section.type).join(" ")}`,
    );
    within(
      chorus.lufs - verse.lufs,
      expect.chorusOverVerse,
      `${style}: chorus over verse (LU)`,
    );
    assert.ok(
      outro.lufs < Math.max(verse.lufs, chorus.lufs),
      `${style}: the outro (${outro.lufs}) does not come down from ${chorus.lufs}`,
    );
    const intro = of("intro");
    if (intro)
      assert.ok(
        intro.lufs < chorus.lufs,
        `${style}: the intro (${intro.lufs}) is as loud as the chorus (${chorus.lufs})`,
      );
    within(
      melodyOverChords(audit),
      [expect.melodyOverChords[0] - 1, expect.melodyOverChords[1] + 2],
      `${style}: melody over chords in the piece that ends (LU)`,
    );

    // the ending: falling through the last two seconds, far below the piece, and silent at the very end
    assert.ok(audit.edges, `${style}: no edge measurement`);
    assert.ok(
      audit.edges.firstSample <= 0.01,
      `${style}: starts at ${audit.edges.firstSample}`,
    );
    assert.ok(
      audit.edges.endDb <= -60 && audit.edges.lastSample <= 1e-4,
      `${style}: ends at ${audit.edges.endDb} dBFS`,
    );
    assert.ok(
      lastSecond < secondBeforeLast - 3,
      `${style}: the tail does not fall (${fixed(secondBeforeLast)} → ${fixed(lastSecond)} dB)`,
    );
    assert.ok(
      lastSecond < -22,
      `${style}: the last second is only ${fixed(lastSecond)} dB under the piece`,
    );
  });

  test(`${style}: the tune stays on top at high energy and with another lead instrument`, async (t) => {
    const loud = await measure(style, {
      loop: true,
      duration: VARIANT_SECONDS,
      energy: 0.9,
    });
    t.diagnostic(
      `energy 0.9: m−c ${fixed(melodyOverChords(loud.audit))}, bass↓ ${fixed(under(loud.audit, "bass"))}, drums↓ ${loud.audit.stems.drums.empty ? "–" : fixed(under(loud.audit, "drums"))}, lead 1–4k ${fixed(loud.leadPresence)}, crest ${fixed(loud.audit.mix.crestDb)}, slope ${fixed(loud.audit.mix.spectrum.slopeDbPerOctave, 2)}`,
    );
    assertMastered(loud.audit, `${style} energy 0.9`);
    assert.ok(
      melodyOverChords(loud.audit) >= expect.loudMelodyOverChords,
      `${style} energy 0.9: melody ${fixed(melodyOverChords(loud.audit))} LU over the chords`,
    );
    for (const track of ["chords", "bass"] as const)
      assert.ok(
        !loud.audit.stems[track].empty,
        `${style} energy 0.9: no ${track}`,
      );
    within(
      under(loud.audit, "bass"),
      [expect.bassUnderMix[0] - 1, expect.bassUnderMix[1] + 4],
      `${style} energy 0.9: bass under the mix (LU)`,
    );
    if (style !== "ambient") {
      assert.ok(!loud.audit.stems.drums.empty, `${style} energy 0.9: no drums`);
      // raised energy brings the drums forward, but they never take the mix over
      within(
        under(loud.audit, "drums"),
        [3.5, 15],
        `${style} energy 0.9: drums under the mix (LU)`,
      );
    }

    const instrument = expect.otherLead;
    const { audit, leadPresence } = await measure(style, {
      loop: true,
      duration: VARIANT_SECONDS,
      instrument,
    });
    t.diagnostic(
      `${instrument}: m−c ${fixed(melodyOverChords(audit))}, lead 1–4k ${fixed(leadPresence)}, corr ${fixed(audit.mix.correlation, 2)}, slope ${fixed(audit.mix.spectrum.slopeDbPerOctave, 2)}`,
    );
    assertMastered(audit, `${style} with ${instrument}`);
    assert.equal(audit.score.lead, instrument);
    within(
      melodyOverChords(audit),
      [expect.melodyOverChords[0] - 1, expect.melodyOverChords[1] + 1.5],
      `${style} with ${instrument}: melody over chords (LU)`,
    );
    within(
      audit.mix.spectrum.slopeDbPerOctave,
      [expect.slope[0] - 0.8, expect.slope[1] + 0.8],
      `${style} with ${instrument}: spectral slope`,
    );
  });

  test(`${style}: turned down it is still a whole, audible mix`, async (t) => {
    const { audit, tailOverHead } = await measure(style, {
      loop: true,
      duration: VARIANT_SECONDS,
      energy: 0.15,
    });
    t.diagnostic(
      `energy 0.15: parts ${audit.score.parts.map((part) => part.id).join("+")}, stems ${TRACKS.map((track) => (audit.stems[track].empty ? "–" : fixed(audit.stems[track].lufs))).join("/")}, m−c ${fixed(melodyOverChords(audit))}, slope ${fixed(audit.mix.spectrum.slopeDbPerOctave, 2)}, tail/head ${fixed(tailOverHead)} dB`,
    );
    assertMastered(audit, `${style} energy 0.15`);
    assert.ok(
      !audit.stems.melody.empty && !audit.stems.chords.empty,
      `${style} energy 0.15: melody and chords`,
    );
    within(
      melodyOverChords(audit),
      [expect.melodyOverChords[0] - 1, expect.melodyOverChords[1] + 5],
      `${style} energy 0.15: melody over chords (LU)`,
    );
    if (!audit.stems.bass.empty)
      within(
        under(audit, "bass"),
        [2.5, 11],
        `${style} energy 0.15: bass under the mix (LU)`,
      );
  });
}

test("the six styles: thresholds and voices the mixes were balanced around", () => {
  const config = (
    style: StyleId,
    over: Partial<MusicConfig> = {},
  ): MusicConfig => ({
    ...DEFAULT_CONFIG,
    ...stylePreset(style),
    seed: SEED,
    ...over,
  });
  const ids = (style: StyleId, over: Partial<MusicConfig> = {}) =>
    compose(config(style, over)).parts.map((part) => part.id);
  const playsIn = (
    style: StyleId,
    type: string,
    over: Partial<MusicConfig> = {},
  ) => {
    const score = compose(config(style, over));
    const section = score.sections.find((item) => item.type === type);
    assert.ok(section, `${style}: no ${type}`);
    return score.parts
      .filter((part) =>
        (part.kind === "notes"
          ? part.notes.map((note) => note.t)
          : part.hits
              .filter((hit) => hit.kind !== "cymbalSwell")
              .map((hit) => hit.t)
        ).some(
          (time) => time >= section.start - 0.03 && time < section.end - 0.03,
        ),
      )
      .map((part) => part.id);
  };

  // structurally sound for every lead, looped and not
  for (const style of STYLES)
    for (const instrument of [
      "piano",
      "flute",
      "strings",
      "guzheng",
      "synth",
      "bell",
      "marimba",
      "chip",
    ] as InstrumentId[])
      for (const loop of [true, false]) {
        const cfg = config(style, { instrument, loop, duration: 40 });
        assert.deepEqual(
          scoreProblems(compose(cfg), cfg),
          [],
          `${style} with ${instrument}, loop ${loop}`,
        );
      }

  // low ends that small speakers can reproduce: no bass register reaches below G1 (49 Hz)
  for (const style of STYLES)
    assert.ok(
      getStyle(style).bass!.register[0] >= 31,
      `${style}: bass register ${getStyle(style).bass!.register}`,
    );

  // cinematic: the intro is the piano over the bass, the strings arrive with the verse, the drums with the chorus
  assert.deepEqual(
    playsIn("cinematic", "intro", { loop: false, duration: 60 }).sort(),
    ["bass", "comp"],
  );
  assert.ok(
    playsIn("cinematic", "verse", { loop: false, duration: 60 }).includes(
      "pad",
    ),
  );
  assert.ok(
    !playsIn("cinematic", "verse", { loop: false, duration: 60 }).includes(
      "kit",
    ),
  );
  assert.ok(
    playsIn("cinematic", "chorus", { loop: false, duration: 60 }).includes(
      "kit",
    ),
  );

  // epic: even turned right down the intro is not empty, and the bass pedal carries the verse
  assert.ok(
    playsIn("epic", "intro", {
      loop: false,
      duration: 30,
      energy: 0.15,
    }).includes("pad"),
  );
  assert.ok(
    playsIn("epic", "verse", {
      loop: false,
      duration: 30,
      energy: 0.15,
    }).includes("bass"),
  );

  // tension: the clock ticks at the style's own energy; the ticking comp is plucked whatever the lead
  assert.ok(ids("tension").includes("perc"));
  for (const instrument of [
    "strings",
    "piano",
    "flute",
    "guzheng",
  ] as InstrumentId[]) {
    const comp = compose(config("tension", { instrument })).parts.find(
      (part) => part.id === "comp",
    );
    assert.ok(
      comp && comp.kind === "notes" && comp.voice === "pizzicato",
      `tension comp with ${instrument}`,
    );
  }

  // dreamy: arpeggio and sub from the first bar at any energy; soft chords join for the chorus
  for (const energy of [0.15, 0.28]) {
    const playing = playsIn("dreamy", "verse", {
      loop: false,
      duration: 40,
      energy,
    });
    for (const id of ["lead", "arp", "pad", "bass"])
      assert.ok(playing.includes(id), `dreamy verse at ${energy}: ${id}`);
  }
  assert.ok(
    !playsIn("dreamy", "verse", { loop: false, duration: 40 }).includes("comp"),
  );
  assert.ok(
    playsIn("dreamy", "chorus", { loop: false, duration: 40 }).includes("comp"),
  );

  // ambient: the drone is there at the style's own (very low) energy, and there is never a drum
  for (const loop of [true, false])
    assert.deepEqual(ids("ambient", { loop }).sort(), [
      "bass",
      "comp",
      "lead",
      "pad",
    ]);

  // guofeng: verse of zither, guitar, flute, bass and woodblock; the strings wait for the chorus
  const verse = playsIn("guofeng", "verse", { loop: false, duration: 60 });
  for (const id of ["lead", "comp", "counter", "bass", "kit"])
    assert.ok(verse.includes(id), `guofeng verse: ${id}`);
  assert.ok(!verse.includes("pad"));
  assert.ok(
    playsIn("guofeng", "chorus", { loop: false, duration: 60 }).includes("pad"),
  );
});
