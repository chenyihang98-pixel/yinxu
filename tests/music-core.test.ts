import assert from "node:assert/strict";
import test from "node:test";
import {
  INSTRUMENT_IDS,
  KEYS,
  STYLE_IDS,
  parseKey,
  type InstrumentId,
  type StyleId,
} from "../src/music/catalog";
import { MAX_PART_GAIN, compose, summarize } from "../src/music/compose";
import { DEFAULT_CONFIG, ROMAN, stylePreset } from "../src/music/defaults";
import { hashSeed, seededRandom } from "../src/music/random";
import {
  DRUM_KINDS,
  DRUM_KITS,
  VOICE_IDS,
  type DrumPart,
  type NotePart,
  type Part,
  type Score,
} from "../src/music/score";
import { STYLE_DEFS, getStyle } from "../src/music/styles";
import type { Groove, Progression, StyleDef } from "../src/music/styles/types";
import {
  LEAD_TRAITS,
  makeKey,
  parseRoman,
  parseSteps,
  splitBar,
  voiceChord,
} from "../src/music/theory";
import { scoreProblems } from "../src/music/validate";
import type { MusicConfig } from "../src/types";

const IMPLEMENTED = Object.keys(STYLE_DEFS) as StyleId[];
const pc = (midi: number) => ((Math.round(midi) % 12) + 12) % 12;

function config(style: StyleId, overrides: Partial<MusicConfig> = {}): MusicConfig {
  return { ...DEFAULT_CONFIG, ...stylePreset(style), ...overrides };
}
const noteParts = (score: Score) =>
  score.parts.filter((part): part is NotePart => part.kind === "notes");
const drumParts = (score: Score) =>
  score.parts.filter((part): part is DrumPart => part.kind === "drums");
const leadOf = (score: Score) => noteParts(score).find((part) => part.role === "lead");
const eventCount = (score: Score) =>
  score.parts.reduce(
    (sum, part) => sum + (part.kind === "notes" ? part.notes.length : part.hits.length),
    0,
  );

/** Every rule a Score must satisfy, whatever the style or settings (see src/music/validate.ts). */
function assertValid(score: Score, cfg: MusicConfig, label: string) {
  const problems = scoreProblems(score, cfg);
  if (problems.length) assert.fail(`${label}: ${problems.join("; ")}`);
}

/* ------------------------------------------------------------------ */

test("random: forks are reproducible and independent of how much the parent was used", () => {
  const a = seededRandom(7);
  const b = seededRandom(7);
  for (let i = 0; i < 50; i++) a.next();
  assert.equal(a.fork("melody").next(), b.fork("melody").next());
  assert.notEqual(a.fork("melody").next(), a.fork("drums").next());
  assert.notEqual(hashSeed(1, "x"), hashSeed(2, "x"));
  const rng = seededRandom(99);
  for (let i = 0; i < 200; i++) {
    const value = rng.next();
    assert.ok(value >= 0 && value < 1);
    const int = rng.int(3, 6);
    assert.ok(int >= 3 && int <= 6);
  }
  assert.equal(rng.weighted(["a", "b"], [0, 1]), "b");
  assert.deepEqual(seededRandom(5).shuffle([1, 2, 3, 4]), seededRandom(5).shuffle([1, 2, 3, 4]));
});

test("theory: roman numerals parse into the right chords in major and minor keys", () => {
  const c = makeKey("C major", "major");
  const a = makeKey("A minor", "naturalMinor");
  const f = makeKey("F major", "major");
  const chord = (roman: string, key = c) => {
    const parsed = parseRoman(roman, key);
    assert.ok(parsed, `${roman} should parse`);
    return parsed;
  };
  assert.equal(chord("I").symbol, "C");
  assert.equal(chord("vi7").symbol, "Am7");
  assert.equal(chord("IVmaj7").symbol, "Fmaj7");
  assert.equal(chord("bVII").symbol, "Bb");
  assert.equal(chord("V7/vi").symbol, "E7");
  assert.deepEqual(chord("V7/vi").pitchClasses, [4, 8, 11, 2]);
  assert.equal(chord("V/V").symbol, "D");
  assert.equal(chord("I/III").symbol, "C/E");
  assert.equal(chord("V/VII").symbol, "G/B");
  assert.equal(chord("IV/V").symbol, "F/G");
  assert.equal(chord("ii°").symbol, "Ddim");
  assert.equal(chord("viiø").symbol, "Bm7b5");
  assert.equal(chord("Vsus4").symbol, "Gsus4");
  assert.equal(chord("Iadd9").symbol, "Cadd9");
  assert.equal(chord("iv6").symbol, "Fm6");
  assert.equal(chord("#idim7").symbol, "C#dim7");
  assert.equal(chord("i", a).symbol, "Am");
  assert.equal(chord("VI", a).symbol, "F");
  assert.equal(chord("bVI", a).symbol, "F");
  assert.equal(chord("VII", a).symbol, "G");
  assert.equal(chord("III", a).symbol, "C");
  assert.equal(chord("V", a).symbol, "E");
  assert.equal(chord("vii°", a).symbol, "G#dim");
  assert.equal(chord("iiø", a).symbol, "Bm7b5");
  assert.equal(chord("V7/III", a).symbol, "G7");
  assert.equal(chord("IV", f).symbol, "Bb");
  assert.equal(chord("ii7", f).symbol, "Gm7");
  assert.equal(chord("V").fn, "D");
  assert.equal(chord("IV").fn, "S");
  assert.equal(chord("vi").fn, "T");
  assert.equal(parseRoman("H7", c), null);
  assert.equal(parseRoman("", c), null);
  // everything defaults.ROMAN accepts must parse
  for (const roman of ["I", "vi7", "IVmaj7", "bVII", "V7/vi", "ii°", "#iv°", "Imaj9", "iiø", "V9", "I6", "vm7", "IIIaug", "isus2", "bIIImaj7/V"]) {
    if (ROMAN.test(roman)) assert.ok(parseRoman(roman, c), roman);
  }
});

test("theory: every catalog key resolves and voicings stay inside their window", () => {
  for (const keyName of KEYS) {
    const minor = parseKey(keyName).minor;
    const key = makeKey(keyName, minor ? "naturalMinor" : "major");
    assert.equal(key.pcs.length, 7);
    assert.equal(key.pcs[0], key.tonic);
    let previous: number[] | undefined;
    for (const roman of minor ? ["i", "bVI", "bIII", "bVII", "iv7", "V7"] : ["I", "V", "vi", "IVmaj7", "ii9", "V7"]) {
      const chord = parseRoman(roman, key)!;
      const notes = voiceChord(chord, { style: "close", voices: 4, low: 50, high: 76, previous });
      assert.ok(notes.length >= 3, `${keyName} ${roman}`);
      for (const note of notes) {
        assert.ok(note >= 50 && note <= 76, `${keyName} ${roman} note ${note}`);
        assert.ok(chord.pitchClasses.includes(pc(note)), `${keyName} ${roman} plays a foreign note`);
      }
      if (previous && previous.length === notes.length) {
        const motion = notes.reduce((sum, note, i) => sum + Math.abs(note - previous![i]), 0);
        assert.ok(motion <= 20, `${keyName} ${roman} jumps ${motion} semitones`);
      }
      previous = notes;
    }
  }
});

