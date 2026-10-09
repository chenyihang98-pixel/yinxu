// Mix review of the pop / acoustic group: bright, acoustic, corporate, cute,
// festive, romantic, sad, focus. Nobody can listen to these mixes, so what the
// review settled on is pinned here as measurements — stem balance at the
// default faders, spectrum, stereo field, loop evenness, form and endings.
// The windows are deliberately wide (about ±1.5 LU around what was measured
// over several seeds): they catch a mix that has drifted, not a changed note.
// The numbers behind a failure:
//   npx tsx scripts/audio-audit.ts --style <id> --both --duration 24 --seed 20263 --solo-parts
//
// Engine finalisation moved two sets of windows without changing a style's
// balance: the crest windows came down 1.5–3 dB and the limiter may now work
// up to a fifth of the time, because the master gained a density stage (a
// drum-bus peak compressor and, per character, a lower limiter ceiling).
import test from "node:test";
import assert from "node:assert/strict";
import { auditConfig } from "../scripts/audio-audit";
import type { Audit } from "../scripts/audio-audit";
import { LoudnessMeter, energyToLufs } from "../src/audio/loudness";
import { REFERENCE_VOLUMES } from "../src/audio/render-types";
import type { InstrumentId, StyleId } from "../src/music/catalog";
import { DEFAULT_CONFIG, stylePreset } from "../src/music/defaults";
import type { MusicConfig } from "../src/types";

const SEED = 20263;
type Window = [low: number, high: number];

interface Target {
  /** melody stem above the chords stem, LU (both at their default faders) */
  melodyOverChords: Window;
  /** bass stem below the mix, LU; null when the style has no bass at its own energy */
  bassBelowMix: Window | null;
  /** drums stem below the mix, LU; null when the style has no drums at its own energy */
  drumsBelowMix: Window | null;
  /** spectral slope of the mix in dB per octave of the octave-band levels (pink 0; add -3 for the FFT-bin convention) */
  slope: Window;
  /** energy above 6 kHz against the whole mix, dB */
  air: Window;
  /** L/R correlation of the mix */
  correlation: Window;
  /** L/R correlation below 150 Hz, at least */
  lowCorrelation: number;
  /** reverb return of the melody against its dry signal, dB */
  melodyWet: Window;
  /** loops: |first 2 s − last 2 s|, LU, at most */
  wrap: number;
  /** seconds of a piece that ends, long enough to contain a chorus */
  songSeconds: number;
  /** chorus above the verse before it, LU */
  chorusLift: Window;
  /** verse above the intro, LU, at most (0 = the piece starts with its verse at this length) */
  introDrop: number;
  /** an unusual lead for the style and how far it sits above the chords, LU */
  otherLead: InstrumentId;
  otherLeadOverChords: Window;
  /** at energy 0.9: melody over chords, and drums below the mix, LU */
  loudMelodyOverChords: Window;
  loudDrumsBelowMix: Window;
}

