// What a render holds in memory, and what it leaves behind (review finding ENG-3).
//
// These checks read the ArrayBuffer memory of the whole process, so they have a
// test file — a process — of their own: nothing else has rendered here before.
import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PART_MIX, TRACKS } from "../src/music/score";
import type {
  DrumEvent,
  NoteEvent,
  Part,
  PartMix,
  Score,
} from "../src/music/score";
import { freeBuffer, renderScoreWith } from "../src/audio/render";
import type { RenderReport } from "../src/audio/render";
import type { RenderedAudio } from "../src/audio/render-types";
import { VOICES } from "../src/audio/voices";
import { DRUMS } from "../src/audio/drums";
import {
  SCRATCH_KEEP,
  scratch,
  scratchBytes,
  trimScratch,
} from "../src/audio/dsp";

const SR = 48000;
const MB = 1024 * 1024;
const BANKS = { voices: VOICES, drums: DRUMS };
const mb = (bytes: number) => `${(bytes / MB).toFixed(1)} MB`;
const held = () => process.memoryUsage().arrayBuffers;
const mix = (extra: Partial<PartMix> = {}): PartMix => ({
  ...DEFAULT_PART_MIX,
  ...extra,
});

/**
 * A piece with what makes a render need memory beyond its full-length buffers:
 * a drone as long as the piece (the pad voice works in three buffers of the
 * note's length, the mixer in a scratch pair of it), ordinary short notes, a
 * ducking kick, a reverb and a delay.
 */
function droneScore(seconds: number, loop: boolean): Score {
  const lead: NoteEvent[] = [];
  const hits: DrumEvent[] = [];
  for (let t = 0; t < seconds - 1; t += 0.5) {
    lead.push({ t, d: 0.4, midi: 60 + ((t * 2) % 7), vel: 0.7 });
    hits.push({ t, kind: "kick", vel: 0.9 });
    hits.push({ t: t + 0.25, kind: "hatClosed", vel: 0.5 });
  }
  const parts: Part[] = [
    {
      kind: "notes",
      id: "lead",
      track: "melody",
      role: "lead",
      voice: "piano",
      mix: mix({ reverb: 0.4, delay: 0.3 }),
      notes: lead,
    },
    // an eight-second note first: the drone outgrows the buffers it left
    {
      kind: "notes",
      id: "drone",
      track: "chords",
      role: "pad",
      voice: "airpad",
      mix: mix({ reverb: 0.5, duck: 0.4 }),
      notes: [
        { t: 0, d: 8, midi: 52, vel: 0.6 },
        { t: 0, d: seconds, midi: 45, vel: 0.6 },
      ],
    },
    {
      kind: "notes",
      id: "bass",
      track: "bass",
      role: "bass",
      voice: "subBass",
      mix: mix({ width: 0, reverb: 0 }),
      notes: lead.map((note) => ({ ...note, midi: 36 })),
    },
    {
      kind: "drums",
      id: "kit",
      track: "drums",
      role: "kit",
      kit: "pop",
      mix: mix({ reverb: 0.2 }),
      hits,
    },
  ];
  return {
    version: 2,
    style: "ambient",
    lead: "piano",
    seed: 31,
    sampleRate: SR,
    bpm: 120,
    beatsPerBar: 4,
    bars: Math.round(seconds / 2),
    duration: seconds,
    loop,
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
      size: 0.6,
      decay: 2.5,
      damping: 0.4,
      preDelay: 0.02,
      level: 0.6,
      delayTime: 0.375,
      delayFeedback: 0.4,
    },
    master: { targetLufs: -16, ceilingDb: -1, character: "warm", tilt: 0 },
    notes: [],
  };
}

/** No scratch slot is longer than what is kept between renders. */
function assertPoolTrimmed(label: string) {
  assert.ok(
    scratchBytes() <= 16 * (SCRATCH_KEEP + 1024) * 4,
    `${label}: the scratch pool holds ${mb(scratchBytes())}`,
  );
  for (let slot = 0; slot < 16; slot++)
    assert.ok(
      scratch(slot, 1).length <= SCRATCH_KEEP + 1024,
      `${label}: slot ${slot} is ${scratch(slot, 1).length} samples long`,
    );
}