test("styles: every definition is well formed (chords parse, rows are 16 or 32 steps, ids exist)", () => {
  const checkGroove = (groove: Groove, where: string) => {
    for (const [kind, row] of Object.entries(groove)) {
      assert.ok((DRUM_KINDS as readonly string[]).includes(kind), `${where}: drum ${kind}`);
      const text = row.replace(/[\s|]/g, "");
      assert.ok(text.length === 16 || text.length === 32, `${where}: ${kind} row "${row}" has ${text.length} steps`);
      assert.match(text, /^[.goxXr]+$/, `${where}: ${kind} row "${row}"`);
      assert.ok(parseSteps(row).hits.length > 0, `${where}: ${kind} row is silent`);
    }
  };
  const checkProgressions = (list: Progression[], keyName: string, scale: StyleDef["harmony"]["modes"]["major"][number]["scale"], where: string) => {
    const key = makeKey(keyName, scale);
    assert.ok(list.length > 0, `${where}: empty`);
    for (const progression of list) {
      assert.ok(progression.length > 0, `${where}: empty progression`);
      for (const bar of progression)
        for (const roman of splitBar(bar))
          assert.ok(parseRoman(roman, key), `${where}: "${roman}" does not parse`);
    }
  };
  for (const [id, style] of Object.entries(STYLE_DEFS) as [StyleId, StyleDef][]) {
    assert.equal(style.id, id);
    assert.ok(style.summary.length > 3);
    for (const tonality of ["major", "minor"] as const) {
      const keyName = tonality === "major" ? "C major" : "A minor";
      assert.ok(style.harmony.modes[tonality].length > 0, `${id} ${tonality} modes`);
      for (const mode of style.harmony.modes[tonality]) {
        for (const [section, list] of Object.entries(mode.bank))
          checkProgressions(list, keyName, mode.scale, `${id}/${tonality}/${section}`);
        checkProgressions(style.harmony.cadence[tonality], keyName, mode.scale, `${id}/${tonality}/cadence`);
        const key = makeKey(keyName, mode.scale);
        assert.ok(parseRoman(style.harmony.final[tonality], key), `${id} final ${tonality}`);
        assert.equal(parseRoman(style.harmony.final[tonality], key)!.root, key.tonic, `${id} must end on its tonic`);
        for (const bar of style.harmony.turnaround[tonality])
          for (const roman of splitBar(bar)) assert.ok(parseRoman(roman, key), `${id} turnaround ${roman}`);
      }
    }
    const voices = [style.comp?.voice, style.pad?.voice, style.arp?.voice, style.counter?.voice, style.bass?.voice]
      .flat()
      .filter((voice) => voice !== undefined);
    for (const voice of voices) assert.ok((VOICE_IDS as readonly string[]).includes(voice!), `${id}: voice ${voice}`);
    if (style.comp)
      for (const tier of ["low", "mid", "high"] as const) {
        assert.ok(style.comp.patterns[tier].length > 0, `${id} comp ${tier}`);
        for (const pattern of style.comp.patterns[tier])
          for (const row of Object.values(pattern.rows)) {
            const text = row.replace(/[\s|]/g, "");
            assert.ok(text.length === 16 || text.length === 32, `${id} comp row "${row}"`);
            assert.match(text, /^[.goxX-]+$/, `${id} comp row "${row}"`);
          }
      }
    if (style.drums) {
      assert.ok((DRUM_KITS as readonly string[]).includes(style.drums.kit));
      for (const tier of ["low", "mid", "high"] as const)
        style.drums.grooves[tier].forEach((groove, i) => checkGroove(groove, `${id} groove ${tier}[${i}]`));
      for (const size of ["light", "full"] as const)
        style.drums.fills?.[size].forEach((groove, i) => checkGroove(groove, `${id} fill ${size}[${i}]`));
    }
    style.perc?.grooves.forEach((groove, i) => checkGroove(groove, `${id} perc[${i}]`));
    assert.equal(style.master.targetLufs, -16);
    assert.equal(style.master.ceilingDb, -1);
    assert.ok(style.swing >= 0 && style.swing <= 0.66);
  }
  // every catalog style has a definition of its own
  for (const id of STYLE_IDS) {
    assert.ok(STYLE_DEFS[id], `${id} must have its own definition`);
    assert.equal(getStyle(id), STYLE_DEFS[id]);
  }
  assert.equal(Object.keys(STYLE_DEFS).length, STYLE_IDS.length);
});

test("compose is deterministic and the seed changes the melody", () => {
  for (const style of IMPLEMENTED) {
    for (const loop of [true, false]) {
      const cfg = config(style, { loop, duration: 45, seed: 20240607 });
      const first = compose(cfg);
      const second = compose(structuredClone(cfg));
      assert.deepEqual(first, second, `${style} loop=${loop}`);
      const other = compose({ ...cfg, seed: 20240608 });
      assert.notDeepEqual(leadOf(first)!.notes, leadOf(other)!.notes, `${style}: new seed, same melody`);
    }
  }
  // the input is never mutated
  const cfg = config("jazz", { arrangement: { progression: ["I", "vi", "ii", "V"], drums: "swing" } });
  const frozen = structuredClone(cfg);
  compose(cfg);
  assert.deepEqual(cfg, frozen);
});

test("faders never reach the composer; a drum-only change leaves the melody alone", () => {
  const base = config("bright", { loop: false, duration: 60 });
  const quiet = compose({ ...base, volumes: { melody: 0, chords: 0.1, bass: 1, drums: 0.3 } });
  assert.deepEqual(quiet, compose(base));
  const halftime = compose({ ...base, arrangement: { drums: "halftime" } });
  const straight = compose({ ...base, arrangement: { drums: "breakbeat" } });
  assert.deepEqual(leadOf(halftime)!.notes, leadOf(straight)!.notes);
  assert.notDeepEqual(
    drumParts(halftime).find((part) => part.role === "kit")!.hits,
    drumParts(straight).find((part) => part.role === "kit")!.hits,
  );
  assert.deepEqual(leadOf(halftime)!.notes, leadOf(compose(base))!.notes);
});

test("every style gives a valid Score across loop, length, energy, complexity, key and instrument", () => {
  let index = 0;
  let total = 0;
  const instrumentsSeen = new Set<InstrumentId>();
  const keysSeen = new Set<string>();
  for (const style of STYLE_IDS)
    for (const loop of [true, false])
      for (const duration of [15, 30, 60, 120])
        for (const energy of [0, 0.5, 1])
          for (const complexity of [0, 0.5, 1]) {
            index++;
            const instrument = INSTRUMENT_IDS[index % INSTRUMENT_IDS.length];
            const key = KEYS[(index * 5) % KEYS.length];
            const preset = stylePreset(style);
            const bpm = [preset.bpm, 50, 200, 97, 143][index % 5];
            const cfg = config(style, {
              loop,
              duration,
              energy,
              complexity,
              instrument,
              key,
              bpm,
              seed: 1000 + index * 7919,
              reverb: (index % 11) / 10,
            });
            const label = `${style} loop=${loop} ${duration}s e=${energy} c=${complexity} ${instrument} ${key} ${bpm}bpm seed=${cfg.seed}`;
            let score: Score;
            try {
              score = compose(cfg);
            } catch (error) {
              assert.fail(`${label}: compose threw ${(error as Error).stack}`);
            }
            assertValid(score, cfg, label);
            instrumentsSeen.add(instrument);
            keysSeen.add(key);
            total++;
          }
  assert.equal(instrumentsSeen.size, INSTRUMENT_IDS.length);
  assert.ok(keysSeen.size >= 6);
  assert.equal(total, STYLE_IDS.length * 2 * 4 * 3 * 3);
});

test("every lead instrument works with every implemented style and stays in its comfortable range", () => {
  for (const style of IMPLEMENTED)
    for (const instrument of INSTRUMENT_IDS)
      for (const loop of [true, false]) {
        const cfg = config(style, { instrument, loop, duration: 40, seed: 31337 });
        const score = compose(cfg);
        assertValid(score, cfg, `${style} with ${instrument}`);
        const lead = leadOf(score)!;
        assert.ok(lead.notes.length >= 4, `${style}/${instrument}: only ${lead.notes.length} lead notes`);
        const trait = LEAD_TRAITS[instrument];
        for (const note of lead.notes)
          assert.ok(
            note.midi >= trait.low && note.midi <= trait.high,
            `${style}/${instrument}: lead note ${note.midi} outside ${trait.low}..${trait.high}`,
          );
        if (trait.bend === 0) assert.ok(lead.notes.every((note) => note.bend === undefined));
      }
  // instruments that slide do so sparingly
  const slides = compose(config("acoustic", { instrument: "guzheng", loop: false, duration: 90, complexity: 0.8 }));
  const bent = leadOf(slides)!.notes.filter((note) => note.bend !== undefined).length;
  assert.ok(bent > 0, "guzheng should use a few slides");
  assert.ok(bent / leadOf(slides)!.notes.length < 0.4, "slides must stay an ornament");
});

test("loops: bars and tempo close the loop exactly", () => {
  for (const style of IMPLEMENTED)
    for (let bpm = 50; bpm <= 200; bpm += 7)
      for (const duration of [15, 22, 30, 45, 60, 77, 90, 120]) {
        const cfg = config(style, { loop: true, bpm, duration });
        const score = compose(cfg);
        const label = `${style} ${bpm}bpm ${duration}s`;
        assert.ok(Math.abs(score.duration - (score.bars * 240) / score.bpm) < 1e-6, `${label}: length is not whole bars`);
        // is there a multiple of four bars whose tempo is within 6 %?
        let fits = false;
        for (let bars = 4; bars <= 512; bars += 4)
          if (Math.abs((240 * bars) / duration / bpm - 1) <= 0.06) fits = true;
        if (fits) {
          assert.equal(score.bars % 4, 0, `${label}: ${score.bars} bars`);
          assert.equal(score.duration, duration, label);
          assert.ok(Math.abs(score.bpm / bpm - 1) <= 0.06 + 1e-9, `${label}: tempo moved to ${score.bpm}`);
        } else {
          assert.equal(score.bpm, bpm, label);
          assert.equal(score.bars % 2, 0, `${label}: ${score.bars} bars`);
          assert.ok(Math.abs(score.duration - duration) <= 240 / bpm + 1e-6, `${label}: ${score.duration}s`);
        }
        assert.ok(score.bars >= 2);
        // loops have no intro or outro
        for (const section of score.sections)
          assert.ok(section.type !== "intro" && section.type !== "outro", `${label}: ${section.type} in a loop`);
        // the user is told whenever tempo or length had to move
        const mentions = score.notes.some((line) => line.includes("为了无缝循环"));
        const changed = Math.abs(score.bpm - bpm) > 0.005 || Math.abs(score.duration - duration) > 0.005;
        assert.equal(mentions, changed, `${label}: tempo-fit note`);
      }
});

