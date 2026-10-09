import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PART_MIX, TRACKS, VOICE_IDS } from "../src/music/score";
import type {
  DrumEvent,
  MasterCharacter,
  MasterSettings,
  NoteEvent,
  Part,
  PartMix,
  Score,
  TrackName,
  VoiceId,
} from "../src/music/score";
import type { DrumVoice, Voice, VoiceBank } from "../src/audio/voices/types";
import { REFERENCE_VOLUMES } from "../src/audio/render-types";
import type { RenderedAudio, StereoPcm } from "../src/audio/render-types";
import {
  SEND_FLOOR,
  delayReturnGain,
  partRandom,
  renderScore,
  renderScoreWith,
  reverbReturnGain,
} from "../src/audio/render";
import type { RenderReport } from "../src/audio/render";
import {
  LIMITER_CEILING,
  MIN_STEM_CORRELATION,
  masterStems,
  measureMix,
} from "../src/audio/master";
import type { Stems } from "../src/audio/master";
import { integratedLoudness } from "../src/audio/loudness";
import { CEILING, KNEE, softClip } from "../src/audio/softclip";
import { Biquad, createRng, powerSpectrum } from "../src/audio/dsp";

const SR = 48000;

/* ---------- tiny deterministic test instruments ---------- */

/** Sine + octave with a 4 ms attack and a raised-cosine release; pans a little per note from the part's random stream. */
function toneVoice(id: VoiceId, tail = 0.3): Voice {
  return {
    id,
    tail: () => tail,
    render(left, right, frames, note, ctx) {
      const hz = 440 * Math.pow(2, (note.midi - 69) / 12);
      const amp = 0.17 * Math.pow(note.vel / 0.8, 1.5);
      const hold = Math.max(
        1,
        Math.min(frames - 2, Math.round(note.duration * ctx.sampleRate)),
      );
      const attack = Math.max(1, Math.round(0.004 * ctx.sampleRate));
      const pan = (ctx.random() - 0.5) * 0.4;
      for (let i = 0; i < frames; i++) {
        const env =
          i < attack
            ? i / attack
            : i < hold
              ? 1
              : 0.5 +
                0.5 * Math.cos((Math.PI * (i - hold)) / (frames - 1 - hold));
        const phase = (2 * Math.PI * hz * i) / ctx.sampleRate;
        const value =
          amp *
          Math.min(env, 1) *
          (Math.sin(phase) + 0.3 * Math.sin(2 * phase));
        left[i] += value * (1 - pan);
        right[i] += value * (1 + pan);
      }
    },
  };
}

const TEST_VOICES = Object.fromEntries(
  VOICE_IDS.map((id) => [id, toneVoice(id)]),
) as VoiceBank;

/** Kick = falling sine, everything else = a noise burst drawn from the part's random stream. */
const TEST_DRUMS: DrumVoice = {
  length: (kind) => (kind === "kick" ? 0.3 : kind === "crash" ? 0.6 : 0.12),
  render(left, right, frames, kind, _kit, vel, ctx) {
    const sr = ctx.sampleRate;
    if (kind === "kick") {
      let phase = 0;
      for (let i = 0; i < frames; i++) {
        const t = i / sr;
        phase += (2 * Math.PI * (48 + 110 * Math.exp(-t / 0.03))) / sr;
        const env =
          Math.min(1, i / 24) * Math.exp(-t / 0.07) * (1 - i / frames);
        const value = 0.8 * vel * env * Math.sin(phase);
        left[i] += value;
        right[i] += value;
      }
      return;
    }
    let previous = 0;
    for (let i = 0; i < frames; i++) {
      const white = ctx.random() * 2 - 1;
      const bright = white - previous;
      previous = white;
      const env =
        Math.min(1, i / 12) * Math.exp(-i / (frames / 5)) * (1 - i / frames);
      left[i] += 0.3 * vel * env * bright;
      right[i] += 0.3 * vel * env * bright;
    }
  },
};

const BANKS = { voices: TEST_VOICES, drums: TEST_DRUMS };

/* ---------- score building ---------- */

const mix = (extra: Partial<PartMix> = {}): PartMix => ({
  ...DEFAULT_PART_MIX,
  ...extra,
});

function notePart(
  id: string,
  track: TrackName,
  notes: NoteEvent[],
  partMix: Partial<PartMix> = {},
  voice: VoiceId = "piano",
): Part {
  return {
    kind: "notes",
    id,
    track,
    role: "lead",
    voice,
    mix: mix(partMix),
    notes,
  };
}

function drumPart(
  id: string,
  hits: DrumEvent[],
  partMix: Partial<PartMix> = {},
): Part {
  return {
    kind: "drums",
    id,
    track: "drums",
    role: "kit",
    kit: "pop",
    mix: mix(partMix),
    hits,
  };
}

function makeScore(parts: Part[], overrides: Partial<Score> = {}): Score {
  const bpm = overrides.bpm ?? 120;
  const duration = overrides.duration ?? 4;
  return {
    version: 2,
    style: "bright",
    lead: "piano",
    seed: 4242,
    sampleRate: SR,
    bpm,
    beatsPerBar: 4,
    bars: Math.round(duration / (240 / bpm)),
    duration,
    loop: true,
    key: {
      tonic: 0,
      minor: false,
      label: "C 大调",
      scale: [0, 2, 4, 5, 7, 9, 11],
    },
    swing: 0,
    sections: [],
    chords: [],
    parts,
    space: {
      size: 0.45,
      decay: 1.2,
      damping: 0.5,
      preDelay: 0.012,
      level: 0.5,
      delayTime: 0.375,
      delayFeedback: 0.3,
    },
    master: { targetLufs: -16, ceilingDb: -1, character: "clean", tilt: 0 },
    notes: [],
    ...overrides,
  };
}

/** A small but complete arrangement: every track, sends, chorus, filters, drive, ducking. */
function bandScore(seconds: number, overrides: Partial<Score> = {}): Score {
  const loop = overrides.loop ?? true;
  const beat = 0.5;
  const bars = Math.round(seconds / 2);
  const end = loop ? bars : Math.max(1, bars - 1);
  const lead: NoteEvent[] = [];
  const chords: NoteEvent[] = [];
  const bass: NoteEvent[] = [];
  const hits: DrumEvent[] = [];
  const roots = [57, 53, 48, 55];
  for (let bar = 0; bar < end; bar++) {
    const t0 = bar * 2;
    const root = roots[bar % 4];
    for (let e = 0; e < 8; e++) {
      lead.push({
        t: t0 + e * 0.25,
        d: 0.22,
        midi: root + 12 + [0, 4, 7, 12, 7, 4, 2, 0][e],
        vel: 0.6 + 0.05 * (e % 4),
      });
      bass.push({
        t: t0 + e * 0.25,
        d: 0.2,
        midi: root - 24,
        vel: e % 2 ? 0.6 : 0.85,
      });
    }
    for (const offset of [0, 4, 7, 11])
      chords.push({ t: t0, d: 1.95, midi: root + offset, vel: 0.6 });
    for (let q = 0; q < 4; q++) {
      hits.push({ t: t0 + q * beat, kind: "kick", vel: 0.9 });
      if (q % 2) hits.push({ t: t0 + q * beat, kind: "snare", vel: 0.8 });
      hits.push({ t: t0 + q * beat + 0.25, kind: "hatClosed", vel: 0.5 });
    }
  }
  return makeScore(
    [
      notePart("lead", "melody", lead, {
        gain: 0.8,
        pan: 0.1,
        reverb: 0.3,
        delay: 0.2,
      }),
      notePart(
        "pad",
        "chords",
        chords,
        {
          gain: 0.5,
          width: 1.3,
          reverb: 0.4,
          chorus: 0.4,
          lowCut: 150,
          duck: 0.5,
        },
        "pad",
      ),
      notePart(
        "bass",
        "bass",
        bass,
        {
          gain: 0.8,
          width: 0,
          reverb: 0,
          highCut: 2500,
          drive: 0.15,
          duck: 0.3,
        },
        "subBass",
      ),
      drumPart("kit", hits, { gain: 0.8, reverb: 0.15, drive: 0.1 }),
    ],
    { duration: seconds, ...overrides },
  );
}

/* ---------- measuring ---------- */

function mixDown(audio: RenderedAudio, volumes = REFERENCE_VOLUMES): StereoPcm {
  const left = new Float32Array(audio.frames);
  const right = new Float32Array(audio.frames);
  for (const track of TRACKS) {
    const [l, r] = audio.stems[track];
    for (let i = 0; i < audio.frames; i++) {
      left[i] += l[i] * volumes[track];
      right[i] += r[i] * volumes[track];
    }
  }
  return [left, right];
}

function energy(data: Float32Array, from = 0, to = data.length): number {
  let sum = 0;
  for (let i = Math.max(0, from); i < Math.min(to, data.length); i++)
    sum += data[i] * data[i];
  return sum;
}
const rms = (data: Float32Array, from = 0, to = data.length) =>
  Math.sqrt(energy(data, from, to) / Math.max(1, to - from));
const db = (ratio: number) => 20 * Math.log10(Math.max(ratio, 1e-12));
const peakOf = (data: Float32Array) =>
  data.reduce((max, v) => Math.max(max, Math.abs(v)), 0);
const isSilent = (stem: StereoPcm) =>
  stem[0].every((v) => v === 0) && stem[1].every((v) => v === 0);
const allFinite = (stem: StereoPcm) =>
  stem[0].every(Number.isFinite) && stem[1].every(Number.isFinite);

function correlation(a: Float32Array, b: Float32Array): number {
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i++) {
    ab += a[i] * b[i];
    aa += a[i] * a[i];
    bb += b[i] * b[i];
  }
  return ab / Math.sqrt(aa * bb + 1e-30);
}

/**
 * How a loop's last frame leads into its first, relative to the waveform
 * around it: `jump` is the step across the seam and `bend` its second
 * difference, each divided by the largest such value in the 10 ms on either
 * side. Around 1 or below means the seam looks like any other sample.
 */