test("a render reports the memory it really held at its peak, and leaves nothing behind but its stems", async () => {
  const seconds = 40;
  const frames = seconds * SR;
  const stemBytes = 8 * frames * 4;
  for (const loop of [true, false]) {
    const label = loop ? "loop" : "one-shot";
    const before = held();
    let peak = 0;
    let report: RenderReport | undefined;
    let audio: RenderedAudio | null = await renderScoreWith(
      droneScore(seconds, loop),
      BANKS,
      {
        paceMs: 0,
        onProgress: () => {
          peak = Math.max(peak, held() - before);
        },
        onReport: (value) => (report = value),
      },
    );
    assert.ok(report);

    // the report: 4 stems + part bus + reverb send (stereo) + delay send (mono), as before …
    assert.equal(report.fullLengthStereoBuffers, 6.5);
    const fullLength = 13 * frames * 4;
    // … and what the note needed on top of them: the mixer's scratch pair and the three work buffers of the pad
    // voice, each as long as the drone (the finding: these 5 × 7.7 MB were neither counted nor given back)
    const droneBytes = seconds * SR * 4;
    assert.ok(
      report.bufferBytes >= fullLength + 5 * droneBytes,
      `${label}: reported ${mb(report.bufferBytes)}, full-length buffers alone are ${mb(fullLength)}`,
    );
    // the process agrees: it never held noticeably more than the report says (uncounted: block buffers, delay
    // lines, garbage of the voices), nor noticeably less
    assert.ok(
      peak <= report.bufferBytes * 1.05 + 6 * MB,
      `${label}: the process held ${mb(peak)} at its peak, the report says ${mb(report.bufferBytes)}`,
    );
    assert.ok(
      peak >= report.bufferBytes * 0.93,
      `${label}: the report says ${mb(report.bufferBytes)}, the process only ever held ${mb(peak)}`,
    );

    // back from the render, with no garbage collection asked for: only the stems are left
    const lingering = held() - before - stemBytes;
    assert.ok(
      lingering < 10 * MB,
      `${label}: ${mb(lingering)} of work memory are still allocated after the render`,
    );
    assertPoolTrimmed(label);
    // and once the stems have been handed over (the engine frees each channel as it copies it), nothing is
    for (const track of TRACKS)
      for (const channel of audio.stems[track]) freeBuffer(channel);
    audio = null;
    assert.ok(
      held() - before < 10 * MB,
      `${label}: ${mb(held() - before)} left after the stems were freed`,
    );
  }
});

test("a cancelled or failed render gives everything back at once, stems included", async () => {
  const seconds = 40;
  const before = held();
  let calls = 0;
  let seen = 0;
  await assert.rejects(
    renderScoreWith(droneScore(seconds, true), BANKS, {
      paceMs: 0,
      onProgress: (fraction) => (seen = fraction),
      checkpoint: async () => {
        // well into the mixing: the drone has been rendered, the sends are filled
        if (seen > 0.5 && ++calls > 3)
          throw new DOMException("已取消生成", "AbortError");
      },
    }),
    { name: "AbortError" },
  );
  assert.ok(seen > 0.5 && seen < 1, `cancelled at ${seen}`);
  assert.ok(
    held() - before < 10 * MB,
    `${mb(held() - before)} still allocated after a cancelled render`,
  );
  assertPoolTrimmed("cancelled");

  // a voice that fails (non-finite audio) ends the render the same way
  const broken = droneScore(seconds, false);
  const failing = renderScoreWith(broken, {
    voices: {
      ...VOICES,
      piano: {
        id: "piano",
        tail: () => 0.1,
        render: (left) => {
          left[0] = NaN;
        },
      },
    },
    drums: DRUMS,
  });
  await assert.rejects(failing, /non-finite/);
  assert.ok(
    held() - before < 10 * MB,
    `${mb(held() - before)} still allocated after a failed render`,
  );
});

test("the scratch pool keeps short slots, gives long ones back, and counts what it holds", () => {
  trimScratch();
  // a short note: the slot grows with room to spare and is kept
  const short = scratch(3, 48000);
  assert.ok(short.length >= 48000 && short.length <= SCRATCH_KEEP + 1024);
  short.fill(1, 0, 48000);
  assert.equal(trimScratch(), 0, "nothing long to give back");
  const sameSlot = scratch(3, 40000);
  assert.equal(sameSlot, short, "a kept slot is reused");
  assert.ok(
    sameSlot.subarray(0, 40000).every((value) => value === 0),
    "and handed out zeroed",
  );
  const counted = scratchBytes();

  // a long note: exactly what it needs (plus the fixed margin), and on the books
  const frames = 3 * SCRATCH_KEEP;
  const long = scratch(3, frames);
  assert.equal(
    long.length,
    frames + 1024,
    "no growth factor on top of a long note",
  );
  assert.equal(scratchBytes(), counted - short.byteLength + long.byteLength);
  assert.ok(
    short.length > 0,
    "an outgrown short slot is left to the collector: somebody may still read it",
  );
  // outgrown in its turn, it goes back at once
  const longer = scratch(3, frames + 5000);
  assert.equal(long.length, 0, "a long slot that is outgrown is detached");
  assert.equal(scratchBytes(), counted - short.byteLength + longer.byteLength);

  // between renders the long slots are given back, the short ones stay
  const kept = scratch(4, 1000);
  const longBytes = longer.byteLength;
  const beforeTrim = scratchBytes();
  assert.equal(trimScratch(), longBytes);
  assert.equal(
    longer.length,
    0,
    "detached: its memory is back with the system",
  );
  assert.equal(scratchBytes(), beforeTrim - longBytes, "and off the books");
  assert.equal(scratch(4, 500), kept);
  const fresh = scratch(3, 100);
  assert.ok(fresh.length >= 100 && fresh.every((value) => value === 0));
});