test("loops: the last bar turns around into bar 1", () => {
  for (const style of IMPLEMENTED) {
    if (style === "ambient") continue; // drifts on purpose, no dominant pull
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const cfg = config(style, { loop: true, duration: 30, seed, energy: 0.7 });
      const score = compose(cfg);
      const first = score.chords[0];
      const last = score.chords[score.chords.length - 1];
      const pull = (last.root - first.root + 12) % 12;
      // dominant, subtonic, leading tone, tritone substitute, or a plagal step home
      assert.ok(
        [7, 10, 11, 1, 5, 2].includes(pull),
        `${style} seed ${seed}: ${last.symbol} → ${first.symbol} does not lead home`,
      );
      assert.equal(last.bar, score.bars - 1);
      // drums mark the turnaround with a fill: the last bar differs from the bar before
      const kit = drumParts(score).find((part) => part.role === "kit");
      if (kit && score.bars >= 4) {
        const barSeconds = 240 / score.bpm;
        const pattern = (bar: number) =>
          kit.hits
            .filter((hit) => hit.t >= bar * barSeconds - 0.03 && hit.t < (bar + 1) * barSeconds - 0.03 && hit.kind !== "crash" && hit.kind !== "cymbalSwell" && hit.kind !== "subBoom")
            .map((hit) => `${hit.kind}@${Math.round((hit.t - bar * barSeconds) / (barSeconds / 16))}`)
            .sort()
            .join(",");
        assert.notEqual(pattern(score.bars - 1), pattern(score.bars - 3), `${style} seed ${seed}: no fill at the loop point`);
      }
    }
  }
});

test("non-loop pieces keep tempo and length and end with a cadence, a held tonic and a tail", () => {
  for (const style of IMPLEMENTED)
    for (const duration of [15, 20, 30, 45, 60, 90, 120])
      for (const bpm of [stylePreset(style).bpm, 60, 132, 180]) {
        const cfg = config(style, { loop: false, duration, bpm, seed: duration * 31 + bpm });
        const score = compose(cfg);
        const label = `${style} ${duration}s ${bpm}bpm`;
        assert.equal(score.duration, duration, label);
        assert.equal(score.bpm, bpm, label);
        const barSeconds = 240 / bpm;
        assert.equal(score.bars, Math.ceil(duration / barSeconds - 1e-9), label);
        const final = score.chords[score.chords.length - 1];
        assert.equal(final.root, score.key.tonic, `${label}: ends on ${final.symbol}`);
        assert.equal(final.end, duration);
        assert.ok(final.end - final.start >= 2.6, `${label}: final chord only ${final.end - final.start}s`);
        assert.ok(Math.abs(final.start / barSeconds - Math.round(final.start / barSeconds)) < 1e-6, `${label}: final chord off the downbeat`);
        // the chord before the tonic is not the tonic again (a real cadence)
        const before = score.chords[score.chords.length - 2];
        if (before) assert.notEqual(before.roman, final.roman, label);
        let latestEnd = 0;
        let latestStart = 0;
        let heldFromFinal = 0;
        for (const part of noteParts(score))
          for (const note of part.notes) {
            latestEnd = Math.max(latestEnd, note.t + note.d);
            latestStart = Math.max(latestStart, note.t);
            if (note.t >= final.start - 0.05 && note.t + note.d >= latestEnd - 1e-3) heldFromFinal++;
          }
        // everything is released 1.5–3 s before the end and nothing starts late
        assert.ok(duration - latestEnd >= 1.45 && duration - latestEnd <= 3.05, `${label}: tail of ${duration - latestEnd}s`);
        assert.ok(latestStart <= final.start + 0.2, `${label}: a note starts ${latestStart - final.start}s after the final chord`);
        assert.ok(heldFromFinal >= 1, `${label}: nothing holds the final chord`);
        for (const part of drumParts(score))
          for (const hit of part.hits) assert.ok(hit.t <= final.start + 0.06, `${label}: drum hit after the final chord`);
        // the melody comes home
        const lead = leadOf(score)!.notes;
        assert.equal(pc(lead[lead.length - 1].midi), score.key.tonic, `${label}: melody ends off the tonic`);
        assert.equal(score.sections[score.sections.length - 1].end, duration);
      }
});

test("form follows the length: short pieces are simple, long ones have a breakdown and a build", () => {
  const types = (duration: number, style: StyleId = "bright") =>
    compose(config(style, { loop: false, duration })).sections.map((section) => section.type);
  assert.deepEqual(types(30), ["intro", "verse", "chorus", "outro"]);
  assert.deepEqual(types(60), ["intro", "verse", "chorus", "verse", "outro"]);
  const long = types(120, "cinematic");
  assert.equal(long[0], "intro");
  assert.equal(long[long.length - 1], "outro");
  assert.ok(long.includes("breakdown") && long.includes("build"), long.join(" "));
  assert.ok(long.indexOf("build") === long.indexOf("breakdown") + 1);
  assert.equal(long[long.indexOf("build") + 1], "chorus");
  const short = types(15);
  assert.ok(short.length <= 3 && short[short.length - 1] === "outro", short.join(" "));
  // sections carry different energies and the chorus is the peak
  const score = compose(config("bright", { loop: false, duration: 60 }));
  const energyOf = (type: string) => Math.max(...score.sections.filter((s) => s.type === type).map((s) => s.energy));
  assert.ok(energyOf("chorus") > energyOf("verse"));
  assert.ok(energyOf("verse") > energyOf("intro"));
  // loop labels
  const loop = compose(config("bright", { loop: true, duration: 30, bpm: 128 }));
  assert.equal(loop.bars, 16);
  assert.deepEqual(
    loop.sections.map((section) => [section.label, section.type, section.bars]),
    [
      ["A 段", "verse", 8],
      ["B 段", "chorus", 8],
    ],
  );
  const aaba = compose(config("jazz", { loop: true, duration: 30, bpm: 128 }));
  assert.deepEqual(
    aaba.sections.map((section) => [section.label, section.bars]),
    [
      ["A 段", 8],
      ["B 段", 4],
      ["A 段", 4],
    ],
  );
  assert.ok(loop.sections.every((section) => /^[ABC] 段$/.test(section.label)));
  assert.ok(new Set(loop.sections.map((section) => section.label)).size >= 2);
});

test("melody: in the scale, mostly stepwise, leaps answered, one idea developed", () => {
  for (const style of IMPLEMENTED) {
    let steps = 0;
    let intervals = 0;
    let inScale = 0;
    let notes = 0;
    let wide = 0;
    for (let seed = 1; seed <= 12; seed++)
      for (const loop of [true, false]) {
        const score = compose(config(style, { loop, duration: 60, seed: seed * 104729 }));
        const lead = leadOf(score)!.notes;
        for (let i = 0; i < lead.length; i++) {
          notes++;
          if (score.key.scale.includes(pc(lead[i].midi))) inScale++;
          if (i === 0) continue;
          const distance = Math.abs(lead[i].midi - lead[i - 1].midi);
          // tremolo strokes re-strike one note; they are not melodic motion
          if (distance === 0 && lead[i].t - lead[i - 1].t < 0.17) continue;
          intervals++;
          // neighbours in a five-note scale may lie a minor third apart
          if (distance >= 1 && distance <= (score.key.scale.length < 7 ? 3 : 2)) steps++;
          if (distance > 12) wide++;
        }
      }
    const stepRatio = steps / intervals;
    assert.ok(inScale / notes >= 0.9, `${style}: only ${(inScale / notes).toFixed(2)} of the melody is in the scale`);
    // sparse styles (ambient bells, quiet piano) move more by chord tones
    const sparse = getStyle(style).melody.density < 0.3;
    assert.ok(stepRatio >= (sparse ? 0.28 : 0.48) && stepRatio <= 0.78, `${style}: stepwise share ${stepRatio.toFixed(2)}`);
    assert.ok(wide / intervals < 0.02, `${style}: ${wide} leaps wider than an octave`);
  }
  // the motif returns: the first two bars of both A phrases share their rhythm
  const score = compose(config("bright", { loop: true, duration: 30, bpm: 128, seed: 5 }));
  const barSeconds = 240 / score.bpm;
  const rhythm = (bar: number) =>
    leadOf(score)!
      .notes.filter((note) => note.t >= bar * barSeconds - 0.03 && note.t < (bar + 1) * barSeconds - 0.03)
      .map((note) => Math.round((note.t - bar * barSeconds) / (barSeconds / 16)))
      .join(",");
  assert.ok(rhythm(0).length > 0);
  assert.equal(rhythm(0), rhythm(4), "the second phrase should restate the motif rhythm");
});

test("energy is continuous: more of everything at 1 than at 0, and it never only changes volume", () => {
  for (const style of IMPLEMENTED)
    for (const loop of [true, false]) {
      const counts = [0, 0.25, 0.5, 0.75, 1].map((energy) =>
        eventCount(compose(config(style, { loop, duration: 60, energy, seed: 77 }))),
      );
      assert.ok(counts[4] > counts[0] * 1.3, `${style} loop=${loop}: ${counts.join(" → ")}`);
      assert.ok(counts[2] >= counts[0], `${style} loop=${loop}: ${counts.join(" → ")}`);
      assert.ok(counts[4] >= counts[2], `${style} loop=${loop}: ${counts.join(" → ")}`);
      const low = compose(config(style, { loop, duration: 60, energy: 0, seed: 77 }));
      const high = compose(config(style, { loop, duration: 60, energy: 1, seed: 77 }));
      assert.ok(high.parts.length >= low.parts.length, `${style}: layers at high energy`);
      const drumHits = (score: Score) => drumParts(score).reduce((sum, part) => sum + part.hits.length, 0);
      assert.ok(drumHits(high) >= drumHits(low), `${style}: drums at high energy`);
    }
  const layers = (energy: number) => compose(config("bright", { loop: false, duration: 60, energy })).parts.length;
  assert.ok(layers(1) > layers(0.1));
});