function seam(data: Float32Array, sampleRate = SR, levelWindow = 0.05) {
  const n = data.length;
  const span = Math.round(sampleRate * 0.01);
  const level = Math.round(sampleRate * levelWindow);
  const at = (i: number) => data[((i % n) + n) % n];
  let step = 1e-9;
  let bend = 1e-9;
  for (let i = -span; i < span; i++) {
    if (i === -1) continue;
    step = Math.max(step, Math.abs(at(i + 1) - at(i)));
  }
  for (let i = -span; i < span; i++) {
    if (i === -2 || i === -1) continue;
    bend = Math.max(bend, Math.abs(at(i + 2) - 2 * at(i + 1) + at(i)));
  }
  return {
    jump: Math.abs(at(0) - at(-1)) / step,
    bend:
      Math.max(
        Math.abs(at(0) - 2 * at(-1) + at(-2)),
        Math.abs(at(1) - 2 * at(0) + at(-1)),
      ) / bend,
    levelDb: db(rms(data, 0, level) / Math.max(rms(data, n - level, n), 1e-12)),
  };
}

async function render(
  score: Score,
  options: Parameters<typeof renderScoreWith>[2] = {},
) {
  let report: RenderReport | undefined;
  const audio = await renderScoreWith(score, BANKS, {
    ...options,
    onReport: (value) => (report = value),
  });
  assert.ok(report, "onReport is called");
  return { audio, report };
}

/* ---------- renderer ---------- */

test("render: frame count, sample rate and finite stems for loop and one-shot pieces", async () => {
  for (const [duration, sampleRate, loop] of [
    [4, 48000, true],
    [3.21, 48000, false],
    [2.5, 44100, true],
    [1.3333, 32000, false],
  ] as const) {
    const { audio } = await render(
      bandScore(4, { duration, sampleRate, loop }),
    );
    assert.equal(audio.sampleRate, sampleRate);
    assert.equal(audio.frames, Math.round(duration * sampleRate));
    for (const track of TRACKS) {
      const stem = audio.stems[track];
      assert.equal(stem[0].length, audio.frames);
      assert.equal(stem[1].length, audio.frames);
      assert.ok(allFinite(stem), `${track} is finite`);
      assert.ok(rms(stem[0]) > 1e-4, `${track} has audio`);
    }
  }
});

test("render: deterministic, and independent of pacing and checkpoints", async () => {
  const score = bandScore(4);
  const first = await render(score);
  const second = await render(score);
  let checkpoints = 0;
  const paced = await render(score, {
    paceMs: 0,
    checkpoint: async () => {
      checkpoints++;
      await new Promise((resolve) => setImmediate(resolve));
    },
  });
  assert.ok(checkpoints > 20, `checkpoint awaited ${checkpoints} times`);
  for (const track of TRACKS)
    for (const channel of [0, 1] as const) {
      assert.deepEqual(
        second.audio.stems[track][channel],
        first.audio.stems[track][channel],
      );
      assert.deepEqual(
        paced.audio.stems[track][channel],
        first.audio.stems[track][channel],
      );
    }
  // another seed moves the random streams of the parts, so the audio changes
  const other = await render({ ...score, seed: score.seed + 1 });
  assert.notDeepEqual(other.audio.stems.drums[0], first.audio.stems.drums[0]);

  // a part's random stream depends on the seed and its id only
  const a = partRandom(7, "lead");
  const b = partRandom(7, "lead");
  const c = partRandom(7, "pad");
  const d = partRandom(8, "lead");
  const draws = Array.from({ length: 8 }, () => a());
  assert.deepEqual(
    draws,
    Array.from({ length: 8 }, () => b()),
  );
  assert.notDeepEqual(
    draws,
    Array.from({ length: 8 }, () => c()),
  );
  assert.notDeepEqual(
    draws,
    Array.from({ length: 8 }, () => d()),
  );
});

test("render: notes land on round(t · sampleRate), and loop tails wrap around the end", async () => {
  // a voice that writes a single click at its first frame and another at its last
  const click: Voice = {
    id: "piano",
    tail: () => 0.5,
    render(left, right, frames) {
      left[0] += 0.5;
      right[0] += 0.5;
      left[frames - 1] -= 0.25;
      right[frames - 1] -= 0.25;
    },
  };
  const voices = { ...TEST_VOICES, piano: click };
  const dry = { reverb: 0, delay: 0, gain: 1 };
  const frames = 2 * SR;
  const loopScore = makeScore(
    [
      notePart(
        "clicks",
        "melody",
        [
          { t: 0.31234, d: 0.25, midi: 60, vel: 1 },
          { t: 1.8, d: 0.25, midi: 60, vel: 1 },
        ],
        dry,
      ),
    ],
    { duration: 2 },
  );
  const looped = await renderScoreWith(loopScore, {
    voices,
    drums: TEST_DRUMS,
  });
  const data = looped.stems.melody[0];
  const top = (from: number, to: number, sign: number) => {
    let best = from;
    for (let i = from; i < to; i++)
      if (data[i] * sign > data[best] * sign) best = i;
    return best;
  };
  const count = Math.ceil(0.75 * SR);
  // onsets
  assert.equal(top(0.2 * SR, 0.5 * SR, 1), Math.round(0.31234 * SR));
  assert.equal(top(1.7 * SR, frames, 1), Math.round(1.8 * SR));
  // tail end of the first note, and of the second one after wrapping
  assert.equal(
    top(0.9 * SR, 1.2 * SR, -1),
    Math.round(0.31234 * SR) + count - 1,
  );
  assert.equal(
    top(0.5 * SR, 0.7 * SR, -1),
    (Math.round(1.8 * SR) + count - 1) % frames,
  );

  // an oversampled drive delays the part by 12 frames internally; the mixer puts it back
  for (const loop of [true, false]) {
    const driven = await renderScoreWith(
      {
        ...loopScore,
        loop,
        parts: [
          notePart(
            "clicks",
            "melody",
            [{ t: 0.31234, d: 0.25, midi: 60, vel: 1 }],
            { ...dry, drive: 0.8 },
          ),
        ],
      },
      { voices, drums: TEST_DRUMS },
    );
    const stem = driven.stems.melody[0];
    let best = 0;
    for (let i = 0; i < 0.6 * SR; i++) if (stem[i] > stem[best]) best = i;
    assert.equal(
      best,
      Math.round(0.31234 * SR),
      `driven part stays in time (loop ${loop})`,
    );
  }

  // one-shot: the late note is cut at the end instead (nothing wraps to the start)
  const shot = await renderScoreWith(
    { ...loopScore, loop: false },
    { voices, drums: TEST_DRUMS },
  );
  assert.ok(peakOf(shot.stems.melody[0].subarray(0.5 * SR, 0.7 * SR)) < 1e-6);
  // events outside the piece and malformed events are skipped, not fatal
  const odd = makeScore(
    [
      notePart("odd", "melody", [
        { t: 5, d: 0.2, midi: 60, vel: 0.8 },
        { t: 0.5, d: 0, midi: 60, vel: 0.8 },
        { t: 0.5, d: 0.2, midi: 60, vel: 0 },
        { t: NaN, d: 0.2, midi: 60, vel: 0.8 },
        { t: -0.1, d: 0.2, midi: 60, vel: 0.8 },
      ]),
    ],
    { duration: 2, loop: false },
  );
  const { audio, report } = await render(odd);
  assert.equal(
    report.notes,
    1,
    "only the note that reaches into the piece is rendered",
  );
  assert.ok(allFinite(audio.stems.melody));
});

test("render: a loop is seamless — tails, reverb and delay continue across the end", async () => {
  // nothing starts on the downbeat; the last notes are held across the end,
  // so the level on both sides of the seam is the same when nothing is lost
  const notes: NoteEvent[] = [
    { t: 0.9, d: 0.4, midi: 64, vel: 0.8 },
    { t: 1.5, d: 0.4, midi: 67, vel: 0.8 },
    { t: 2.75, d: 0.5, midi: 72, vel: 0.9 },
    { t: 3.5, d: 1.1, midi: 60, vel: 0.9 },
  ];
  const pad: NoteEvent[] = [48, 55, 64].map((midi) => ({
    t: 2.2,
    d: 2.5,
    midi,
    vel: 0.7,
  }));
  const score = makeScore(
    [
      notePart("lead", "melody", notes, { reverb: 0.5, delay: 0.4 }),
      notePart(
        "pad",
        "chords",
        pad,
        { reverb: 0.4, chorus: 0.5, width: 1.4, lowCut: 120 },
        "pad",
      ),
      notePart(
        "bass",
        "bass",
        [{ t: 3.2, d: 1.4, midi: 36, vel: 0.9 }],
        { width: 0, reverb: 0, highCut: 2000 },
        "subBass",
      ),
      drumPart(
        "kit",
        [
          { t: 1, kind: "snare", vel: 0.8 },
          { t: 3.7, kind: "crash", vel: 0.8 },
        ],
        { reverb: 0.4 },
      ),
    ],
    {
      duration: 4,
      space: {
        size: 0.6,
        decay: 2.2,
        damping: 0.4,
        preDelay: 0.02,
        level: 0.6,
        delayTime: 0.375,
        delayFeedback: 0.5,
      },
    },
  );
  for (const character of ["clean", "lofi", "wide"] as MasterCharacter[]) {
    const { audio } = await render({
      ...score,
      master: { ...score.master, character },
    });
    const [mixLeft, mixRight] = mixDown(audio);
    for (const [name, data] of [
      ["mix L", mixLeft],
      ["mix R", mixRight],
      ...TRACKS.flatMap((track) => [
        [`${track} L`, audio.stems[track][0]],
        [`${track} R`, audio.stems[track][1]],
      ]),
    ] as [string, Float32Array][]) {
      const result = seam(data, audio.sampleRate);
      assert.ok(
        result.jump < 1.5,
        `${character} ${name}: seam step ${result.jump.toFixed(2)}× the local maximum`,
      );
      assert.ok(
        result.bend < 2,
        `${character} ${name}: seam bend ${result.bend.toFixed(2)}× the local maximum`,
      );
      // held notes: the same level on both sides. The drum stem is a crash
      // dying away (about 3.6 dB per 50 ms), so it may only fall, and gently.
      const allowed = name.startsWith("drums") ? 7 : 2;
      assert.ok(
        Math.abs(result.levelDb) < allowed,
        `${character} ${name}: level changes by ${result.levelDb.toFixed(2)} dB across the seam`,
      );
    }
    // the beginning carries what rang over from the end
    const [oneShotLeft] = mixDown(
      (
        await render({
          ...score,
          loop: false,
          master: { ...score.master, character },
        })
      ).audio,
    );
    const head = rms(mixLeft, 0.02 * SR, 0.4 * SR);
    assert.ok(head > 0.005, `${character}: wrapped tail present (${head})`);
    assert.ok(
      head > rms(oneShotLeft, 0.02 * SR, 0.4 * SR) * 20,
      `${character}: a one-shot starts from silence`,
    );
  }
});

