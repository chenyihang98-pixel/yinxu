/**
 * Structural check of a Score: every rule the synthesizer and the UI rely on,
 * whatever the style or the settings. Returns the problems found (an empty
 * list means the Score is sound); it never throws. The tests run it over
 * every style, and it is cheap enough to call before a render in development.
 */
import type { MusicConfig } from "../types";
import { parseKey } from "./catalog";
import {
  DRUM_KINDS,
  DRUM_KITS,
  SAMPLE_RATE,
  VOICE_IDS,
  type PartRole,
  type Score,
  type TrackName,
} from "./score";
import { VOICE_RANGES } from "./theory";

const ROLE_TRACK: Record<PartRole, TrackName> = {
  lead: "melody",
  counter: "melody",
  arp: "melody",
  comp: "chords",
  pad: "chords",
  bass: "bass",
  kit: "drums",
  perc: "drums",
};

const HAN = /[一-鿿]/;

/**
 * Problems with `score`. With `config` (as passed through clampConfig) the
 * identity fields — style, lead, seed, loop flag and key — are checked too.
 */
export function scoreProblems(score: Score, config?: MusicConfig): string[] {
  const problems: string[] = [];
  const fail = (message: string) => {
    if (problems.length < 40) problems.push(message);
  };
  if (score.version !== 2) fail("version");
  if (score.sampleRate !== SAMPLE_RATE) fail("sample rate");
  if (!(score.bpm > 0 && Number.isFinite(score.bpm))) fail("bpm");
  if (!(score.duration > 0 && Number.isFinite(score.duration))) fail("duration");
  if (score.beatsPerBar !== 4) fail("meter");
  if (!(score.swing >= 0 && score.swing <= 0.66)) fail("swing range");
  if (!(score.bars >= 1 && Number.isInteger(score.bars))) fail("bars");
  const barSeconds = (60 / score.bpm) * score.beatsPerBar;

  if (config) {
    if (score.style !== config.mood || score.lead !== config.instrument || score.seed !== config.seed)
      fail("identity fields");
    if (score.loop !== config.loop) fail("loop flag");
    const parsed = parseKey(config.key);
    if (score.key.tonic !== parsed.tonic || score.key.minor !== parsed.minor) fail("key");
  }
  if (score.key.scale[0] !== score.key.tonic || score.key.scale.length < 5) fail("scale");
  if (new Set(score.key.scale).size !== score.key.scale.length) fail("scale repeats a pitch class");

  // sections: contiguous, covering, labelled
  let bar = 0;
  let time = 0;
  score.sections.forEach((section, index) => {
    if (section.startBar !== bar)
      fail(`section ${index} starts at bar ${section.startBar}, expected ${bar}`);
    if (!(section.bars >= 1 && Number.isInteger(section.bars))) fail(`section ${index} bars`);
    if (Math.abs(section.start - time) > 1e-6) fail(`section ${index} start time`);
    if (!(section.end > section.start)) fail(`section ${index} is empty`);
    if (!(section.energy >= 0 && section.energy <= 1)) fail(`section ${index} energy`);
    if (!HAN.test(section.label)) fail(`section ${index} label "${section.label}"`);
    bar += section.bars;
    time = section.end;
  });
  if (!score.sections.length) fail("no sections");
  if (bar !== score.bars) fail(`sections cover ${bar} bars of ${score.bars}`);
  if (Math.abs(time - score.duration) > 1e-6) fail("sections do not reach the end");

  // chords: contiguous, covering, well formed
  if (!score.chords.length) fail("no chords");
  let chordTime = 0;
  for (const chord of score.chords) {
    if (Math.abs(chord.start - chordTime) > 1e-6) fail(`chord gap at ${chord.start}`);
    if (!(chord.end > chord.start)) fail(`empty chord span at ${chord.start}`);
    if (chord.pitchClasses[0] !== chord.root) fail(`chord ${chord.symbol} root is not first`);
    if (chord.pitchClasses.some((value) => value < 0 || value > 11 || !Number.isInteger(value)))
      fail(`chord ${chord.symbol} pitch classes`);
    if (!chord.symbol || !chord.roman) fail("chord without a name");
    if (chord.bar !== Math.floor(chord.start / barSeconds + 1e-6))
      fail(`chord ${chord.symbol} bar index`);
    chordTime = chord.end;
  }
  if (Math.abs(chordTime - score.duration) > 1e-6) fail("chords do not reach the end");

  // parts
  const ids = new Set<string>();
  // a piece that ends leaves at least 1.45 s of tail after its last note
  const lastStart = score.loop ? score.duration : score.duration - 0.4;
  const lastEnd = score.loop ? score.duration : score.duration - 1.45;
  let lead = 0;
  for (const part of score.parts) {
    if (ids.has(part.id)) fail(`duplicate part id ${part.id}`);
    ids.add(part.id);
    if (part.track !== ROLE_TRACK[part.role]) fail(`${part.id} is on track ${part.track}`);
    const mix = part.mix;
    for (const value of Object.values(mix))
      if (!Number.isFinite(value)) fail(`${part.id} mix has a non-finite value`);
    if (mix.pan < -1 || mix.pan > 1 || mix.gain <= 0 || mix.width < 0 || mix.width > 1.5)
      fail(`${part.id} mix out of range`);
    for (const value of [mix.reverb, mix.delay, mix.chorus, mix.drive, mix.duck])
      if (value < 0 || value > 1) fail(`${part.id} mix send out of range`);
    if (part.kind === "notes") {
      if (part.role === "lead") {
        lead++;
        if (part.voice !== score.lead) fail("lead is not the chosen instrument");
      }
      if (!(VOICE_IDS as readonly string[]).includes(part.voice)) {
        fail(`unknown voice ${part.voice}`);
        continue;
      }
      if (!part.notes.length) fail(`${part.id} is empty`);
      const [low, high] = VOICE_RANGES[part.voice];
      const sounding = new Map<number, number>();
      let previous = -1;
      for (const note of part.notes) {
        if (!(note.t >= 0) || !(note.t < lastStart)) fail(`${part.id} note starts at ${note.t}`);
        if (!(note.d > 0)) fail(`${part.id} note has no length`);
        if (!(note.vel > 0 && note.vel <= 1)) fail(`${part.id} velocity ${note.vel}`);
        if (!(note.midi >= low && note.midi <= high))
          fail(`${part.id} (${part.voice}) plays ${note.midi}, outside ${low}..${high}`);
        if (note.t + note.d > lastEnd + 1e-6) fail(`${part.id} note runs to ${note.t + note.d}`);
        if (note.t < previous) fail(`${part.id} notes are not sorted`);
        if (note.bend !== undefined && !(Math.abs(note.bend) <= 12)) fail(`${part.id} bend`);
        previous = note.t;
        const busyUntil = sounding.get(note.midi);
        if (busyUntil !== undefined && busyUntil > note.t + 1e-6)
          fail(`${part.id} overlaps itself on pitch ${note.midi} at ${note.t}`);
        sounding.set(note.midi, note.t + note.d);
      }
    } else {
      if (!(DRUM_KITS as readonly string[]).includes(part.kit)) fail(`unknown kit ${part.kit}`);
      if (!part.hits.length) fail(`${part.id} is empty`);
      let previous = -1;
      for (const hit of part.hits) {
        if (!(DRUM_KINDS as readonly string[]).includes(hit.kind)) fail(`unknown drum ${hit.kind}`);
        if (!(hit.t >= 0) || !(hit.t < lastStart)) fail(`${part.id} hit at ${hit.t}`);
        if (!(hit.vel > 0 && hit.vel <= 1)) fail(`${part.id} hit velocity ${hit.vel}`);
        if (hit.t < previous) fail(`${part.id} hits are not sorted`);
        previous = hit.t;
      }
    }
  }
  if (lead !== 1) fail(`${lead} lead parts`);

  // space / master
  for (const value of Object.values(score.space))
    if (!Number.isFinite(value) || value < 0) fail("space settings");
  if (score.space.level > 1 || score.space.size > 1 || score.space.delayFeedback > 0.8)
    fail("space range");
  if (score.master.targetLufs !== -16 || score.master.ceilingDb !== -1) fail("master targets");

  // notes for the user
  if (score.notes.length < 3 || score.notes.length > 6) fail(`${score.notes.length} notes`);
  for (const line of score.notes)
    if (!HAN.test(line) || line.length > 200) fail(`note "${line}"`);
  if (!HAN.test(score.key.label)) fail(`key label "${score.key.label}"`);
  return problems;
}