test("complexity adds harmonic colour and rhythmic detail", () => {
  /** average number of different notes per chord: 3 = triads, 4 = sevenths, 5 = ninths */
  const coloured = (score: Score) =>
    score.chords.reduce((sum, chord) => sum + chord.pitchClasses.length, 0) / score.chords.length;
  for (const style of ["bright", "cinematic", "acoustic", "focus", "retro", "dreamy"] as StyleId[]) {
    let plain = 0;
    let rich = 0;
    let fewNotes = 0;
    let manyNotes = 0;
    for (let seed = 1; seed <= 8; seed++) {
      const low = compose(config(style, { loop: true, duration: 60, complexity: 0, seed }));
      const high = compose(config(style, { loop: true, duration: 60, complexity: 1, seed }));
      plain += coloured(low);
      rich += coloured(high);
      fewNotes += leadOf(low)!.notes.length;
      manyNotes += leadOf(high)!.notes.length;
    }
    assert.ok(rich > plain + 1.5, `${style}: colour ${plain.toFixed(2)} → ${rich.toFixed(2)}`);
    assert.ok(manyNotes > fewNotes, `${style}: melody notes ${fewNotes} → ${manyNotes}`);
  }
});

test("reverb scales the space; other controls leave it alone", () => {
  for (const style of IMPLEMENTED) {
    const dry = compose(config(style, { reverb: 0 })).space;
    const preset = compose(config(style)).space;
    const wet = compose(config(style, { reverb: 1 })).space;
    assert.equal(dry.level, 0, style);
    assert.ok(preset.level > 0 && preset.level < wet.level + 1e-9, style);
    assert.ok(wet.size >= preset.size && preset.size >= dry.size, style);
    assert.ok(wet.level <= 1 && wet.size <= 1);
    assert.equal(preset.level, getStyle(style).space.level);
    // the delay is tempo-synced
    const score = compose(config(style, { loop: false }));
    assert.ok(Math.abs(score.space.delayTime - getStyle(style).space.delayBeats * (60 / score.bpm)) < 1e-4);
  }
});

test("hints: progression, form, drums, bass, swing, layers and melody shape are respected", () => {
  const base = config("bright", { loop: true, duration: 30, bpm: 128 });
  // progression override, one chord per bar, cycled
  const progression = ["vi", "IV", "I", "V"];
  const overridden = compose({ ...base, arrangement: { progression } });
  assert.equal(overridden.bars, 16);
  assert.deepEqual(
    overridden.chords.map((chord) => chord.roman),
    Array.from({ length: 16 }, (_, bar) => progression[bar % 4]),
  );
  assert.deepEqual(overridden.chords.slice(0, 4).map((chord) => chord.symbol), ["Am", "F", "C", "G"]);
  assert.ok(overridden.notes.some((line) => line.includes("vi – IV – I – V")));
  const sixteen = ["I", "V7/vi", "vi", "I7", "IV", "iv", "I/V", "V7", "bVI", "bVII", "I", "V/VII", "vi7", "ii7", "Vsus4", "V7"];
  const long = compose({ ...base, arrangement: { progression: sixteen } });
  assert.deepEqual(long.chords.map((chord) => chord.roman), sixteen);
  // a non-loop piece keeps the progression and still ends on the tonic
  const song = compose({ ...base, loop: false, duration: 40, arrangement: { progression } });
  const body = song.sections.find((section) => section.type !== "intro")!;
  const bodyChords = song.chords.filter((chord) => chord.bar >= body.startBar).slice(0, 4);
  assert.deepEqual(bodyChords.map((chord) => chord.roman), progression);
  assert.equal(song.chords[song.chords.length - 1].root, song.key.tonic);

  // explicit form
  const form = [
    { type: "verse" as const, bars: 8, energy: 0.4 },
    { type: "bridge" as const, bars: 4, energy: 0.6 },
    { type: "chorus" as const, bars: 4, energy: 1 },
  ];
  const formed = compose({ ...base, arrangement: { form } });
  assert.deepEqual(formed.sections.map((section) => [section.type, section.bars]), [["verse", 8], ["bridge", 4], ["chorus", 4]]);
  assert.ok(formed.sections[2].energy > formed.sections[0].energy);
  const squeezed = compose({ ...base, loop: false, duration: 20, arrangement: { form } });
  assert.deepEqual(squeezed.sections.map((section) => section.type), ["verse", "bridge", "chorus"]);
  assertValid(squeezed, { ...base, loop: false, duration: 20 }, "squeezed form");

  // drums
  const silent = compose({ ...base, arrangement: { drums: "none" } });
  assert.equal(drumParts(silent).length, 0, "drums none must remove every drum hit");
  assert.ok(noteParts(silent).length >= 3);
  const four = compose({ ...base, energy: 0.8, arrangement: { drums: "fourfloor" } });
  const kit = drumParts(four).find((part) => part.role === "kit")!;
  const beat = 60 / four.bpm;
  for (let b = 0; b < 8; b++)
    assert.ok(kit.hits.some((hit) => hit.kind === "kick" && Math.abs(hit.t - b * beat) < 0.03), `four-on-the-floor kick on beat ${b}`);
  const half = compose({ ...base, energy: 0.6, arrangement: { drums: "halftime" } });
  const halfKit = drumParts(half).find((part) => part.role === "kit")!;
  assert.ok(halfKit.hits.some((hit) => hit.kind === "snare" && Math.abs(hit.t - 2 * beat) < 0.03));
  assert.ok(!halfKit.hits.some((hit) => hit.kind === "snare" && hit.vel > 0.4 && Math.abs(hit.t - 1 * beat) < 0.03));
  for (const feel of ["light", "straight", "halftime", "fourfloor", "swing", "shuffle", "breakbeat", "march", "cinematic"] as const)
    for (const style of ["ambient", "chiptune", "jazz"] as StyleId[]) {
      const cfg = config(style, { loop: true, duration: 30, energy: 0.6, arrangement: { drums: feel } });
      const score = compose(cfg);
      assertValid(score, cfg, `${style} with ${feel} drums`);
      assert.ok(drumParts(score).some((part) => part.role === "kit"), `${style} ${feel}: explicit feel must bring drums`);
    }
  assert.ok(compose({ ...base, arrangement: { drums: "swing" } }).swing >= 0.5, "swing feel implies swung time");

  // bass
  assert.ok(!noteParts(compose({ ...base, arrangement: { bass: "none" } })).some((part) => part.role === "bass"));
  const bassNotes = (feel: "root" | "octave" | "walking" | "arpeggio" | "syncopated" | "pedal") => {
    const cfg = { ...base, energy: 0.6, arrangement: { bass: feel } };
    const score = compose(cfg);
    assertValid(score, cfg, `bass ${feel}`);
    return { score, notes: noteParts(score).find((part) => part.role === "bass")!.notes };
  };
  const pedal = bassNotes("pedal");
  assert.ok(pedal.notes.every((note) => pc(note.midi) === pedal.score.key.tonic), "pedal bass stays on the tonic");
  const walking = bassNotes("walking");
  assert.ok(walking.notes.length >= walking.score.bars * 3.5, "walking bass plays quarter notes");
  const octave = bassNotes("octave");
  assert.ok(new Set(octave.notes.slice(0, 8).map((note) => note.midi)).size >= 2);
  bassNotes("root");
  bassNotes("arpeggio");
  bassNotes("syncopated");

  // swing override, both ways
  assert.equal(compose({ ...base, arrangement: { swing: 0.5 } }).swing, 0.5);
  assert.equal(compose(config("jazz", { arrangement: { swing: 0 } })).swing, 0);

  // layers
  const roles = (score: Score) => new Set(score.parts.map((part) => part.role));
  const all = compose({ ...base, energy: 0.1, arrangement: { layers: { pad: true, arp: true, counter: true, perc: true } } });
  for (const role of ["pad", "arp", "counter", "perc"] as const) assert.ok(roles(all).has(role), `${role} forced on`);
  const none = compose({ ...base, energy: 1, complexity: 1, arrangement: { layers: { pad: false, arp: false, counter: false, perc: false } } });
  for (const role of ["pad", "arp", "counter", "perc"] as const) assert.ok(!roles(none).has(role), `${role} forced off`);
  const forcedAmbient = config("ambient", { arrangement: { layers: { perc: true } } });
  assertValid(compose(forcedAmbient), forcedAmbient, "ambient with percussion");

  // melody shape
  const lead = (melody: NonNullable<MusicConfig["arrangement"]>["melody"]) =>
    leadOf(compose({ ...base, arrangement: { melody } }))!.notes;
  assert.ok(lead({ density: 1 }).length > lead({ density: 0 }).length * 1.8);
  const mean = (notes: { midi: number }[]) => notes.reduce((sum, note) => sum + note.midi, 0) / notes.length;
  assert.ok(mean(lead({ register: "high" })) > mean(lead({ register: "low" })) + 4);
  const stepShare = (notes: { midi: number }[]) => {
    let steps = 0;
    for (let i = 1; i < notes.length; i++) if (Math.abs(notes[i].midi - notes[i - 1].midi) <= 2) steps++;
    return steps / (notes.length - 1);
  };
  let stepwise = 0;
  let leaping = 0;
  for (let seed = 1; seed <= 10; seed++) {
    const at = (motion: "stepwise" | "leaps") =>
      stepShare(leadOf(compose({ ...base, seed, arrangement: { melody: { motion } } }))!.notes);
    stepwise += at("stepwise");
    leaping += at("leaps");
  }
  assert.ok(stepwise > leaping + 0.5, `stepwise ${stepwise.toFixed(2)} vs leaps ${leaping.toFixed(2)}`);
});