test("render: the first downbeat of a one-shot piece keeps its attack, in level and under the limiter (ENG-1)", async () => {
  // the same stroke on the first frame and two seconds later must come out the same: nothing fades the
  // opening of the piece, and the glue and the limiter treat a stroke at t = 0 as they treat any other
  const times = [0, 2, 4, 6];
  const window = (data: Float32Array, at: number, ms: number) =>
    data.subarray(
      Math.round(at * SR),
      Math.round(at * SR) + Math.round((ms * SR) / 1000),
    );
  const cases: [string, Part][] = [
    [
      "kick",
      drumPart(
        "kit",
        times.map((t) => ({ t, kind: "kick", vel: 0.9 })),
        { reverb: 0 },
      ),
    ],
    // a kit of nothing but short bright strokes: the master has to add some 20 dB and the limiter holds every stroke
    [
      "hat",
      drumPart(
        "kit",
        times.map((t) => ({ t, kind: "hatClosed", vel: 0.9 })),
        { reverb: 0 },
      ),
    ],
    [
      "note",
      notePart(
        "lead",
        "melody",
        times.map((t) => ({ t, d: 0.5, midi: 72, vel: 0.9 })),
        { reverb: 0 },
      ),
    ],
  ];
  for (const [name, part] of cases) {
    const score = makeScore([part], {
      duration: 8,
      loop: false,
      space: { ...makeScore([]).space, level: 0 },
    });
    const { audio, report } = await render(score);
    assert.equal(
      report.master.startFaded,
      false,
      `${name}: a stroke that starts on the first frame is not a step`,
    );
    const [left, right] = mixDown(audio);
    assert.ok(
      Math.abs(left[0]) < 1e-6 && Math.abs(right[0]) < 1e-6,
      `${name}: the piece opens at zero by itself (${left[0]})`,
    );
    // the later strokes differ a little among themselves (each draws its own noise and pan): the first one
    // must lie where they lie. 5 ms of raised-cosine fade took 3–5 dB of this energy away, and the start of
    // the hats, which the limiter had not reached yet, stood 20 dB over the later ones.
    const energyDb = (at: number) =>
      10 *
      Math.log10(energy(window(left, at, 5)) + energy(window(right, at, 5)));
    const peakDb = (at: number, ms: number) =>
      db(Math.max(peakOf(window(left, at, ms)), peakOf(window(right, at, ms))));
    for (const [what, measure] of [
      ["energy of the first 5 ms", energyDb],
      ["peak of the first 5 ms", (at: number) => peakDb(at, 5)],
      ["peak of the first 30 ms", (at: number) => peakDb(at, 30)],
    ] as [string, (at: number) => number][]) {
      const later = times.slice(1).map(measure);
      const first = measure(0);
      // (upwards there is a decibel of room: the bus compressor has no history at the top of a piece)
      assert.ok(
        first > Math.min(...later) - 0.5 && first < Math.max(...later) + 1.5,
        `${name}: ${what} of the stroke at 0 s is ${first.toFixed(2)} dB, of the later ones ${later.map((value) => value.toFixed(2)).join(" / ")} dB`,
      );
    }
    // and the limiter holds its ceiling from the first frame on
    assert.ok(
      peakDb(0, 10) <= db(report.master.limiter.ceiling * 1.02),
      `${name}: start peaks at ${peakDb(0, 10).toFixed(2)} dB, ceiling ${report.master.limiter.ceiling}`,
    );
  }

  // a stereo stroke on the downbeat: the zero-phase side filter of the master answers it before it happens,
  // and that answer must not be cut off into a step on the first frame (it was 5 % of the stroke, left against right)
  const wide = makeScore(
    [
      notePart(
        "pad",
        "chords",
        [57, 64, 69].map((midi) => ({ t: 0, d: 2, midi, vel: 0.9 })),
        { width: 1.6, pan: -0.3, reverb: 0 },
        "pad",
      ),
    ],
    { duration: 4, loop: false, space: { ...makeScore([]).space, level: 0 } },
  );
  for (const character of ["clean", "wide", "lofi"] as MasterCharacter[]) {
    const { audio, report } = await render({
      ...wide,
      master: { ...wide.master, character },
    });
    assert.equal(
      report.master.startFaded,
      false,
      `${character}: no fade for a chord that starts on the first frame`,
    );
    for (const data of audio.stems.chords) {
      assert.ok(
        Math.abs(data[0]) < 1e-4 * peakOf(data.subarray(0, 240)) + 1e-9,
        `${character}: stem opens at ${data[0]}, reaches ${peakOf(data.subarray(0, 240))} within 5 ms`,
      );
      // no step anywhere in the opening either
      let step = 0;
      for (let i = 0; i < 480; i++)
        step = Math.max(step, Math.abs(data[i + 1] - data[i]));
      assert.ok(
        step < peakOf(data.subarray(0, 480)) * 0.2,
        `${character}: opening is smooth`,
      );
    }
  }
});

test("render: a one-shot piece that would open with a step is faded in over 5 ms; every one-shot ends in exact silence", async () => {
  // notes that were already sounding when the piece begins are cut at frame 0: that is a step, and the guard takes it
  const cut = makeScore(
    [
      // (0.3013 s: not a whole number of cycles, so frame 0 is not a zero crossing of the tone)
      notePart("lead", "melody", [{ t: -0.3013, d: 1.2, midi: 69, vel: 0.9 }], {
        reverb: 0.2,
      }),
      drumPart("kit", [{ t: 0, kind: "kick", vel: 1 }]),
    ],
    { duration: 3, loop: false },
  );
  const cutRender = await render(cut);
  assert.equal(cutRender.report.master.startFaded, true);
  for (const data of cutRender.audio.stems.melody) {
    assert.ok(data[0] === 0, "a faded start begins at exact zero");
    assert.ok(
      peakOf(data.subarray(0, 48)) < peakOf(data.subarray(240, 2400)) * 0.2,
      "the first millisecond is far below the level after 5 ms",
    );
    let step = 0;
    for (let i = 0; i < 480; i++)
      step = Math.max(step, Math.abs(data[i + 1] - data[i]));
    let after = 0;
    for (let i = 480; i < 4800; i++)
      after = Math.max(after, Math.abs(data[i + 1] - data[i]));
    assert.ok(
      step <= after * 1.2,
      `the fade-in has no step in it (${step} against ${after} later on)`,
    );
  }
  // the same note in a loop is not a cut note: it wraps, and nothing is faded
  assert.equal(
    (await render({ ...cut, loop: true })).report.master.startFaded,
    false,
  );

  // a chord that starts at 0 and one that is still sounding at the very end
  const score = makeScore(
    [
      notePart(
        "lead",
        "melody",
        [
          { t: 0, d: 1, midi: 69, vel: 0.9 },
          { t: 2.2, d: 2, midi: 72, vel: 0.9 },
        ],
        { reverb: 0.4, delay: 0.3 },
      ),
      notePart(
        "pad",
        "chords",
        [{ t: 0, d: 4, midi: 57, vel: 0.8 }],
        { chorus: 0.4 },
        "pad",
      ),
      notePart(
        "bass",
        "bass",
        [{ t: 0, d: 3.5, midi: 33, vel: 0.9 }],
        { width: 0, reverb: 0 },
        "subBass",
      ),
      drumPart("kit", [
        { t: 0, kind: "kick", vel: 1 },
        { t: 2.9, kind: "crash", vel: 1 },
      ]),
    ],
    { duration: 3, loop: false },
  );
  for (const character of ["clean", "lofi", "bitcrush"] as MasterCharacter[]) {
    const { audio, report } = await render({
      ...score,
      master: { ...score.master, character },
    });
    assert.equal(
      report.master.startFaded,
      false,
      `${character}: music that starts at t = 0 is left alone`,
    );
    const n = audio.frames;
    for (const track of TRACKS)
      for (const data of audio.stems[track]) {
        // it opens at zero by itself (the lofi hiss bed rises from nothing, the crushed grid keeps silence silent)
        assert.ok(
          Math.abs(data[0]) < 1e-6,
          `${character} ${track}: starts at ${data[0]}`,
        );
        assert.ok(
          data[n - 1] === 0,
          `${character} ${track}: ends at exact zero`,
        );
        // fade-out (the last quarter of so short a piece): it falls away, the final millisecond is practically silent
        const body = rms(data, n - 4800, n - 1440);
        assert.ok(
          body > 1e-3,
          `${character} ${track}: still sounding 30 ms before the end`,
        );
        assert.ok(rms(data, n - 720, n) < body * 0.4);
        assert.ok(
          rms(data, n - 48, n) < body * 0.01,
          `${character} ${track}: last millisecond`,
        );
        // and the fade has no step in it
        let step = 0;
        for (let i = n - 1440; i < n - 1; i++)
          step = Math.max(step, Math.abs(data[i + 1] - data[i]));
        let before = 0;
        for (let i = n - 4800; i < n - 1441; i++)
          before = Math.max(before, Math.abs(data[i + 1] - data[i]));
        assert.ok(
          step <= before * 1.2 + 2 / 1024,
          `${character} ${track}: fade-out is smooth`,
        );
      }
  }
});