const TARGETS: Record<string, Target> = {
  // pop band: lead clearly on top, bass and kit carrying the groove
  bright: {
    melodyOverChords: [1.5, 4.5],
    bassBelowMix: [5, 8.5],
    drumsBelowMix: [4, 7.5],
    slope: [-3, -0.5],
    air: [-23, -14],
    correlation: [0.8, 0.96],
    lowCorrelation: 0.95,
    melodyWet: [-20, -12],
    wrap: 2.6,
    songSeconds: 30,
    chorusLift: [0.6, 3],
    introDrop: 6,
    otherLead: "marimba",
    otherLeadOverChords: [1.3, 4.8],
    loudMelodyOverChords: [1.3, 4.5],
    loudDrumsBelowMix: [4, 8],
  },
  // two guitars in a room: natural bass, a light kit only in the chorus
  acoustic: {
    melodyOverChords: [2, 5.5],
    bassBelowMix: [5, 9],
    drumsBelowMix: [8.5, 16],
    slope: [-3.4, -0.8],
    air: [-30, -19],
    correlation: [0.75, 0.95],
    lowCorrelation: 0.9,
    melodyWet: [-17, -10],
    wrap: 3,
    songSeconds: 30,
    chorusLift: [0.2, 3],
    introDrop: 0,
    otherLead: "dizi",
    otherLeadOverChords: [2, 6],
    loudMelodyOverChords: [0.5, 4],
    loudDrumsBelowMix: [6, 11],
  },
  corporate: {
    melodyOverChords: [1.5, 4.8],
    bassBelowMix: [5, 8.5],
    drumsBelowMix: [3.8, 7.5],
    slope: [-3.2, -0.6],
    air: [-26, -14],
    correlation: [0.78, 0.96],
    lowCorrelation: 0.95,
    melodyWet: [-19, -11],
    wrap: 3,
    songSeconds: 30,
    chorusLift: [0.6, 3],
    introDrop: 7.5,
    otherLead: "flute",
    otherLeadOverChords: [2, 5.5],
    loudMelodyOverChords: [1, 4.2],
    loudDrumsBelowMix: [4, 8],
  },
  // staccato mallets and plucked strings: dry, feather-light kit
  cute: {
    melodyOverChords: [2, 5.8],
    bassBelowMix: [5, 9],
    drumsBelowMix: [6, 11],
    slope: [-3.2, -0.6],
    air: [-24, -13],
    correlation: [0.82, 0.97],
    lowCorrelation: 0.95,
    melodyWet: [-23, -14],
    wrap: 2.6,
    songSeconds: 30,
    chorusLift: [0.5, 3],
    introDrop: 0,
    otherLead: "pluck",
    otherLeadOverChords: [2, 6],
    loudMelodyOverChords: [1.5, 6],
    loudDrumsBelowMix: [4.5, 9],
  },
  // bells are bright by nature: the brightest of the group
  festive: {
    melodyOverChords: [1.8, 5],
    bassBelowMix: [5, 9],
    drumsBelowMix: [4, 8],
    slope: [-2.6, 0.2],
    air: [-21, -12],
    correlation: [0.8, 0.97],
    lowCorrelation: 0.95,
    melodyWet: [-17, -9],
    wrap: 3.2,
    songSeconds: 30,
    chorusLift: [0.4, 3],
    introDrop: 5.5,
    otherLead: "guzheng",
    otherLeadOverChords: [2.2, 6],
    loudMelodyOverChords: [1.5, 4.8],
    loudDrumsBelowMix: [4, 8],
  },
  // piano and strings in a hall: wide, soft bass from the chorus, no drums
  romantic: {
    melodyOverChords: [1.8, 5.5],
    bassBelowMix: [6.5, 11],
    drumsBelowMix: null,
    slope: [-4.2, -1],
    air: [-47, -32],
    correlation: [0.55, 0.92],
    lowCorrelation: 0.85,
    melodyWet: [-12, -5],
    wrap: 5,
    songSeconds: 60,
    chorusLift: [0.5, 3.2],
    introDrop: 7.5,
    otherLead: "strings",
    otherLeadOverChords: [2.5, 6.5],
    loudMelodyOverChords: [1.3, 5],
    loudDrumsBelowMix: [8, 15],
  },
  // one pianist and a string pad: no bass, no drums, the wettest and widest
  sad: {
    melodyOverChords: [1.5, 5.5],
    bassBelowMix: null,
    drumsBelowMix: null,
    slope: [-3.6, -0.3],
    air: [-49, -34],
    correlation: [0.5, 0.9],
    lowCorrelation: 0.75,
    melodyWet: [-10, -4],
    wrap: 6,
    songSeconds: 60,
    chorusLift: [0.3, 3],
    introDrop: 0,
    otherLead: "flute",
    otherLeadOverChords: [2.5, 6.5],
    loudMelodyOverChords: [0.6, 5],
    loudDrumsBelowMix: [9, 16],
  },
  // piano over a quiet pulse: sub bass well under the tune, a shaker and nothing else
  focus: {
    melodyOverChords: [1.5, 5.5],
    bassBelowMix: [6.5, 11.5],
    drumsBelowMix: [15, 25],
    slope: [-4.8, -1.5],
    air: [-42, -28],
    correlation: [0.75, 0.97],
    lowCorrelation: 0.9,
    melodyWet: [-16, -8],
    wrap: 4.2,
    songSeconds: 60,
    chorusLift: [0.5, 3.5],
    introDrop: 8,
    otherLead: "vibes",
    otherLeadOverChords: [2, 6.5],
    loudMelodyOverChords: [1.3, 5.5],
    loudDrumsBelowMix: [7, 14],
  },
};