test("random arrangement hints never break a Score", () => {
  const romans = ["I", "ii", "iii", "IV", "V", "vi", "vii°", "i", "iv", "v", "bIII", "bVI", "bVII", "bII", "V7", "IVmaj7", "ii7", "vi7", "Imaj9", "V7/vi", "V/V", "vii°/V", "I/III", "IV/V", "iiø", "Vsus4", "Iadd9", "#iv°", "III", "VI", "VII", "i7", "iv6", "Iaug", "isus2", "V9", "I6", "ivm7"].filter((roman) => ROMAN.test(roman));
  assert.ok(romans.length > 30);
  const sectionTypes = ["intro", "verse", "chorus", "bridge", "breakdown", "build", "outro"] as const;
  const drumFeels = ["none", "light", "straight", "halftime", "fourfloor", "swing", "shuffle", "breakbeat", "march", "cinematic"] as const;
  const bassFeels = ["none", "root", "octave", "walking", "arpeggio", "syncopated", "pedal"] as const;
  const rng = seededRandom(424242);
  for (let i = 0; i < 700; i++) {
    const style = rng.pick(STYLE_IDS);
    const arrangement: NonNullable<MusicConfig["arrangement"]> = {};
    if (rng.chance(0.5))
      arrangement.progression = Array.from({ length: rng.int(2, 16) }, () => rng.pick(romans));
    if (rng.chance(0.4))
      arrangement.form = Array.from({ length: rng.int(1, 12) }, () => ({
        type: rng.pick(sectionTypes),
        bars: rng.int(1, 32),
        energy: rng.next(),
      }));
    if (rng.chance(0.5)) arrangement.drums = rng.pick(drumFeels);
    if (rng.chance(0.5)) arrangement.bass = rng.pick(bassFeels);
    if (rng.chance(0.4)) arrangement.swing = rng.range(0, 0.66);
    if (rng.chance(0.4))
      arrangement.layers = { pad: rng.chance(0.5), arp: rng.chance(0.5), counter: rng.chance(0.5), perc: rng.chance(0.5) };
    if (rng.chance(0.5))
      arrangement.melody = {
        density: rng.next(),
        register: rng.pick(["low", "mid", "high"] as const),
        motion: rng.pick(["stepwise", "leaps", "arpeggio"] as const),
      };
    const cfg = config(style, {
      loop: rng.chance(0.5),
      duration: rng.int(15, 120),
      bpm: rng.int(50, 200),
      key: rng.pick(KEYS),
      instrument: rng.pick(INSTRUMENT_IDS),
      energy: rng.next(),
      complexity: rng.next(),
      reverb: rng.next(),
      seed: rng.int(0, 2 ** 31),
      arrangement,
    });
    const label = `fuzz #${i} ${JSON.stringify(cfg)}`;
    let score: Score;
    try {
      score = compose(cfg);
    } catch (error) {
      assert.fail(`${label}: compose threw ${(error as Error).stack}`);
    }
    assertValid(score, cfg, label);
    if (arrangement.drums === "none" && !arrangement.layers?.perc)
      assert.equal(drumParts(score).length, 0, `${label}: drums none`);
    if (arrangement.bass === "none")
      assert.ok(!noteParts(score).some((part) => part.role === "bass"), `${label}: bass none`);
    if (arrangement.swing !== undefined)
      assert.ok(Math.abs(score.swing - arrangement.swing) < 1e-9, `${label}: swing`);
    if (arrangement.form && score.loop)
      assert.equal(score.sections.reduce((sum, section) => sum + section.bars, 0), score.bars, label);
  }
});

test("hostile hints: every roman form the grammar allows is a real chord and survives into the Score", () => {
  const numerals = ["VII", "VI", "IV", "V", "III", "II", "I", "vii", "vi", "iv", "v", "iii", "ii", "i"];
  const suffixes = ["", "maj7", "maj9", "m7b5", "dim7", "dim", "aug", "sus2", "sus4", "add9", "m9", "m7", "m6", "7", "9", "6", "°", "ø"];
  const accidentals = ["", "b", "#"];
  const all: string[] = [];
  for (const accidental of accidentals)
    for (const numeral of numerals)
      for (const suffix of suffixes) {
        all.push(`${accidental}${numeral}${suffix}`);
        for (const slashAccidental of accidentals)
          for (const slash of numerals) all.push(`${accidental}${numeral}${suffix}/${slashAccidental}${slash}`);
      }
  assert.equal(all.length, 3 * 14 * 18 * 43);
  for (const [keyName, scale] of [["C major", "major"], ["F# minor", "naturalMinor"]] as const) {
    const key = makeKey(keyName, scale);
    for (const roman of all) {
      assert.ok(ROMAN.test(roman), `${roman} is outside the hint grammar`);
      const chord = parseRoman(roman, key);
      assert.ok(chord, `${roman} in ${keyName} does not parse (compose would play the tonic instead)`);
      assert.ok(chord.pitchClasses.length >= 2 && chord.pitchClasses.length <= 7 && chord.symbol.length > 0, roman);
      assert.ok(chord.pitchClasses.every((value) => Number.isInteger(value) && value >= 0 && value <= 11), roman);
    }
  }
  // sampled through the composer: every bar plays the chord that was asked for
  const rng = seededRandom(20261009);
  for (let i = 0; i < 120; i++) {
    const style = rng.pick(STYLE_IDS);
    const progression = Array.from({ length: rng.int(2, 16) }, () => rng.pick(all));
    const cfg = config(style, {
      loop: true,
      duration: rng.int(15, 120),
      key: rng.pick(KEYS),
      instrument: rng.pick(INSTRUMENT_IDS),
      seed: i,
      arrangement: { progression },
    });
    const score = compose(cfg);
    const label = `roman fuzz #${i} ${progression.join(" ")}`;
    assertValid(score, cfg, label);
    // clampConfig keeps entries of at most 12 characters; the 13-character forms (#viimaj7/#VII) are reported, not swallowed
    const kept = progression.filter((roman) => roman.length <= 12);
    const line = score.notes.find((item) => item.startsWith("和声")) ?? "";
    if (kept.length >= 2) {
      const bars = new Map(score.chords.map((chord) => [chord.bar, chord.roman]));
      for (let bar = 0; bar < Math.min(score.bars, 16); bar++)
        assert.equal(bars.get(bar), kept[bar % kept.length], `${label}: bar ${bar}`);
      assert.ok(line.startsWith("和声按指定的进行"), `${label}: no note about the progression`);
    }
    assert.equal(line.includes(`有 ${progression.length - (kept.length >= 2 ? kept.length : 0)} 个和弦未被采用`), kept.length < progression.length || kept.length < 2, `${label}: ${line}`);
  }
  // sixteen of the longest chord names still fit a line of the notes
  const longest = Array.from({ length: 16 }, () => "#viimaj7/bVI");
  const wordy = compose(config("bright", { arrangement: { progression: longest } }));
  assertValid(wordy, config("bright", { arrangement: { progression: longest } }), "sixteen long chord names");
  assert.ok(wordy.notes.some((line) => line.includes("（共 16 个和弦）")));
});