test("render: a track without parts stays silent and takes its ambience with it", async () => {
  const full = bandScore(4);
  const { audio } = await render(full);
  for (const track of TRACKS) assert.ok(!isSilent(audio.stems[track]));
  for (const muted of TRACKS) {
    const score = {
      ...full,
      parts: full.parts.filter((part) => part.track !== muted),
    };
    const result = await render(score);
    for (const track of TRACKS) {
      if (track === muted)
        assert.ok(
          isSilent(result.audio.stems[track]),
          `${muted} stem is digital silence`,
        );
      else
        assert.ok(
          rms(result.audio.stems[track][0]) > 1e-4,
          `${track} still plays`,
        );
    }
    // the rest is still mastered to the target
    assert.ok(Math.abs(measureMix(result.audio.stems).lufs + 16) < 0.7);
  }
  // a part with no events, or an empty score, is handled too
  const empty = await render({
    ...full,
    parts: [notePart("nothing", "melody", [])],
  });
  for (const track of TRACKS) assert.ok(isSilent(empty.audio.stems[track]));
  assert.equal(empty.report.master.silent, true);
  assert.equal(empty.audio.frames, 4 * SR);

  // each track's reverb lives in its own stem: with only the lead sending,
  // the lead's tail is in the melody stem and nowhere else
  const lead = notePart(
    "lead",
    "melody",
    [{ t: 0.2, d: 0.2, midi: 72, vel: 1 }],
    { reverb: 1, delay: 0 },
  );
  const dryKit = drumPart("kit", [{ t: 0.2, kind: "snare", vel: 1 }], {
    reverb: 0,
  });
  const tails = await render(
    makeScore([lead, dryKit], {
      duration: 3,
      loop: false,
      space: {
        size: 0.6,
        decay: 2,
        damping: 0.3,
        preDelay: 0,
        level: 0.8,
        delayTime: 0.3,
        delayFeedback: 0.3,
      },
    }),
  );
  // 1 s later the dry sounds (0.2 s + 0.3 s tail, 0.12 s snare) are long gone
  assert.ok(
    rms(tails.audio.stems.melody[0], 1.2 * SR, 1.6 * SR) > 1e-3,
    "reverb tail in the melody stem",
  );
  assert.ok(
    rms(tails.audio.stems.drums[0], 1.2 * SR, 1.6 * SR) < 1e-6,
    "no reverb in the drum stem",
  );
  const noSend = await render(
    makeScore([{ ...lead, mix: mix({ reverb: 0 }) }, dryKit], {
      duration: 3,
      loop: false,
    }),
  );
  assert.ok(
    rms(noSend.audio.stems.melody[0], 1.2 * SR, 1.6 * SR) < 1e-6,
    "no send, no tail",
  );
});

test("render: the reference mix is mastered to the target loudness and stays under the clipper", async () => {
  const cases: [string, Score][] = [
    ["band", bandScore(8)],
    ["one-shot", bandScore(8, { loop: false })],
    ["44.1 kHz", bandScore(6, { sampleRate: 44100 })],
    [
      "-14 LUFS",
      bandScore(6, {
        master: { targetLufs: -14, ceilingDb: -1, character: "clean", tilt: 0 },
      }),
    ],
    [
      "-20 LUFS",
      bandScore(6, {
        master: {
          targetLufs: -20,
          ceilingDb: -1,
          character: "warm",
          tilt: -0.5,
        },
      }),
    ],
    [
      "drums only",
      {
        ...bandScore(6),
        parts: bandScore(6).parts.filter((part) => part.track === "drums"),
      },
    ],
    [
      "pad only",
      {
        ...bandScore(6),
        parts: bandScore(6).parts.filter((part) => part.track === "chords"),
      },
    ],
    ...(
      ["warm", "lofi", "wide", "punchy", "bitcrush"] as MasterCharacter[]
    ).map((character): [string, Score] => [
      character,
      bandScore(6, {
        master: { targetLufs: -16, ceilingDb: -1, character, tilt: 0.3 },
      }),
    ]),
  ];
  for (const [name, score] of cases) {
    const { audio, report } = await render(score);
    const measured = measureMix(
      audio.stems,
      REFERENCE_VOLUMES,
      audio.sampleRate,
    );
    // A full arrangement must land on the target. A solo drum kit is all
    // transients: there the master may stop up to 1.5 LU short rather than
    // limit every hit hard, and says so in its report.
    if (name !== "drums only")
      assert.equal(report.master.shortfallLu, 0, `${name}: no shortfall`);
    assert.ok(
      report.master.shortfallLu >= 0 && report.master.shortfallLu <= 1.5,
    );
    const target = score.master.targetLufs - report.master.shortfallLu;
    assert.ok(
      Math.abs(measured.lufs - target) < 0.7,
      `${name}: ${measured.lufs.toFixed(2)} LUFS, target ${target}`,
    );
    // an independent measurement of the clipped mix agrees
    const [left, right] = mixDown(audio);
    const clipped: StereoPcm = [left.map(softClip), right.map(softClip)];
    const direct = integratedLoudness(clipped[0], clipped[1], audio.sampleRate);
    assert.ok(
      Math.abs(direct - measured.lufs) < 0.02,
      `${name}: measureMix agrees with the meter`,
    );
    assert.ok(
      Math.abs(report.master.lufs - measured.lufs) < 0.02,
      `${name}: the report is truthful`,
    );
    // peaks: the limiter holds the reference mix just above the knee, so the
    // soft clipper has almost nothing to do and can never be driven flat
    assert.ok(
      measured.peak <= LIMITER_CEILING * 1.03,
      `${name}: mix peak ${measured.peak.toFixed(3)}`,
    );
    assert.ok(
      measured.clippedRatio < 0.01,
      `${name}: ${(measured.clippedRatio * 100).toFixed(2)} % of samples past the knee`,
    );
    assert.ok(
      peakOf(clipped[0]) < CEILING && peakOf(clipped[1]) < CEILING,
      `${name}: under the clipper's ceiling`,
    );
    assert.ok(KNEE < LIMITER_CEILING && LIMITER_CEILING < 1);
    // even with every fader fully up the output cannot exceed the ceiling
    const hot = mixDown(audio, { melody: 1, chords: 1, bass: 1, drums: 1 });
    assert.ok(peakOf(hot[0].map(softClip)) <= CEILING + 1e-6);
  }
});

test("render: loud transients are caught by the limiter, not by the clipper", async () => {
  // sparse full-velocity kicks over a quiet pad: a peak-to-loudness ratio no
  // static gain could fit under the ceiling
  const hits: DrumEvent[] = [0.5, 2.5, 4.5, 6.5].map((t) => ({
    t,
    kind: "kick",
    vel: 1,
  }));
  const pad: NoteEvent[] = [0, 2, 4, 6].flatMap((t) =>
    [52, 59].map((midi) => ({ t, d: 1.9, midi, vel: 0.35 })),
  );
  const score = makeScore(
    [
      notePart("pad", "chords", pad, { gain: 0.3 }, "pad"),
      drumPart("kit", hits, { gain: 1.4, reverb: 0 }),
    ],
    { duration: 8 },
  );
  const { audio, report } = await render(score);
  const measured = measureMix(audio.stems);
  assert.ok(
    report.master.limiter.maxReductionDb > 1,
    `limiter worked: ${report.master.limiter.maxReductionDb.toFixed(2)} dB`,
  );
  assert.ok(
    measured.peak <= report.master.limiter.ceiling * 1.03,
    `peak ${measured.peak}`,
  );
  assert.ok(
    Math.abs(measured.lufs + 16 + report.master.shortfallLu) < 0.7,
    `${measured.lufs} LUFS`,
  );
  assert.ok(report.master.shortfallLu <= 1.5);
  assert.ok(measured.clippedRatio < 0.01);
  // the limiter gain is shared: both stems dip together, so their balance is kept
  assert.ok(report.master.compressor.maxReductionDb <= 3.6);
});

test("render: onProgress runs from 0 to 1 without going back, checkpoint can cancel", async () => {
  const score = bandScore(4);
  const progress: number[] = [];
  let checkpoints = 0;
  await render(score, {
    paceMs: 0,
    onProgress: (fraction) => progress.push(fraction),
    checkpoint: async () => {
      checkpoints++;
    },
  });
  assert.equal(progress[0], 0);
  assert.equal(progress[progress.length - 1], 1);
  assert.ok(progress.length > 50, `${progress.length} progress calls`);
  for (let i = 1; i < progress.length; i++) {
    assert.ok(progress[i] >= progress[i - 1], "monotonic");
    assert.ok(progress[i] >= 0 && progress[i] <= 1);
  }
  assert.ok(
    progress.filter((value) => value === 1).length === 1,
    "1 is reported once, at the end",
  );
  // progress is spread over the whole render, not bunched at the ends
  const middle = progress.filter(
    (value) => value > 0.25 && value < 0.75,
  ).length;
  assert.ok(
    middle > progress.length * 0.2,
    `${middle} of ${progress.length} calls in the middle half`,
  );
  assert.ok(
    checkpoints >= progress.length - 2,
    "every progress report is followed by a checkpoint",
  );

  // default pacing still reports the two ends
  const coarse: number[] = [];
  await render(score, { onProgress: (fraction) => coarse.push(fraction) });
  assert.equal(coarse[0], 0);
  assert.equal(coarse[coarse.length - 1], 1);

  // cancel: the rejection of checkpoint() ends the render with that error
  for (const cancelAt of [1, 5, 60]) {
    let calls = 0;
    const abort = new Error("已取消生成");
    abort.name = "AbortError";
    await assert.rejects(
      renderScoreWith(score, BANKS, {
        paceMs: 0,
        checkpoint: async () => {
          if (++calls >= cancelAt) throw abort;
        },
      }),
      (error) => error === abort,
    );
    assert.equal(calls, cancelAt, "nothing runs after the cancellation");
  }
  // an exception thrown by onProgress also propagates
  await assert.rejects(
    renderScoreWith(score, BANKS, {
      paceMs: 0,
      onProgress: (fraction) => {
        if (fraction > 0.3) throw new Error("stop");
      },
    }),
    /stop/,
  );
});