interface Measured {
  audit: Audit;
  /** K-weighted level of the first and the last two seconds of the mix, LUFS */
  head: number;
  tail: number;
  /** melody against chords while the melody sounds, LU */
  melodyOverChordsActive: number;
}

function hopLevel(hops: Float64Array, from: number, to: number): number {
  let sum = 0;
  for (let i = from; i < to; i++) sum += hops[i];
  return energyToLufs(sum / Math.max(1, to - from));
}

async function measure(
  style: StyleId,
  overrides: Partial<MusicConfig>,
): Promise<Measured> {
  let head = NaN;
  let tail = NaN;
  let melodyOverChordsActive = NaN;
  const audit = await auditConfig(
    { ...DEFAULT_CONFIG, ...stylePreset(style), seed: SEED, ...overrides },
    {
      onAudio: ({ mix, stems, sampleRate }) => {
        const meter = new LoudnessMeter(sampleRate);
        meter.push(mix[0], mix[1]);
        const hops = meter.hopEnergies;
        head = hopLevel(hops, 0, Math.min(20, hops.length));
        tail = hopLevel(hops, Math.max(0, hops.length - 20), hops.length);
        const melody = new LoudnessMeter(sampleRate);
        melody.push(stems.melody[0], stems.melody[1]);
        const chords = new LoudnessMeter(sampleRate);
        chords.push(stems.chords[0], stems.chords[1]);
        const m = melody.hopEnergies;
        const c = chords.hopEnergies;
        const gainM = REFERENCE_VOLUMES.melody ** 2;
        const gainC = REFERENCE_VOLUMES.chords ** 2;
        let sumM = 0;
        let sumC = 0;
        // 400 ms blocks in which the melody can be heard
        for (let i = 0; i + 4 <= m.length; i++) {
          let blockM = 0;
          let blockC = 0;
          for (let k = 0; k < 4; k++) {
            blockM += m[i + k] * gainM;
            blockC += c[i + k] * gainC;
          }
          if (energyToLufs(blockM / 4) > -40) {
            sumM += blockM;
            sumC += blockC;
          }
        }
        melodyOverChordsActive =
          sumC > 0 ? 10 * Math.log10(sumM / sumC) : Infinity;
      },
    },
  );
  return { audit, head, tail, melodyOverChordsActive };
}

const fx = (value: number, digits = 1) =>
  Number.isFinite(value) ? value.toFixed(digits) : String(value);
const below = (audit: Audit, track: "bass" | "drums") =>
  audit.mix.lufs - audit.stems[track].lufs;
const melodyOverChords = (audit: Audit) =>
  audit.stems.melody.lufs - audit.stems.chords.lufs;

/** Power of the melody stem between 500 Hz and 6 kHz against the other three stems together, dB. */
function melodyPresence(audit: Audit): number {
  const band = (track: "melody" | "chords" | "bass" | "drums") => {
    const spectrum = audit.stems[track].spectrum;
    return spectrum
      ? 10 ** (spectrum.bands.mid / 10) + 10 ** (spectrum.bands.presence / 10)
      : 0;
  };
  const others = band("chords") + band("bass") + band("drums");
  return others > 0 ? 10 * Math.log10(band("melody") / others) : Infinity;
}