test("hostile hints: a form far too long or too short is fitted musically and says so in the notes", () => {
  const types = (score: Score) => score.sections.map((section) => section.type);
  const formLine = (score: Score) => score.notes.find((line) => line.includes("曲式：")) ?? "";
  const isSubsequence = (short: string[], long: string[]) => {
    let at = 0;
    for (const item of long) if (item === short[at]) at++;
    return at === short.length;
  };
  const pop = [
    { type: "intro" as const, bars: 4, energy: 0.3 },
    { type: "verse" as const, bars: 8, energy: 0.5 },
    { type: "chorus" as const, bars: 8, energy: 0.9 },
    { type: "verse" as const, bars: 8, energy: 0.55 },
    { type: "chorus" as const, bars: 8, energy: 1 },
    { type: "bridge" as const, bars: 4, energy: 0.5 },
    { type: "chorus" as const, bars: 4, energy: 1 },
    { type: "outro" as const, bars: 4, energy: 0.3 },
  ];

  // 48 bars written for 60 seconds that hold 28: squeezed, in order, on even phrases
  for (const loop of [true, false]) {
    const cfg = config("bright", { loop, duration: 60, arrangement: { form: pop } });
    const score = compose(cfg);
    assertValid(score, cfg, `48 bars for 60 s (loop ${loop})`);
    assert.equal(score.duration, 60);
    assert.equal(score.bars, 28);
    assert.ok(isSubsequence(types(score), pop.map((item) => item.type)), `sections out of order: ${types(score)}`);
    assert.ok(types(score).includes("verse") && types(score).includes("chorus"));
    assert.ok(score.sections.every((section) => section.bars >= 2 && section.bars % 2 === 0), `odd sections: ${score.sections.map((s) => s.bars)}`);
    assert.match(formLine(score), /提示的曲式共 48 小节，这里只有 28 小节，已.*按比例压缩/);
    // the chorus is still the loudest part of the plan
    const energyOf = (type: string) => Math.max(...score.sections.filter((section) => section.type === type).map((section) => section.energy));
    assert.ok(energyOf("chorus") > energyOf("verse") && energyOf("verse") > energyOf("intro"));
  }

  // far too many sections for the room: the dispensable ones go first and the note names them
  const crowded = Array.from({ length: 12 }, (_, i) => ({ type: (["verse", "chorus", "bridge"] as const)[i % 3], bars: 32, energy: 0.6 }));
  const tight = config("jazz", { loop: false, duration: 30, arrangement: { form: crowded } });
  const trimmed = compose(tight);
  assertValid(trimmed, tight, "384 bars for 30 s");
  assert.equal(trimmed.duration, 30);
  assert.ok(trimmed.sections.length < 12 && trimmed.sections.every((section) => section.bars >= 2));
  assert.ok(!types(trimmed).includes("bridge"));
  assert.match(formLine(trimmed), /提示的曲式共 384 小节.*已省去桥段和部分反复并按比例压缩/);
  // fifteen seconds at a slow tempo: three bars of music still get a verse and a chorus
  const tinyRoom = config("sad", { loop: false, duration: 15, bpm: 60, arrangement: { form: pop } });
  const tinyPiece = compose(tinyRoom);
  assertValid(tinyPiece, tinyRoom, "48 bars for 15 s");
  assert.equal(tinyPiece.duration, 15);
  assert.deepEqual(types(tinyPiece), ["verse", "chorus"]);
  assert.match(formLine(tinyPiece), /已省去.*并按比例压缩/);

  // two bars of verse for two minutes: one kind of section cannot carry a piece
  for (const loop of [true, false]) {
    const cfg = config("bright", { loop, duration: 120, arrangement: { form: [{ type: "verse", bars: 2, energy: 0.5 }] } });
    const score = compose(cfg);
    assertValid(score, cfg, `2 bars for 120 s (loop ${loop})`);
    assert.equal(score.duration, 120);
    assert.ok(new Set(types(score)).size >= 3, `no contrast: ${types(score)}`);
    assert.ok(score.sections.every((section) => section.bars >= 2 && section.bars <= 24));
    assert.match(formLine(score), /提示的曲式只有 2 小节的主歌，撑不满全曲，已按本风格的常规曲式展开/);
    // the energy asked for the verse is kept for every verse
    const plain = compose({ ...cfg, arrangement: undefined });
    const verses = score.sections.filter((section) => section.type === "verse");
    assert.ok(verses.length >= 1 && verses.every((section) => Math.abs(section.energy - 0.5 * (0.6 + 0.8 * cfg.energy)) < 1e-3));
    assert.equal(score.bars, plain.bars);
  }
  // verse + chorus of two bars each: repeated in phrases, not stretched into two endless sections
  const pair = [{ type: "verse" as const, bars: 2, energy: 0.4 }, { type: "chorus" as const, bars: 2, energy: 0.9 }];
  for (const [style, bpm] of [["battle", 200], ["chill", 80]] as const) {
    const cfg = config(style, { loop: false, duration: 120, bpm, arrangement: { form: pair } });
    const score = compose(cfg);
    assertValid(score, cfg, `${style}: 4 bars for 120 s`);
    assert.equal(score.duration, 120);
    assert.ok(score.sections.length >= 4 && score.sections.length <= 16, `${score.sections.length} sections`);
    assert.ok(types(score).every((type, index) => type === (index % 2 ? "chorus" : "verse")), `${types(score)}`);
    assert.ok(score.sections.every((section) => section.bars >= 4 && section.bars <= 24), `${score.sections.map((s) => s.bars)}`);
    assert.match(formLine(score), /提示的曲式共 4 小节，已反复 \d+ 遍填满 \d+ 小节/);
    // later verses arrive a little stronger, never weaker
    const verses = score.sections.filter((section) => section.type === "verse").map((section) => section.energy);
    assert.ok(verses.every((value, index) => index === 0 || value >= verses[index - 1] - 1e-9) && verses[verses.length - 1] > verses[0]);
  }
  // a little short: stretched in proportion
  const short = config("bright", { loop: true, duration: 60, arrangement: { form: [{ type: "verse", bars: 8, energy: 0.5 }, { type: "bridge", bars: 4, energy: 0.5 }, { type: "chorus", bars: 4, energy: 0.9 }] } });
  const stretched = compose(short);
  assertValid(stretched, short, "16 bars for 28");
  assert.deepEqual(types(stretched), ["verse", "bridge", "chorus"]);
  assert.ok(stretched.sections[0].bars > stretched.sections[1].bars && stretched.sections.every((section) => section.bars >= 4));
  assert.match(formLine(stretched), /提示的曲式共 16 小节，已按比例延展到 28 小节/);

  // a form that fits is kept as written and nothing is said about it
  const exact = [{ type: "verse" as const, bars: 12, energy: 0.5 }, { type: "chorus" as const, bars: 16, energy: 0.9 }];
  const fitsLoop = compose(config("bright", { loop: true, duration: 60, arrangement: { form: exact } }));
  assert.deepEqual(fitsLoop.sections.map((section) => section.bars), [12, 16]);
  assert.ok(!formLine(fitsLoop).includes("提示"));
  // written for the whole length of a piece that ends: the last section holds the final chord
  const fitsSong = compose(config("bright", { loop: false, duration: 60, arrangement: { form: exact } }));
  assert.deepEqual(fitsSong.sections.map((section) => section.bars), [12, 16]);
  assert.ok(!formLine(fitsSong).includes("提示"));

  // random forms: always valid, always the asked length, and a changed form is always announced
  const rng = seededRandom(987123);
  const sectionTypes = ["intro", "verse", "chorus", "bridge", "breakdown", "build", "outro"] as const;
  let noted = 0;
  for (let i = 0; i < 500; i++) {
    const form = Array.from({ length: rng.int(1, 12) }, () => ({ type: rng.pick(sectionTypes), bars: rng.int(1, 32), energy: rng.next() }));
    const cfg = config(rng.pick(STYLE_IDS), { loop: rng.chance(0.5), duration: rng.int(15, 120), bpm: rng.int(50, 200), seed: i, arrangement: { form } });
    const score = compose(cfg);
    const label = `form fuzz #${i} ${JSON.stringify(cfg.arrangement)} ${cfg.mood} ${cfg.bpm} bpm ${cfg.duration} s loop ${cfg.loop}`;
    assertValid(score, cfg, label);
    if (!cfg.loop) assert.equal(score.duration, cfg.duration, label);
    else assert.ok(score.duration <= cfg.duration + 240 / score.bpm + 1e-6 && score.duration <= 125, `${label}: ${score.duration} s`);
    assert.equal(score.sections.reduce((total, section) => total + section.bars, 0), score.bars, label);
    // "as written": in a piece that ends, the last section also shows the bars of the final chord and its tail
    const asked = form.reduce((total, item) => total + item.bars, 0);
    const same =
      score.sections.length === form.length &&
      score.sections.every(
        (section, index) =>
          section.type === form[index].type &&
          (section.bars === form[index].bars || (!cfg.loop && index === form.length - 1 && asked <= score.bars && asked >= score.bars - 6)),
      );
    const line = formLine(score);
    if (!same) {
      assert.ok(line.includes("提示的曲式"), `${label}: the form changed without a note — ${line}`);
      noted++;
    }
    assert.ok(line.length <= 200, `${label}: ${line.length} characters`);
  }
  assert.ok(noted > 300);
});

test("hostile hints: drums off with percussion on, swing at both limits, tempo and length at their limits", () => {
  for (const style of STYLE_IDS) {
    // "no drums" plus an explicit percussion layer: no kit, but the shaker (or the style's own percussion) plays
    const quiet = config(style, { loop: true, duration: 30, arrangement: { drums: "none", layers: { perc: true } } });
    const score = compose(quiet);
    assertValid(score, quiet, `${style}: drums none + perc`);
    assert.ok(!score.parts.some((part) => part.role === "kit"), `${style}: a kit plays although drums are "none"`);
    const perc = drumParts(score).find((part) => part.role === "perc");
    assert.ok(perc && perc.hits.length >= 4, `${style}: the forced percussion layer is missing`);
    assert.ok(!perc.hits.some((hit) => hit.kind === "kick" || hit.kind === "snare"), `${style}: percussion plays kit drums`);
    assert.ok(noteParts(score).length >= 2);

    for (const swing of [0, 0.66])
      for (const loop of [true, false]) {
        const cfg = config(style, { loop, duration: 24, arrangement: { swing } });
        const swung = compose(cfg);
        assertValid(swung, cfg, `${style}: swing ${swing}`);
        assert.equal(swung.swing, swing);
      }

    for (const bpm of [50, 200])
      for (const duration of [15, 120])
        for (const loop of [true, false]) {
          const cfg = config(style, { bpm, duration, loop });
          const piece = compose(cfg);
          const label = `${style} ${bpm} BPM ${duration} s loop ${loop}`;
          assertValid(piece, cfg, label);
          if (loop) {
            // a loop may move to the nearest whole bars, never further, and says so
            assert.ok(Math.abs(piece.duration - duration) <= 240 / piece.bpm + 1e-6, `${label}: ${piece.duration} s`);
            assert.ok(piece.duration <= 125, `${label}: ${piece.duration} s is too long`);
            if (Math.abs(piece.duration - duration) > 0.01)
              assert.ok(piece.notes.some((line) => line.includes("时长取整")), `${label}: silent length change`);
            if (Math.abs(piece.bpm - bpm) > 0.01)
              assert.ok(piece.notes.some((line) => line.includes("速度微调")), `${label}: silent tempo change`);
          } else {
            assert.equal(piece.duration, duration, label);
            assert.equal(piece.bpm, bpm, label);
          }
          assert.ok(eventCount(piece) >= (duration === 15 ? 4 : 40), `${label}: only ${eventCount(piece)} events`);
        }
  }
});