test("render: part mix settings do what they say", async () => {
  const tone: NoteEvent[] = [{ t: 0.25, d: 3, midi: 69, vel: 0.8 }];
  const kick: DrumEvent[] = [{ t: 2, kind: "kick", vel: 1 }];
  const quietKit = drumPart("kit", kick, { gain: 0.05, reverb: 0 });
  const stemOf = async (partMix: Partial<PartMix>, extra: Part[] = []) => {
    const score = makeScore(
      [notePart("tone", "chords", tone, { reverb: 0, ...partMix }), ...extra],
      { duration: 4, loop: false },
    );
    return (await render(score)).audio.stems.chords;
  };
  const balance = (stem: StereoPcm) =>
    db(rms(stem[1], SR, 2 * SR) / Math.max(rms(stem[0], SR, 2 * SR), 1e-9));

  // pan
  assert.ok(balance(await stemOf({ pan: 0.6, width: 0 })) > 6);
  assert.ok(balance(await stemOf({ pan: -0.6, width: 0 })) < -6);
  assert.ok(Math.abs(balance(await stemOf({ pan: 0, width: 0 }))) < 0.01);
  // hard left stays hard left through the master's mono-lows stage (zero-phase side filter)
  const hardLeft = await stemOf({ pan: -1, width: 0 });
  const leak = db(rms(hardLeft[1], SR, 2 * SR) / rms(hardLeft[0], SR, 2 * SR));
  assert.ok(
    leak < -45,
    `hard-left part leaks ${leak.toFixed(1)} dB into the right channel`,
  );
  // width 0 is exactly mono, and the test voice's own stereo comes back at width 1
  const mono = await stemOf({ width: 0 });
  assert.ok(mono[0].every((value, i) => value === mono[1][i]));
  const natural = await stemOf({ width: 1 });
  assert.ok(Math.abs(balance(natural)) > 0.05);
  // chorus decorrelates the two sides — unless width 0 folds the part to mono afterwards
  const chorused = await stemOf({ chorus: 0.8 });
  assert.ok(
    correlation(
      chorused[0].subarray(SR, 3 * SR),
      chorused[1].subarray(SR, 3 * SR),
    ) < 0.97,
  );
  const folded = await stemOf({ width: 0, chorus: 0.8 });
  assert.ok(
    folded[0].every((value, i) => value === folded[1][i]),
    "width comes after the chorus",
  );

  // low cut / high cut: a 440 Hz tone under a 1.76 kHz high-pass loses about 24 dB.
  // (Loudness normalisation would hide that, so a second, untouched part anchors the level.)
  const anchor = notePart(
    "anchor",
    "melody",
    [{ t: 0.25, d: 3, midi: 81, vel: 0.8 }],
    { reverb: 0 },
  );
  const level = async (partMix: Partial<PartMix>) => {
    const score = makeScore(
      [
        notePart("tone", "chords", tone, { reverb: 0, width: 0, ...partMix }),
        anchor,
      ],
      { duration: 4, loop: false },
    );
    const { audio } = await render(score);
    return db(
      rms(audio.stems.chords[0], SR, 2 * SR) /
        rms(audio.stems.melody[0], SR, 2 * SR),
    );
  };
  const flat = await level({});
  assert.ok(
    Math.abs((await level({ lowCut: 1760 })) - flat + 23) < 4,
    "low cut two octaves above the tone",
  );
  assert.ok(
    Math.abs((await level({ highCut: 110 })) - flat + 22) < 5,
    "high cut two octaves below the tone",
  );
  assert.ok(
    Math.abs((await level({ gain: 0.3 })) - flat - db(0.3 / 0.6)) < 0.6,
    "gain is linear",
  );

  // duck: the part dips under the kick and recovers
  const ducked = await stemOf({ duck: 1, width: 0 }, [quietKit]);
  const plain = await stemOf({ duck: 0, width: 0 }, [quietKit]);
  const dip = db(
    rms(ducked[0], 2.005 * SR, 2.025 * SR) /
      rms(plain[0], 2.005 * SR, 2.025 * SR),
  );
  assert.ok(
    dip < -9 && dip > -13,
    `ducked by ${dip.toFixed(1)} dB under the kick`,
  );
  assert.ok(
    Math.abs(
      db(
        rms(ducked[0], 1.5 * SR, 1.9 * SR) / rms(plain[0], 1.5 * SR, 1.9 * SR),
      ),
    ) < 0.3,
    "untouched before the kick",
  );
  assert.ok(
    Math.abs(
      db(rms(ducked[0], 2.5 * SR, 3 * SR) / rms(plain[0], 2.5 * SR, 3 * SR)),
    ) < 0.3,
    "recovered half a second later",
  );

  // sends follow the space settings; inaudible ones are switched off
  assert.ok(reverbReturnGain(makeScore([]).space) > 0.5);
  assert.equal(reverbReturnGain({ ...makeScore([]).space, level: 0 }), 0);
  assert.equal(delayReturnGain({ ...makeScore([]).space, level: 0 }), 0);
  assert.equal(delayReturnGain({ ...makeScore([]).space, level: 0.6 }), 1);
  const faint = await render(
    makeScore(
      [
        notePart("tone", "chords", [{ t: 0.2, d: 0.2, midi: 69, vel: 0.8 }], {
          reverb: SEND_FLOOR / 2,
        }),
      ],
      { duration: 3, loop: false },
    ),
  );
  assert.ok(
    rms(faint.audio.stems.chords[0], 1.5 * SR, 2 * SR) < 1e-7,
    "a send under the floor is off",
  );
  assert.equal(
    faint.report.fullLengthStereoBuffers,
    5,
    "and its buffers are never allocated",
  );
});

test("render: failures are reported, not rendered", async () => {
  const broken: Voice = {
    id: "piano",
    tail: () => 0.1,
    render(left, _right, frames) {
      left[frames >> 1] = NaN;
    },
  };
  const score = makeScore(
    [notePart("lead", "melody", [{ t: 0.5, d: 0.3, midi: 60, vel: 0.8 }])],
    { duration: 2 },
  );
  await assert.rejects(
    renderScoreWith(score, {
      voices: { ...TEST_VOICES, piano: broken },
      drums: TEST_DRUMS,
    }),
    /part "lead".*piano.*non-finite/,
  );
  await assert.rejects(
    renderScoreWith(score, {
      voices: { ...TEST_VOICES, piano: undefined as unknown as Voice },
      drums: TEST_DRUMS,
    }),
    /no voice "piano"/,
  );
  await assert.rejects(
    renderScoreWith({ ...score, sampleRate: 0 }, BANKS),
    RangeError,
  );
  // a zero-length piece is an empty result, not an error
  const nothing = await renderScoreWith({ ...score, duration: 0 }, BANKS);
  assert.equal(nothing.frames, 0);
  assert.equal(nothing.stems.melody[0].length, 0);
});

test("render: memory and speed stay inside the budget", async () => {
  const seconds = 20;
  const score = bandScore(seconds);
  const frames = seconds * SR;
  const stereoBytes = frames * 4 * 2;
  const before = process.memoryUsage().arrayBuffers;
  let peak = 0;
  const { audio, report } = await render(score, {
    onProgress: () => {
      peak = Math.max(peak, process.memoryUsage().arrayBuffers - before);
    },
  });
  // 4 stems + part bus + reverb send (stereo) + delay send (mono)
  assert.equal(report.fullLengthStereoBuffers, 6.5);
  assert.ok(report.fullLengthStereoBuffers <= 8);
  // the high-water mark: those, plus the note scratch pair, the voices' work buffers and the duck curve
  // (short notes here: a megabyte or two; tests/render-memory.test.ts holds the report against the process)
  assert.ok(
    report.bufferBytes > 6.5 * stereoBytes,
    "the scratch buffers are part of what was held",
  );
  assert.ok(
    report.bufferBytes < 6.5 * stereoBytes + 4e6,
    `${report.bufferBytes} bytes for ${6.5 * stereoBytes} of full-length buffers`,
  );
  // measured: everything the render holds, with generous room for scratch and uncollected garbage
  assert.ok(
    peak < 12 * stereoBytes,
    `peak ArrayBuffer growth ${(peak / 1e6).toFixed(1)} MB`,
  );
  assert.equal(audio.frames, frames);
  assert.equal(report.notes, 10 * 20);
  assert.equal(report.hits, 10 * 10);
  // speed: the mixer, effects and master alone run far faster than this
  // (about 0.2 s here); the bound only catches an accidental quadratic loop
  assert.ok(
    report.seconds.total < 6,
    `rendered ${seconds} s in ${report.seconds.total.toFixed(2)} s`,
  );
  const stages =
    report.seconds.voices +
    report.seconds.parts +
    report.seconds.sends +
    report.seconds.master;
  assert.ok(stages <= report.seconds.total + 0.01);
  assert.ok(
    report.seconds.parts + report.seconds.sends + report.seconds.master < 4,
  );
});

/* ---------- master (on synthetic stems) ---------- */

function emptyStems(frames: number): Stems {
  return Object.fromEntries(
    TRACKS.map((track) => [
      track,
      [new Float32Array(frames), new Float32Array(frames)],
    ]),
  ) as Stems;
}