function summary({ audit, head, tail }: Measured): string {
  const stem = (track: "melody" | "chords" | "bass" | "drums") =>
    audit.stems[track].empty ? "–" : fx(audit.stems[track].lufs);
  const master = audit.render.master;
  return [
    `${audit.score.loop ? "loop" : "song"} ${audit.score.bars} bars, lead ${audit.score.lead}`,
    `${fx(audit.mix.lufs, 2)} LUFS`,
    `stems ${stem("melody")} / ${stem("chords")} / ${stem("bass")} / ${stem("drums")}`,
    `slope ${fx(audit.mix.spectrum.slopeDbPerOctave)}`,
    `air ${fx(audit.mix.spectrum.bands.air)}`,
    `corr ${fx(audit.mix.correlation, 2)} (${fx(audit.mix.correlationLow, 2)} low)`,
    `crest ${fx(audit.mix.crestDb)}`,
    `limiter ${fx(master.limiter.activeRatio * 100, 0)} % / ${fx(master.limiter.maxReductionDb)} dB`,
    audit.score.loop
      ? `first / last 2 s ${fx(head)} / ${fx(tail)}`
      : audit.sections
          .map((section) => `${section.type} ${fx(section.lufs)}`)
          .join(", "),
  ].join("; ");
}

for (const [id, target] of Object.entries(TARGETS)) {
  const style = id as StyleId;
  test(`mix: ${style} is balanced, in tune with its genre and finished`, async (t) => {
    const problems: string[] = [];
    const within = (label: string, value: number, [low, high]: Window) => {
      if (!(value >= low && value <= high))
        problems.push(`${label}: ${fx(value, 2)} is outside ${low} … ${high}`);
    };
    const atMost = (label: string, value: number, limit: number) => {
      if (!(value <= limit))
        problems.push(`${label}: ${fx(value, 2)} is above ${limit}`);
    };
    const atLeast = (label: string, value: number, limit: number) => {
      if (!(value >= limit))
        problems.push(`${label}: ${fx(value, 2)} is below ${limit}`);
    };
    /** What every render of the group must satisfy, whatever its settings. */
    const always = (name: string, { audit }: Measured) => {
      const master = audit.render.master;
      within(`${name} loudness`, audit.mix.lufs, [-16.3, -15.7]);
      atMost(`${name} loudness shortfall`, master.shortfallLu, 0);
      atMost(
        `${name} share of samples past the clipper knee (%)`,
        audit.mix.kneeShare * 100,
        0.5,
      );
      // (a denser master lowers the limiter's ceiling until it works up to a fifth of the time: DENSE_BUSY_RATIO in master.ts)
      atMost(
        `${name} limiter activity (%)`,
        master.limiter.activeRatio * 100,
        22,
      );
      atMost(`${name} limiter depth (dB)`, master.limiter.maxReductionDb, 7);
      atMost(
        `${name} mean glue compression (dB)`,
        master.compressor.meanReductionDb,
        2,
      );
      // the tune reaches the listener: no other stem outweighs it between 500 Hz and 6 kHz by more than the dullest lead allows
      atLeast(
        `${name} melody against the rest between 500 Hz and 6 kHz (dB)`,
        melodyPresence(audit),
        -6,
      );
      if (audit.flags.length)
        problems.push(`${name}: ${audit.flags.join("; ")}`);
    };

    /* ---- the loop at the style's own settings ---- */
    const loop = await measure(style, { loop: true, duration: 24 });
    t.diagnostic(summary(loop));
    always("loop", loop);
    within(
      "loop melody over chords (LU)",
      melodyOverChords(loop.audit),
      target.melodyOverChords,
    );
    atLeast(
      "loop melody over chords while the melody sounds (LU)",
      loop.melodyOverChordsActive,
      target.melodyOverChords[0] - 0.7,
    );
    atLeast(
      "loop melody against the rest between 500 Hz and 6 kHz (dB)",
      melodyPresence(loop.audit),
      0,
    );
    if (target.bassBelowMix)
      within(
        "loop bass below the mix (LU)",
        below(loop.audit, "bass"),
        target.bassBelowMix,
      );
    else
      assert.ok(
        loop.audit.stems.bass.empty,
        "no bass at the style's own energy",
      );
    if (target.drumsBelowMix) {
      within(
        "loop drums below the mix (LU)",
        below(loop.audit, "drums"),
        target.drumsBelowMix,
      );
      // even a lone shaker is there to be heard
      atLeast(
        "loop loudest 400 ms of the drums (LUFS)",
        loop.audit.stems.drums.momentaryMax,
        -38,
      );
    } else
      assert.ok(
        loop.audit.stems.drums.empty,
        "no drums at the style's own energy",
      );
    within(
      "loop spectral slope (dB/octave)",
      loop.audit.mix.spectrum.slopeDbPerOctave,
      target.slope,
    );
    within(
      "loop air above 6 kHz (dB)",
      loop.audit.mix.spectrum.bands.air,
      target.air,
    );
    // no mud, no boom: the low mids stay under the mids, the sub under the bass band
    atMost(
      "loop low mids against mids (dB)",
      loop.audit.mix.spectrum.bands.lowMid - loop.audit.mix.spectrum.bands.mid,
      1,
    );
    atMost(
      "loop sub against bass band (dB)",
      loop.audit.mix.spectrum.bands.sub - loop.audit.mix.spectrum.bands.bass,
      -4,
    );
    within(
      "loop stereo correlation",
      loop.audit.mix.correlation,
      target.correlation,
    );
    atLeast(
      "loop correlation below 150 Hz",
      loop.audit.mix.correlationLow,
      target.lowCorrelation,
    );
    within(
      "loop melody reverb against dry (dB)",
      loop.audit.stems.melody.reverbDb,
      target.melodyWet,
    );
    within("loop crest factor (dB)", loop.audit.mix.crestDb, [11, 17.5]);
    assert.ok(loop.audit.seam, "a loop has a seam");
    atMost(
      "loop seam step against the usual sample step",
      loop.audit.seam.jumpRatio,
      1.5,
    );
    atLeast(
      "loop level of the last 30 ms against the last 300 ms (dB)",
      loop.audit.seam.endDipDb,
      -18,
    );
    atMost(
      "loop first 2 s against last 2 s (LU)",
      Math.abs(loop.head - loop.tail),
      target.wrap,
    );

    /* ---- a piece that ends ---- */
    const song = await measure(style, {
      loop: false,
      duration: target.songSeconds,
    });
    t.diagnostic(summary(song));
    always("song", song);
    within("song melody over chords (LU)", melodyOverChords(song.audit), [
      target.melodyOverChords[0] - 0.7,
      target.melodyOverChords[1] + 0.5,
    ]);
    within(
      "song spectral slope (dB/octave)",
      song.audit.mix.spectrum.slopeDbPerOctave,
      [target.slope[0] - 0.4, target.slope[1] + 0.6],
    );
    const sections = song.audit.sections;
    const chorusAt = sections.findIndex((section) => section.type === "chorus");
    assert.ok(
      chorusAt > 0,
      `${target.songSeconds} s of ${style} contain a chorus: ${sections.map((section) => section.type).join(" ")}`,
    );
    const verse = sections
      .slice(0, chorusAt)
      .reverse()
      .find((section) => section.type === "verse");
    assert.ok(verse, "a verse before the chorus");
    within(
      "song chorus above the verse (LU)",
      sections[chorusAt].lufs - verse.lufs,
      target.chorusLift,
    );
    const intro = sections[0].type === "intro" ? sections[0] : undefined;
    if (target.introDrop > 0) {
      assert.ok(intro, "the piece opens with an intro");
      within("song verse above the intro (LU)", verse.lufs - intro.lufs, [
        0.5,
        target.introDrop,
      ]);
    }
    // the ending: quieter than the body, decayed to silence by itself, and not much dead air after it
    const outro = sections[sections.length - 1];
    assert.equal(outro.type, "outro");
    atMost(
      "song outro against the chorus (LU)",
      outro.lufs - sections[chorusAt].lufs,
      -0.5,
    );
    assert.ok(song.audit.edges, "a piece that ends has edges");
    atMost("song first sample", song.audit.edges.firstSample, 0.001);
    atMost("song last 50 ms (dBFS)", song.audit.edges.endDb, -90);
    within(
      "song silence after the last audible sample (s)",
      song.audit.edges.silentTail,
      [0.2, 2.4],
    );

    /* ---- an unusual lead keeps its place ---- */
    const other = await measure(style, {
      loop: true,
      duration: 20,
      instrument: target.otherLead,
    });
    t.diagnostic(summary(other));
    always(`${target.otherLead} lead`, other);
    within(
      `${target.otherLead} lead over chords (LU)`,
      melodyOverChords(other.audit),
      target.otherLeadOverChords,
    );
    within(
      `${target.otherLead} lead: spectral slope (dB/octave)`,
      other.audit.mix.spectrum.slopeDbPerOctave,
      [target.slope[0] - 1, target.slope[1] + 1.6],
    );

    /* ---- turned up: every layer in, the tune still on top, the kit present but not in charge ---- */
    const loud = await measure(style, {
      loop: true,
      duration: 20,
      energy: 0.9,
    });
    t.diagnostic(summary(loud));
    always("energy 0.9", loud);
    assert.ok(
      loud.audit.score.parts.length >= loop.audit.score.parts.length,
      "energy never takes a layer away",
    );
    assert.ok(
      !loud.audit.stems.drums.empty && !loud.audit.stems.bass.empty,
      "at energy 0.9 every style has bass and drums",
    );
    within(
      "energy 0.9 melody over chords (LU)",
      melodyOverChords(loud.audit),
      target.loudMelodyOverChords,
    );
    within(
      "energy 0.9 drums below the mix (LU)",
      below(loud.audit, "drums"),
      target.loudDrumsBelowMix,
    );
    within(
      "energy 0.9 bass below the mix (LU)",
      below(loud.audit, "bass"),
      [4.5, 12.5],
    );
    atLeast(
      "energy 0.9 correlation below 150 Hz",
      loud.audit.mix.correlationLow,
      0.93,
    );
    // more energy is a brighter, fuller mix — not just a louder one (the master holds the loudness)
    atLeast(
      "energy 0.9 air against the style's own energy (dB)",
      loud.audit.mix.spectrum.bands.air - loop.audit.mix.spectrum.bands.air,
      -1.5,
    );

    assert.deepEqual(problems, [], `${style}:\n  ${problems.join("\n  ")}`);
  });
}

test("mix: the group keeps its family resemblances", async () => {
  // measured on the same loops as above, so nothing is rendered that the style tests did not already time
  const lufs: Record<string, Audit> = {};
  for (const style of ["bright", "sad", "festive", "focus"] as StyleId[])
    lufs[style] = (await measure(style, { loop: true, duration: 20 })).audit;
  // the ballad is the darkest and wettest, the bells the brightest
  assert.ok(
    lufs.festive.mix.spectrum.bands.air >
      lufs.bright.mix.spectrum.bands.air - 1,
    "festive is at least as airy as bright",
  );
  assert.ok(
    lufs.bright.mix.spectrum.bands.air > lufs.focus.mix.spectrum.bands.air + 6,
    "focus is darker than bright",
  );
  assert.ok(
    lufs.focus.mix.spectrum.bands.air > lufs.sad.mix.spectrum.bands.air,
    "sad is the darkest",
  );
  assert.ok(
    lufs.sad.stems.melody.reverbDb > lufs.bright.stems.melody.reverbDb + 5,
    "sad is far wetter than bright",
  );
  assert.ok(
    lufs.sad.mix.correlation < lufs.bright.mix.correlation - 0.08,
    "sad is wider than bright",
  );
});