test("one swing ratio moves every part's off-beats by the same amount", () => {
  const cfg = config("jazz", { loop: true, duration: 30, energy: 0.6, arrangement: { swing: 0.66 } });
  const score = compose(cfg);
  const beat = 60 / score.bpm;
  const expected = 0.5 + 0.66 / 4;
  // off-beat eighths only: the last sixteenth of a beat (a ghost stroke) lands later still, near 0.83
  const offbeats = (times: number[]) =>
    times.map((t) => (t / beat) % 1).filter((fraction) => fraction > 0.4 && fraction < 0.78);
  for (const part of score.parts) {
    const times = part.kind === "notes" ? part.notes.map((note) => note.t) : part.hits.filter((hit) => hit.kind !== "cymbalSwell").map((hit) => hit.t);
    const found = offbeats(times);
    if (found.length < 4) continue;
    const average = found.reduce((sum, value) => sum + value, 0) / found.length;
    assert.ok(Math.abs(average - expected) < 0.035, `${part.id}: off-beats at ${average.toFixed(3)}, expected ${expected.toFixed(3)}`);
  }
  // straight time really is straight
  const straight = compose(config("retro", { loop: true, duration: 30 }));
  const grid = 60 / straight.bpm / 4;
  for (const part of straight.parts) {
    const times = part.kind === "notes" ? part.notes.map((note) => note.t) : part.hits.filter((hit) => hit.kind !== "cymbalSwell").map((hit) => hit.t);
    for (const t of times) {
      const off = Math.abs(t / grid - Math.round(t / grid)) * grid;
      assert.ok(off < 0.02, `${part.id}: event ${off * 1000} ms off the grid`);
    }
  }
});

test("style identity", () => {
  const voices = (score: Score) => new Set(noteParts(score).map((part) => part.voice));
  const kinds = (score: Score) => new Set(drumParts(score).flatMap((part) => part.hits.map((hit) => hit.kind)));
  for (const loop of [true, false])
    for (const energy of [0, 0.15, 0.5, 1])
      for (const duration of [30, 90]) {
        // ambient: no drum kit, ever; pads and bells
        const ambient = compose(config("ambient", { loop, energy, duration }));
        assert.equal(drumParts(ambient).length, 0, "ambient has no drums");
        assert.ok(voices(ambient).has("airpad") || voices(ambient).has("pad"));
        // chiptune: three chip voices and the noise channel only
        const chiptune = compose(config("chiptune", { loop, energy, duration }));
        for (const voice of voices(chiptune)) assert.ok(["chip", "chipPulse", "chipBass"].includes(voice), `chiptune voice ${voice}`);
        for (const kind of kinds(chiptune)) assert.ok(kind === "noiseHit" || kind === "noiseTick", `chiptune drum ${kind}`);
        for (const part of drumParts(chiptune)) assert.equal(part.kit, "chip");
        assert.ok(chiptune.space.level < 0.2, "chiptune is almost dry");
        // jazz: swung, upright bass
        const jazz = compose(config("jazz", { loop, energy, duration }));
        assert.ok(jazz.swing > 0.4);
        assert.equal(noteParts(jazz).find((part) => part.role === "bass")!.voice, "uprightBass");
        for (const part of drumParts(jazz)) assert.equal(part.kit, "brush");
      }
  const chiptune = compose(config("chiptune", { loop: true, duration: 30 }));
  assert.ok(voices(chiptune).has("chipPulse") && voices(chiptune).has("chipBass"));
  assert.equal(chiptune.master.character, "bitcrush");
  const arp = noteParts(chiptune).find((part) => part.role === "arp")!;
  assert.ok(arp.notes.length / chiptune.bars >= 12, "chiptune arpeggio runs in sixteenths");

  const jazz = compose(config("jazz", { loop: true, duration: 30, energy: 0.6 }));
  assert.ok(kinds(jazz).has("ride"));
  assert.ok(jazz.chords.every((chord) => chord.pitchClasses.length >= 4), "jazz chords are sevenths or richer");
  const walking = noteParts(jazz).find((part) => part.role === "bass")!;
  assert.ok(walking.notes.length >= jazz.bars * 3, "jazz bass walks");

  const epic = compose(config("epic", { loop: false, duration: 60 }));
  assert.ok(kinds(epic).has("taiko") && kinds(epic).has("subBoom") && kinds(epic).has("cymbalSwell"));
  assert.ok(voices(epic).has("brass") && voices(epic).has("strings") && voices(epic).has("pizzicato"));
  assert.equal(drumParts(epic)[0].kit, "cinematic");

  const chill = compose(config("chill", { loop: true, duration: 30 }));
  assert.equal(leadOf(chill)!.voice, "epiano");
  assert.equal(noteParts(chill).find((part) => part.role === "comp")!.voice, "epiano");
  assert.equal(drumParts(chill)[0].kit, "lofi");
  assert.equal(chill.master.character, "lofi");
  assert.ok(chill.swing > 0.2);
  assert.ok(chill.chords.every((chord) => chord.pitchClasses.length >= 4), "lo-fi chords are sevenths");

  const ambient = compose(config("ambient", { loop: false, duration: 60 }));
  const longest = Math.max(...noteParts(ambient).filter((part) => part.role === "pad").flatMap((part) => part.notes.map((note) => note.d)));
  assert.ok(longest >= 6, `ambient pads are long (longest ${longest}s)`);
  const bells = leadOf(ambient)!.notes.length / ambient.duration;
  assert.ok(bells < 0.8, `ambient bells are sparse (${bells.toFixed(2)} notes/s)`);
  assert.ok(ambient.space.level > 0.7 && ambient.space.decay >= 4);

  const acoustic = compose(config("acoustic", { loop: true, duration: 30 }));
  assert.ok(voices(acoustic).has("guitar") && voices(acoustic).has("nylon"));
  assert.ok(voices(compose(config("retro"))).has("synthBass"));
});