function fillNoise(
  stem: StereoPcm,
  seed: number,
  gain: number,
  lowpassHz = 6000,
): void {
  const random = createRng(seed);
  for (const data of stem) {
    for (let i = 0; i < data.length; i++) data[i] = (random() * 2 - 1) * gain;
    new Biquad().setLowpass(lowpassHz, 0.707, SR).process(data, data.length);
  }
}

const SETTINGS: MasterSettings = {
  targetLufs: -16,
  ceilingDb: -1,
  character: "clean",
  tilt: 0,
};

test("master: every character lands on the target and leaves silent stems silent", async () => {
  for (const character of [
    "clean",
    "warm",
    "lofi",
    "wide",
    "punchy",
    "bitcrush",
  ] as MasterCharacter[])
    for (const loop of [true, false]) {
      const stems = emptyStems(SR * 5);
      fillNoise(stems.melody, 1, 0.05);
      fillNoise(stems.bass, 2, 0.4, 200);
      const report = await masterStems(
        stems,
        { ...SETTINGS, character },
        { sampleRate: SR, loop, seed: 9 },
      );
      assert.ok(
        Math.abs(report.lufs + 16) < 0.5,
        `${character}: ${report.lufs}`,
      );
      assert.ok(Math.abs(measureMix(stems).lufs - report.lufs) < 0.02);
      assert.ok(
        isSilent(stems.chords) && isSilent(stems.drums),
        `${character}: untouched stems stay silent`,
      );
      assert.ok(allFinite(stems.melody) && allFinite(stems.bass));
      assert.equal(report.silent, false);
    }
  // all silent: nothing happens
  const silent = emptyStems(SR);
  const report = await masterStems(silent, SETTINGS, {
    sampleRate: SR,
    loop: false,
  });
  assert.equal(report.silent, true);
  assert.equal(report.lufs, -Infinity);
  for (const track of TRACKS) assert.ok(isSilent(silent[track]));
  // too short for a gated measurement: still brought to the target by its mean level
  const short = emptyStems(Math.round(SR * 0.25));
  fillNoise(short.melody, 3, 0.01);
  await masterStems(short, SETTINGS, { sampleRate: SR, loop: true });
  const level = db(rms(short.melody[0]) * REFERENCE_VOLUMES.melody);
  assert.ok(level > -26 && level < -14, `short buffer level ${level} dBFS`);
});

test("master: one gain curve for all stems — the stems still sum to the mastered mix", async () => {
  // two stems with the same content come out identical, whatever the others do
  const stems = emptyStems(SR * 4);
  fillNoise(stems.melody, 5, 0.1);
  stems.chords[0].set(stems.melody[0]);
  stems.chords[1].set(stems.melody[1]);
  // a bass that only plays in the second half pushes the mix into the compressor there
  const frames = stems.bass[0].length;
  for (let i = frames / 2; i < frames; i++) {
    const pulse = Math.exp(-((i % 24000) / 8000));
    stems.bass[0][i] = stems.bass[1][i] =
      0.9 * pulse * Math.sin((2 * Math.PI * 70 * i) / SR);
  }
  const report = await masterStems(stems, SETTINGS, {
    sampleRate: SR,
    loop: true,
  });
  assert.deepEqual(stems.chords[0], stems.melody[0]);
  assert.deepEqual(stems.chords[1], stems.melody[1]);
  assert.ok(
    report.compressor.maxReductionDb > 0.5 &&
      report.compressor.maxReductionDb <= 3.6,
  );
  assert.ok(
    report.compressor.meanReductionDb < report.compressor.maxReductionDb,
  );
  // the noise stem carries the gain movement caused by the bass: quieter while the bass plays
  const withBass = rms(stems.melody[0], frames * 0.6, frames * 0.9);
  const alone = rms(stems.melody[0], frames * 0.1, frames * 0.4);
  assert.ok(
    db(withBass / alone) < -0.3,
    `gain rides with the mix: ${db(withBass / alone).toFixed(2)} dB`,
  );
  assert.ok(db(withBass / alone) > -4, "but gently: this is glue, not pumping");
  assert.ok(measureMix(stems).peak <= report.limiter.ceiling * 1.03);
});

test("master: limiter guarantees the ceiling for the reference mix", async () => {
  for (const loop of [true, false]) {
    // isolated full-scale clicks and bursts over a quiet bed
    const stems = emptyStems(SR * 6);
    fillNoise(stems.chords, 6, 0.01);
    const random = createRng(77);
    for (let hit = 0; hit < 40; hit++) {
      const at = Math.floor(random() * (stems.drums[0].length - 2000));
      const length = 20 + Math.floor(random() * 1500);
      for (let i = 0; i < length; i++) {
        const value = (random() * 2 - 1) * Math.exp(-i / (length / 4));
        stems.drums[0][at + i] += value;
        stems.drums[1][at + i] += value * (hit % 2 ? 1 : -0.5);
      }
    }
    // one burst right at the end, so a loop has to look ahead across the seam
    for (let i = 0; i < 300; i++)
      stems.drums[0][stems.drums[0].length - 1 - i] += 0.9;
    const report = await masterStems(stems, SETTINGS, { sampleRate: SR, loop });
    const measured = measureMix(stems);
    assert.ok(
      report.limiter.maxReductionDb > 3,
      `limiting ${report.limiter.maxReductionDb.toFixed(1)} dB`,
    );
    assert.ok(
      measured.peak <= report.limiter.ceiling * 1.03,
      `loop ${loop}: peak ${measured.peak.toFixed(4)} over ceiling ${report.limiter.ceiling}`,
    );
    assert.ok(measured.clippedRatio < 0.01);
    assert.ok(
      Math.abs(measured.lufs - (-16 - report.shortfallLu)) < 0.5,
      `${measured.lufs}`,
    );
  }
  // a lower ceiling in the settings is respected
  const stems = emptyStems(SR * 3);
  fillNoise(stems.melody, 8, 0.2);
  const report = await masterStems(
    stems,
    { ...SETTINGS, ceilingDb: -9 },
    { sampleRate: SR, loop: false },
  );
  assert.ok(Math.abs(report.limiter.ceiling - Math.pow(10, -9 / 20)) < 1e-6);
  assert.ok(measureMix(stems).peak <= report.limiter.ceiling * 1.03);
});

test("master: lows are mono, sub-sonics are removed, tilt and characters colour the spectrum", async () => {
  const frames = SR * 4;
  const build = () => {
    const stems = emptyStems(frames);
    // out-of-phase 60 Hz and 2 kHz, in-phase 400 Hz, a 12 Hz rumble and DC
    for (let i = 0; i < frames; i++) {
      const low = 0.2 * Math.sin((2 * Math.PI * 60 * i) / SR);
      const high = 0.1 * Math.sin((2 * Math.PI * 2000 * i) / SR);
      const centre = 0.2 * Math.sin((2 * Math.PI * 400 * i) / SR);
      const rumble = 0.2 * Math.sin((2 * Math.PI * 12 * i) / SR) + 0.05;
      stems.melody[0][i] = low + high + centre + rumble;
      stems.melody[1][i] = -low - high + centre + rumble;
    }
    fillNoise(stems.chords, 12, 0.1, 20000);
    return stems;
  };
  const component = (stem: StereoPcm, hz: number, side: boolean) => {
    const data = Float32Array.from(
      stem[0],
      (value, i) => (side ? value - stem[1][i] : value + stem[1][i]) / 2,
    );
    const spectrum = powerSpectrum(data, SR, SR, 65536);
    const bin = Math.round(hz / spectrum.binHz);
    let power = 0;
    for (let k = bin - 3; k <= bin + 3; k++) power += spectrum.power[k];
    return 10 * Math.log10(power + 1e-20);
  };
  const before = build();
  const after = build();
  await masterStems(after, SETTINGS, { sampleRate: SR, loop: true });
  const change = (hz: number, side: boolean) =>
    component(after.melody, hz, side) - component(before.melody, hz, side);
  const reference = change(400, false);
  assert.ok(
    change(60, true) - reference < -10,
    `60 Hz side: ${(change(60, true) - reference).toFixed(1)} dB`,
  );
  assert.ok(
    Math.abs(change(2000, true) - reference) < 0.5,
    "2 kHz side untouched",
  );
  assert.ok(
    change(12, false) - reference < -14,
    `12 Hz rumble: ${(change(12, false) - reference).toFixed(1)} dB`,
  );
  let mean = 0;
  for (let i = SR; i < frames; i++) mean += after.melody[0][i];
  assert.ok(Math.abs(mean / (frames - SR)) < 1e-4, "DC removed");

  // tilt and character, measured on the noise stem: level of a high band relative to the 300 Hz .. 3 kHz body
  const highShare = (stems: Stems, fromHz: number) => {
    const spectrum = powerSpectrum(stems.chords[0], SR, SR, 65536);
    let high = 0;
    let body = 0;
    for (let k = 1; k < spectrum.power.length; k++) {
      const hz = k * spectrum.binHz;
      if (hz > 300 && hz < 3000) body += spectrum.power[k] / 2700;
      if (hz > fromHz && hz < fromHz + 4000) high += spectrum.power[k] / 4000;
    }
    return 10 * Math.log10(high / body);
  };
  const mastered = async (settings: Partial<MasterSettings>) => {
    const stems = build();
    await masterStems(
      stems,
      { ...SETTINGS, ...settings },
      { sampleRate: SR, loop: true, seed: 3 },
    );
    return stems;
  };
  const flat = highShare(after, 8000);
  assert.ok(
    Math.abs(flat) < 0.7,
    `clean, no tilt: flat (${flat.toFixed(2)} dB)`,
  );
  const bright = highShare(await mastered({ tilt: 1 }), 8000);
  const dark = highShare(await mastered({ tilt: -1 }), 8000);
  assert.ok(
    bright > 2.5 && bright < 6 && dark < -2.5 && dark > -6,
    `tilt ±1: ${bright.toFixed(1)} / ${dark.toFixed(1)} dB`,
  );
  const warm = highShare(await mastered({ character: "warm" }), 8000);
  assert.ok(
    warm < flat - 1 && warm > flat - 4,
    `warm rolls off the top gently: ${warm.toFixed(1)} dB`,
  );
  const lofi = await mastered({ character: "lofi" });
  assert.ok(
    highShare(lofi, 12000) < highShare(after, 12000) - 8,
    "lofi is band-limited",
  );
  // wide: more side above 200 Hz, lows still mono
  const wide = await mastered({ character: "wide" });
  const sideGain = (stems: Stems, hz: number) =>
    component(stems.melody, hz, true) - component(stems.melody, 400, false);
  assert.ok(
    sideGain(wide, 2000) - sideGain(after, 2000) > 1.5,
    "wide lifts the sides",
  );
  assert.ok(
    component(wide.melody, 60, true) - component(wide.melody, 400, false) <
      sideGain(before, 60) - 10,
    "wide keeps the lows mono",
  );
  // bitcrush: every sample sits on the 11-bit grid
  const crushed = await mastered({ character: "bitcrush" });
  for (let i = 0; i < frames; i += 101) {
    const steps = crushed.chords[0][i] * 1024;
    assert.ok(Math.abs(steps - Math.round(steps)) < 1e-3);
  }
});