test("summarize gives the UI Chinese instrument names for the parts in use", () => {
  for (const style of IMPLEMENTED) {
    const score = compose(config(style, { loop: false, duration: 60 }));
    const summary = summarize(score);
    assert.equal(summary.bpm, score.bpm);
    assert.equal(summary.bars, score.bars);
    assert.equal(summary.duration, score.duration);
    assert.equal(summary.keyLabel, score.key.label);
    assert.deepEqual(summary.sections, score.sections);
    assert.deepEqual(summary.chords, score.chords);
    assert.deepEqual(summary.notes, score.notes);
    assert.ok(summary.instruments.length >= 2 && summary.instruments.length <= score.parts.length);
    for (const name of summary.instruments) assert.match(name, /[一-鿿]/);
    assert.equal(new Set(summary.instruments).size, summary.instruments.length);
    assert.match(score.key.label, /^[A-G][#b]? (大调|小调)$/);
    // structured-clone safe (it is posted to a worker)
    assert.deepEqual(structuredClone(score), score);
    assert.ok(score.notes.some((line) => line.includes("BPM")));
    assert.ok(score.notes.some((line) => line.includes("→")));
  }
});

test("compose tolerates incomplete or out-of-range configs", () => {
  const broken: unknown[] = [
    {},
    { mood: "nope", key: "H major", instrument: "kazoo", bpm: 9999, duration: -3, energy: 7, seed: -1 },
    { ...DEFAULT_CONFIG, bpm: Number.NaN, duration: Number.POSITIVE_INFINITY, complexity: Number.NaN },
    { ...DEFAULT_CONFIG, arrangement: { progression: ["zzz", 3, "I"], form: [{ type: "what", bars: 0 }], drums: "loud", swing: -4, layers: 5, melody: "x" } },
    { ...DEFAULT_CONFIG, arrangement: { form: Array.from({ length: 12 }, () => ({ type: "chorus", bars: 32, energy: 1 })) }, duration: 15, bpm: 50, loop: false },
    { ...DEFAULT_CONFIG, arrangement: { form: [{ type: "intro", bars: 4, energy: 0.2 }] }, loop: false },
    { ...DEFAULT_CONFIG, engine: 1 },
  ];
  for (const input of broken) {
    const score = compose(input as MusicConfig);
    assert.equal(score.version, 2);
    assert.ok(score.parts.length > 0);
    assert.ok(score.chords.length > 0);
  }
  assert.doesNotThrow(() => compose(null as unknown as MusicConfig));
});

test("composing two minutes of music takes well under 100 ms", () => {
  const cfg = config("epic", { loop: false, duration: 120, energy: 1, complexity: 1 });
  for (let i = 0; i < 5; i++) compose({ ...cfg, seed: i });
  const styles: StyleId[] = ["epic", "chiptune", "jazz", "retro", "bright"];
  let worst = 0;
  for (const style of styles) {
    const samples: number[] = [];
    for (let i = 0; i < 7; i++) {
      const start = performance.now();
      compose(config(style, { loop: i % 2 === 0, duration: 120, energy: 1, complexity: 1, bpm: 180, seed: i }));
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    worst = Math.max(worst, samples[3]);
  }
  assert.ok(worst < 100, `median compose time ${worst.toFixed(1)} ms`);
});

function describeParts(parts: Part[]): string {
  return parts.map((part) => `${part.id}:${part.kind === "notes" ? part.voice : part.kit}`).join(" ");
}
test("parts use unique ids and the four mixer groups", () => {
  const score = compose(config("epic", { loop: false, duration: 90, energy: 1, complexity: 1 }));
  const tracks = new Set(score.parts.map((part) => part.track));
  assert.deepEqual([...tracks].sort(), ["bass", "chords", "drums", "melody"], describeParts(score.parts));
  assert.equal(new Set(score.parts.map((part) => part.id)).size, score.parts.length);
});

/* ---------- engine finalisation: routing, drones, approach tones, chorus lift, hinted percussion ---------- */

test("an arpeggio that is the only harmony takes the chords fader; next to chords it stays with the tune", () => {
  for (const loop of [true, false]) {
    const cfg = config("chiptune", { loop, duration: 30 });
    const score = compose(cfg);
    const arp = noteParts(score).find((part) => part.role === "arp");
    assert.ok(arp, "chiptune has its arpeggio");
    assert.equal(arp.track, "chords");
    assert.ok(!score.parts.some((part) => part.role === "comp" || part.role === "pad"));
    assertValid(score, cfg, `chiptune loop ${loop}`);
    // the four faders all do something
    assert.deepEqual([...new Set(score.parts.map((part) => part.track))].sort(), ["bass", "chords", "drums", "melody"]);
  }
  // a hinted pad takes the chords fader and the arpeggio goes back to the tune
  const padded = config("chiptune", { arrangement: { layers: { pad: true } } });
  const withPad = compose(padded);
  assert.equal(noteParts(withPad).find((part) => part.role === "pad")?.track, "chords");
  assert.equal(noteParts(withPad).find((part) => part.role === "arp")?.track, "melody");
  assertValid(withPad, padded, "chiptune with a pad");
  // styles with a comp or a pad never move it
  for (const style of ["dreamy", "retro", "epic", "dance", "festive"] as StyleId[]) {
    const score = compose(config(style, { energy: 0.9 }));
    for (const part of noteParts(score)) if (part.role === "arp") assert.equal(part.track, "melody", style);
  }
  // an arpeggio on the chords fader NEXT TO a comp is a broken Score
  const broken = compose(config("retro", { energy: 0.9 }));
  const arp = noteParts(broken).find((part) => part.role === "arp");
  assert.ok(arp);
  arp.track = "chords";
  assert.ok(scoreProblems(broken).some((problem) => problem.includes("arp")));
});

test("a held bass note is tied over, never struck again at the moment it ends", () => {
  let drones = 0;
  for (const [style, overrides] of [
    ["ambient", {}],
    ["ambient", { duration: 120 }],
    ["ambient", { loop: false, duration: 60 }],
    ["epic", { energy: 0.1 }],
    ["tension", { energy: 0.05, loop: false }],
    ["dreamy", {}],
    ["cinematic", { loop: false }],
  ] as [StyleId, Partial<MusicConfig>][])
    for (const seed of [1, 7, 4242, 20261]) {
      const cfg = config(style, { ...overrides, seed });
      const score = compose(cfg);
      assertValid(score, cfg, `${style} ${seed}`);
      const bass = noteParts(score).find((part) => part.role === "bass");
      if (!bass) continue;
      for (let i = 1; i < bass.notes.length; i++) {
        const previous = bass.notes[i - 1];
        const note = bass.notes[i];
        const gap = note.t - (previous.t + previous.d);
        // a long note followed at once by the same pitch would cancel against its own release
        if (previous.d >= 2 * (60 / score.bpm) && previous.midi === note.midi)
          assert.ok(gap > 0.03, `${style} seed ${seed}: bass ${note.midi} re-struck ${gap.toFixed(3)} s after a held note at ${note.t}`);
      }
      if (bass.notes.some((note) => note.d > 8 * (60 / score.bpm))) drones++;
    }
  assert.ok(drones >= 8, `only ${drones} pieces had a drone to check`);
});

test("under a five-note tune the bass approaches by the notes of the scale, never by a semitone from outside", () => {
  const style = getStyle("guofeng");
  assert.ok(style.bass, "guofeng has a bass");
  const saved = style.bass.approach;
  // the style itself keeps approach tones off; switch them on to test the rule
  style.bass.approach = 1;
  try {
    let approached = 0;
    for (let seed = 1; seed <= 24; seed++) {
      const cfg = config("guofeng", { seed, complexity: 1, energy: 0.8, duration: 60 });
      const score = compose(cfg);
      assert.equal(score.key.scale.length, 5, "guofeng composes in a pentatonic scale");
      const bass = noteParts(score).find((part) => part.role === "bass");
      assert.ok(bass);
      for (const note of bass.notes) {
        const index = score.chords.findIndex((chord) => note.t >= chord.start - 0.08 && note.t < chord.end - 0.08);
        const here = score.chords[Math.max(0, index)];
        const next = score.chords[Math.min(score.chords.length - 1, Math.max(0, index) + 1)];
        const allowed = new Set([...score.key.scale, ...here.pitchClasses, ...next.pitchClasses]);
        assert.ok(allowed.has(pc(note.midi)), `seed ${seed}: bass plays ${note.midi} at ${note.t} over ${here.symbol} → ${next.symbol}`);
        if (!here.pitchClasses.includes(pc(note.midi))) approached++;
      }
    }
    assert.ok(approached > 10, `only ${approached} approach tones were written`);
  } finally {
    style.bass.approach = saved;
  }
});

test("the chorus lift fades for leads that already sing high", () => {
  // mean pitch of the tune in the chorus minus the verse, over a few seeds
  const lift = (instrument: MusicConfig["instrument"]) => {
    let sum = 0;
    let count = 0;
    for (let seed = 1; seed <= 10; seed++) {
      const score = compose(config("rock", { instrument, seed, loop: false, duration: 60 }));
      const lead = leadOf(score);
      assert.ok(lead);
      const mean = (type: string) => {
        const notes = lead.notes.filter((note) => score.sections.some((section) => section.type === type && note.t >= section.start && note.t < section.end));
        return notes.length ? notes.reduce((total, note) => total + note.midi, 0) / notes.length : NaN;
      };
      const difference = mean("chorus") - mean("verse");
      if (Number.isFinite(difference)) {
        sum += difference;
        count++;
      }
    }
    assert.ok(count >= 6, `${instrument}: ${count} pieces with a verse and a chorus`);
    return sum / count;
  };
  const piano = lift("piano");
  const flute = lift("flute");
  const musicbox = lift("musicbox");
  assert.ok(piano > 2, `piano chorus sits ${piano.toFixed(1)} semitones above the verse`);
  assert.ok(flute < piano - 0.8, `flute ${flute.toFixed(1)} against piano ${piano.toFixed(1)}`);
  assert.ok(musicbox < flute + 0.3 && musicbox < piano - 1.5, `music box ${musicbox.toFixed(1)} against flute ${flute.toFixed(1)} and piano ${piano.toFixed(1)}`);
  // and nobody is pushed out of the comfortable range
  for (const instrument of ["flute", "dizi", "bell", "musicbox"] as const) {
    const lead = leadOf(compose(config("rock", { instrument, loop: false, duration: 60, energy: 1 })));
    assert.ok(lead);
    const top = Math.max(...lead.notes.map((note) => note.midi));
    assert.ok(top <= LEAD_TRAITS[instrument].high, `${instrument} reaches ${top}`);
  }
});

test("a percussion layer switched on by a hint can be heard: unity gain and accented strokes", () => {
  for (const style of ["jazz", "cinematic", "sad", "ambient"] as StyleId[]) {
    assert.equal(getStyle(style).perc, undefined, `${style} defines no percussion of its own`);
    const cfg = config(style, { arrangement: { layers: { perc: true } } });
    const score = compose(cfg);
    assertValid(score, cfg, style);
    const perc = drumParts(score).find((part) => part.role === "perc");
    assert.ok(perc, `${style}: the hinted layer plays`);
    assert.ok(perc.mix.gain >= 0.9, `${style}: percussion gain ${perc.mix.gain}`);
    assert.ok(perc.hits.some((hit) => hit.vel >= 0.6), `${style}: loudest stroke ${Math.max(...perc.hits.map((hit) => hit.vel))}`);
  }
});

test("part gains: a style may ask for up to MAX_PART_GAIN and no more", () => {
  for (const id of IMPLEMENTED) {
    const style = getStyle(id);
    for (const [role, mix] of Object.entries(style.mix))
      if (mix?.gain !== undefined) assert.ok(mix.gain > 0 && mix.gain <= MAX_PART_GAIN, `${id}.${role} gain ${mix.gain}`);
    for (const [instrument, mix] of Object.entries(style.lead ?? {}))
      if (mix?.gain !== undefined) assert.ok(mix.gain > 0 && mix.gain <= MAX_PART_GAIN, `${id} lead ${instrument} gain ${mix.gain}`);
  }
  const score = compose(config("bright"));
  score.parts[0].mix.gain = MAX_PART_GAIN + 0.5;
  assert.ok(scoreProblems(score).some((problem) => problem.includes("mix out of range")));
});