test("master: a looping signal stays loopable", async () => {
  // four seconds of two steady tones with a whole number of cycles, pulsed
  // by a bass that keeps the compressor moving through the seam
  const frames = SR * 4;
  for (const character of ["clean", "lofi", "punchy"] as MasterCharacter[]) {
    const stems = emptyStems(frames);
    for (let i = 0; i < frames; i++) {
      stems.melody[0][i] = 0.1 * Math.sin((2 * Math.PI * 330 * i) / SR);
      stems.melody[1][i] = 0.1 * Math.sin((2 * Math.PI * 495 * i) / SR);
      const pulse = Math.exp(-(((i + 6000) % 48000) / 9000));
      stems.bass[0][i] = stems.bass[1][i] =
        0.6 * pulse * Math.sin((2 * Math.PI * 55 * i) / SR);
    }
    await masterStems(
      stems,
      { ...SETTINGS, character },
      { sampleRate: SR, loop: true, seed: 5 },
    );
    for (const data of [stems.melody[0], stems.melody[1], stems.bass[0]]) {
      const result = seam(data);
      assert.ok(
        result.jump < 1.5,
        `${character}: seam step ${result.jump.toFixed(2)}`,
      );
      assert.ok(
        result.bend < 2.5,
        `${character}: seam bend ${result.bend.toFixed(2)}`,
      );
      // the tones are steady, so any change of level at the seam is the master's doing
      if (data !== stems.bass[0])
        assert.ok(
          Math.abs(result.levelDb) < 1,
          `${character}: level across the seam ${result.levelDb.toFixed(2)} dB`,
        );
    }
    // the gain envelope itself wraps: the tone's level moves across the seam no faster than it does on either side of it
    const tone = stems.melody[0];
    const level = (window: number) => {
      const from = (((window * 1455) % frames) + frames) % frames;
      return db(rms(tone, from, from + 1455));
    };
    const across = Math.abs(level(0) - level(-1));
    const beside = Math.max(
      Math.abs(level(-1) - level(-2)),
      Math.abs(level(1) - level(0)),
    );
    assert.ok(
      across < Math.max(0.2, beside + 0.1),
      `${character}: envelope continuous (${across.toFixed(2)} dB across the seam, ${beside.toFixed(2)} beside it)`,
    );
  }
});

/* ---------- the real instruments ---------- */

test("renderScore: built-in voices and kits render a mastered, seamless, repeatable loop", async () => {
  const beat = 0.5;
  const lead: NoteEvent[] = [];
  const chords: NoteEvent[] = [];
  const bass: NoteEvent[] = [];
  const hits: DrumEvent[] = [];
  for (let bar = 0; bar < 4; bar++) {
    const t0 = bar * 2;
    const root = [57, 53, 48, 55][bar];
    for (let e = 0; e < 4; e++) {
      lead.push({
        t: t0 + e * beat + 0.02,
        d: 0.4,
        midi: root + 12 + [0, 4, 7, 4][e],
        vel: 0.7,
      });
      bass.push({ t: t0 + e * beat, d: 0.4, midi: root - 24, vel: 0.8 });
      hits.push({ t: t0 + e * beat, kind: "kick", vel: 0.9 });
      hits.push({ t: t0 + e * beat + 0.25, kind: "hatClosed", vel: 0.5 });
      if (e % 2) hits.push({ t: t0 + e * beat, kind: "snare", vel: 0.8 });
    }
    for (const offset of [0, 4, 7])
      chords.push({ t: t0, d: 1.9, midi: root + offset, vel: 0.6 });
  }
  const score = makeScore(
    [
      notePart(
        "lead",
        "melody",
        lead,
        { gain: 0.8, reverb: 0.3, delay: 0.15 },
        "piano",
      ),
      notePart(
        "pad",
        "chords",
        chords,
        {
          gain: 0.45,
          width: 1.3,
          reverb: 0.4,
          chorus: 0.3,
          lowCut: 150,
          duck: 0.4,
        },
        "pad",
      ),
      notePart(
        "bass",
        "bass",
        bass,
        { gain: 0.8, width: 0, reverb: 0, highCut: 2500 },
        "fingerBass",
      ),
      drumPart("kit", hits, { gain: 0.8, reverb: 0.12 }),
    ],
    { duration: 8 },
  );
  const first = await renderScore(score);
  const second = await renderScore(score);
  assert.equal(first.frames, 8 * SR);
  for (const track of TRACKS) {
    assert.ok(allFinite(first.stems[track]), `${track} finite`);
    assert.ok(rms(first.stems[track][0]) > 1e-4, `${track} audible`);
    assert.deepEqual(
      second.stems[track][0],
      first.stems[track][0],
      `${track} repeatable`,
    );
    assert.deepEqual(second.stems[track][1], first.stems[track][1]);
  }
  const measured = measureMix(first.stems);
  assert.ok(
    Math.abs(measured.lufs + 16) < 0.7,
    `${measured.lufs.toFixed(2)} LUFS`,
  );
  assert.ok(measured.peak <= LIMITER_CEILING * 1.03);
  assert.ok(measured.clippedRatio < 0.01);
  const [left, right] = mixDown(first);
  assert.ok(
    peakOf(left.map(softClip)) < CEILING &&
      peakOf(right.map(softClip)) < CEILING,
  );
  // stereo image: clearly not mono, clearly not out of phase
  const image = correlation(left, right);
  assert.ok(
    image > 0.3 && image < 0.995,
    `left/right correlation ${image.toFixed(3)}`,
  );
  // the kick on the downbeat is an onset, so only the step across the seam is judged
  for (const data of [left, right])
    assert.ok(seam(data).jump < 1.5, `seam step ${seam(data).jump.toFixed(2)}`);
});

/* ---------- engine finalisation: chokes, the last bass note, drum-bus glue, stereo guard ---------- */

/** Level (dB) of `data` over [from, to) seconds. */
function levelDb(data: Float32Array, from: number, to: number): number {
  let sum = 0;
  const a = Math.round(from * SR);
  const b = Math.round(to * SR);
  for (let i = a; i < b; i++) sum += data[i] * data[i];
  return 10 * Math.log10(sum / Math.max(1, b - a) + 1e-20);
}

/** A drum bank whose every hit is one second of steady tone, so what cuts it short is plain to see. */
const LONG_DRUMS: DrumVoice = {
  length: () => 1,
  render(left, right, frames, _kind, _kit, vel, ctx) {
    ctx.random();
    for (let i = 0; i < frames; i++) {
      const value =
        0.3 *
        vel *
        Math.min(1, i / 48) *
        Math.min(1, (frames - 1 - i) / 48) *
        Math.sin((2 * Math.PI * 500 * i) / ctx.sampleRate);
      left[i] += value;
      right[i] += value;
    }
  },
};

test("renderScore: a closing hat chokes the open one, a drum is one voice, cymbals ring on", async () => {
  const render = async (hits: DrumEvent[], loop = false) => {
    const score = makeScore([drumPart("kit", hits, { gain: 1, reverb: 0 })], {
      loop,
      duration: 2,
    });
    return (
      await renderScoreWith(
        score,
        { voices: TEST_VOICES, drums: LONG_DRUMS },
        { master: false },
      )
    ).stems.drums[0];
  };
  // an open hat alone rings for its whole second
  const open = await render([{ t: 0, kind: "hatOpen", vel: 0.8 }]);
  assert.ok(levelDb(open, 0.6, 0.9) > -25, "the open hat rings");
  // a closed hat 0.3 s later silences it within 20 ms; before that nothing changes
  const choked = await render([
    { t: 0, kind: "hatOpen", vel: 0.8 },
    { t: 0.3, kind: "hatClosed", vel: 0.001 },
  ]);
  for (let i = 0; i < Math.round(0.3 * SR); i++)
    assert.equal(choked[i], open[i]);
  assert.ok(
    levelDb(choked, 0.33, 0.9) < levelDb(open, 0.33, 0.9) - 40,
    "the open hat stops when the hat closes",
  );
  // a kick takes over from the kick before it, a tom from the same tom only
  const kicks = await render([
    { t: 0, kind: "kick", vel: 0.8 },
    { t: 0.5, kind: "kick", vel: 0.001 },
  ]);
  assert.ok(
    levelDb(kicks, 0.55, 0.95) < -60,
    "a new kick stroke ends the ring of the last one",
  );
  const toms = await render([
    { t: 0, kind: "tomLow", vel: 0.8 },
    { t: 0.5, kind: "tomHigh", vel: 0.001 },
  ]);
  assert.ok(
    levelDb(toms, 0.55, 0.95) > -25,
    "another drum does not choke this one",
  );
  // cymbals and snares are never choked
  for (const kind of ["crash", "ride", "snare", "gong"] as const) {
    const twice = await render([
      { t: 0, kind, vel: 0.8 },
      { t: 0.5, kind, vel: 0.001 },
    ]);
    assert.ok(
      levelDb(twice, 0.55, 0.95) > -25,
      `${kind} rings through the next stroke`,
    );
  }
  // strokes that land together are one stroke, and in a loop the first hat of the bar closes the last open one
  const flam = await render([
    { t: 0, kind: "kick", vel: 0.8 },
    // (three whole cycles of the test tone later, so the two strokes add up)
    { t: 0.006, kind: "kick", vel: 0.8 },
  ]);
  assert.ok(levelDb(flam, 0.5, 0.9) > -25, "a flam is not a choke");
  const wrapped = await render(
    [
      { t: 0.2, kind: "hatClosed", vel: 0.001 },
      { t: 1.5, kind: "hatOpen", vel: 0.8 },
    ],
    true,
  );
  assert.ok(
    levelDb(wrapped, 0.25, 0.45) < -60,
    "the tail of the open hat does not wrap past the closing hat",
  );
});

test("renderScore: the last bass note of a piece that ends rings out; in a loop and elsewhere nothing changes", async () => {
  const bank = {
    ...TEST_VOICES,
    subBass: toneVoice("subBass", 0.05),
  } as VoiceBank;
  const parts = (): Part[] => [
    notePart("lead", "melody", [{ t: 0, d: 2, midi: 72, vel: 0.7 }], {
      reverb: 0,
    }),
    {
      ...notePart(
        "bass",
        "bass",
        [
          { t: 0, d: 0.9, midi: 36, vel: 0.8 },
          { t: 1, d: 1, midi: 36, vel: 0.8 },
        ],
        { reverb: 0, gain: 1 },
        "subBass",
      ),
      role: "bass",
    } as Part,
  ];
  const banks = { voices: bank, drums: TEST_DRUMS };
  const song = (
    await renderScoreWith(
      makeScore(parts(), { loop: false, duration: 5 }),
      banks,
      { master: false },
    )
  ).stems.bass[0];
  // the first note is released as ever (0.05 s tail) …
  assert.ok(levelDb(song, 0.96, 0.99) < -80, "an inner bass note is not held");
  // … the last one fades for more than a second: about -13 dB after 0.3 s, -43 dB after 1 s
  const held = levelDb(song, 1.5, 1.9);
  const after = (seconds: number) =>
    levelDb(song, 2 + seconds - 0.02, 2 + seconds + 0.02) - held;
  assert.ok(
    after(0.3) < -9 && after(0.3) > -17,
    `0.3 s after the release: ${after(0.3).toFixed(1)} dB`,
  );
  assert.ok(
    after(1) < -35 && after(1) > -50,
    `1 s after the release: ${after(1).toFixed(1)} dB`,
  );
  assert.ok(levelDb(song, 3.6, 4.9) < -100, "silent well before the end");
  // a loop has no last note
  const loop = (
    await renderScoreWith(
      makeScore(parts(), { loop: true, duration: 5 }),
      banks,
      { master: false },
    )
  ).stems.bass[0];
  assert.ok(levelDb(loop, 2.1, 2.5) < -80, "no ring in a loop");
});

test("master: the drum-bus glue lowers the peaks of the kit at the same energy, by character and density", async () => {
  const build = () => {
    const stems = emptyStems(SR * 8);
    fillNoise(stems.chords, 3, 0.2);
    const random = createRng(5);
    // a kick on every beat (loud tip, long body), hats in between
    for (let beat = 0; beat < 16; beat++) {
      const at = beat * 24000;
      for (let i = 0; i < 12000; i++) {
        const t = i / SR;
        const value =
          (0.9 * Math.exp(-t / 0.004) + 0.3 * Math.exp(-t / 0.09)) *
          Math.sin(2 * Math.PI * (50 + 80 * Math.exp(-t / 0.02)) * t) *
          Math.min(1, i / 16);
        stems.drums[0][at + i] += value;
        stems.drums[1][at + i] += value;
      }
      for (let i = 0; i < 1500; i++) {
        const value = 0.08 * (random() * 2 - 1) * Math.exp(-i / 300);
        stems.drums[0][at + 12000 + i] += value;
        stems.drums[1][at + 12000 + i] += value;
      }
    }
    return stems;
  };
  const meanSquare = (data: Float32Array) => {
    let sum = 0;
    for (const value of data) sum += value * value;
    return sum / data.length;
  };
  const crest = (stem: StereoPcm) => {
    let peak = 0;
    for (const value of stem[0]) peak = Math.max(peak, Math.abs(value));
    return db(peak / Math.sqrt(meanSquare(stem[0])));
  };
  const run = async (settings: Partial<MasterSettings>, loop = false) => {
    const stems = build();
    const report = await masterStems(
      stems,
      { ...SETTINGS, ...settings },
      { sampleRate: SR, loop },
    );
    return {
      stems,
      report,
      crest: crest(stems.drums),
      drumsOverChords: db(
        Math.sqrt(meanSquare(stems.drums[0]) / meanSquare(stems.chords[0])),
      ),
    };
  };
  const off = await run({ density: 0 });
  assert.equal(off.report.glue, undefined);
  assert.equal(off.report.limiter.ceiling, LIMITER_CEILING);
  const clean = await run({});
  const punchy = await run({ character: "punchy" });
  const full = await run({ density: 1 });
  for (const [name, result] of [
    ["clean", clean],
    ["punchy", punchy],
    ["density 1", full],
  ] as const) {
    const glue = result.report.glue;
    assert.ok(glue, `${name}: glue ran`);
    assert.ok(
      glue.maxReductionDb > 1.5 && glue.maxReductionDb < 9,
      `${name}: holds strokes ${glue.maxReductionDb.toFixed(1)} dB`,
    );
    // the energy the glue took comes back as gain, so the kit keeps its place against the other stems
    // (what little it loses is the limiter working on the strokes under the lower ceiling)
    assert.ok(
      glue.makeupDb > 0.3 && glue.makeupDb < glue.maxReductionDb,
      `${name}: make-up ${glue.makeupDb.toFixed(2)} dB`,
    );
    assert.ok(
      Math.abs(result.drumsOverChords - off.drumsOverChords) < 2.5,
      `${name}: drums moved ${(result.drumsOverChords - off.drumsOverChords).toFixed(2)} dB against the chords`,
    );
    // … and has lost crest
    assert.ok(
      result.crest < off.crest - 0.5,
      `${name}: crest ${result.crest.toFixed(1)} against ${off.crest.toFixed(1)} dB`,
    );
    assert.ok(
      Math.abs(result.report.lufs - -16) < 0.3,
      `${name}: ${result.report.lufs} LUFS`,
    );
    // the lowered ceiling never costs loudness
    assert.equal(result.report.shortfallLu, 0);
  }
  // a denser character holds harder, and asks for a lower limiter ceiling
  assert.ok(punchy.report.glue!.depthDb > clean.report.glue!.depthDb);
  assert.ok(full.crest < clean.crest - 0.5, "more density, less crest");
  assert.ok(
    punchy.report.limiter.ceiling < LIMITER_CEILING &&
      punchy.report.limiter.ceiling <= clean.report.limiter.ceiling + 1e-9,
  );
  // a loop stays a loop: the gain of the glue is continuous across the seam
  const looped = await run({ character: "punchy" }, true);
  const bed = looped.stems.chords[0];
  assert.ok(Math.abs(levelDb(bed, 0, 0.03) - levelDb(bed, 8 - 0.03, 8)) < 3);
  assert.ok(seam(looped.stems.drums[0]).jump < 1.5);
});

test("master: a stem with unrelated channels is narrowed to the correlation floor, others are left alone", async () => {
  const correlation = (stem: StereoPcm) => {
    let lr = 0;
    let ll = 0;
    let rr = 0;
    for (let i = 0; i < stem[0].length; i++) {
      lr += stem[0][i] * stem[1][i];
      ll += stem[0][i] * stem[0][i];
      rr += stem[1][i] * stem[1][i];
    }
    return lr / Math.sqrt(ll * rr);
  };
  const frames = SR * 4;
  const stems = emptyStems(frames);
  // chords: two unrelated noises (correlation 0); melody: mostly shared (about 0.8); bass: a tone in anti-phase
  const one = emptyStems(frames).melody;
  fillNoise(one, 11, 0.1);
  const two = emptyStems(frames).melody;
  fillNoise(two, 12, 0.1);
  for (let i = 0; i < frames; i++) {
    stems.chords[0][i] = one[0][i];
    stems.chords[1][i] = two[0][i];
    stems.melody[0][i] = one[0][i] + 0.35 * two[0][i];
    stems.melody[1][i] = one[0][i] - 0.35 * two[0][i];
    const tone = 0.1 * Math.sin((2 * Math.PI * 700 * i) / SR);
    stems.bass[0][i] = tone + 0.02 * one[0][i];
    stems.bass[1][i] = -tone + 0.02 * one[0][i];
  }
  const before = correlation(stems.melody);
  const report = await masterStems(stems, SETTINGS, {
    sampleRate: SR,
    loop: false,
  });
  assert.ok(
    Math.abs(correlation(stems.chords) - MIN_STEM_CORRELATION) < 0.02,
    `chords now ${correlation(stems.chords).toFixed(3)}`,
  );
  assert.ok(
    Math.abs(correlation(stems.bass) - MIN_STEM_CORRELATION) < 0.02,
    `bass now ${correlation(stems.bass).toFixed(3)}`,
  );
  assert.ok(
    Math.abs(correlation(stems.melody) - before) < 0.02,
    "a healthy stem keeps its width",
  );
  const narrowed = report.narrowed ?? {};
  assert.ok(
    (narrowed.chords ?? 1) < 1 &&
      (narrowed.bass ?? 1) < (narrowed.chords ?? 1) &&
      narrowed.melody === undefined,
    JSON.stringify(narrowed),
  );
});
