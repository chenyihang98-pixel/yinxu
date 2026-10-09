// electron/shared/music-catalog.json is the one list of styles, lead
// instruments, keys and arrangement words. The renderer reads it through
// src/music/catalog.ts, whose literal unions are written out by hand so the
// compiler can check ids; the desktop main process reads the JSON directly.
// These tests keep the two from drifting apart.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  BASS_FEELS,
  DRUM_FEELS,
  INSTRUMENT_IDS,
  KEYS,
  LIMITS,
  SECTION_TYPES,
  STYLE_IDS,
  isInstrumentId,
  isKey,
  isStyleId,
  parseKey,
} from "../src/music/catalog";
import { stylePreset } from "../src/music/defaults";
import { getStyle } from "../src/music/styles";

interface CatalogFile {
  limits: { bpm: [number, number]; duration: [number, number] };
  styles: {
    id: string;
    label: string;
    bpm: number;
    bpmRange: [number, number];
    key: string;
    instrument: string;
    energy: number;
    complexity: number;
    reverb: number;
  }[];
  instruments: { id: string; label: string }[];
  keys: string[];
  sectionTypes: string[];
  drumFeels: string[];
  bassFeels: string[];
}

const catalog = JSON.parse(
  readFileSync(
    new URL("../electron/shared/music-catalog.json", import.meta.url),
    "utf8",
  ),
) as CatalogFile;

test("catalog: the typed unions list exactly what the shared JSON lists, in its order", () => {
  assert.deepEqual(
    [...STYLE_IDS],
    catalog.styles.map((style) => style.id),
  );
  assert.deepEqual(
    [...INSTRUMENT_IDS],
    catalog.instruments.map((instrument) => instrument.id),
  );
  assert.deepEqual([...SECTION_TYPES], catalog.sectionTypes);
  assert.deepEqual([...DRUM_FEELS], catalog.drumFeels);
  assert.deepEqual([...BASS_FEELS], catalog.bassFeels);
  assert.deepEqual([...KEYS], catalog.keys);
  assert.deepEqual(LIMITS.bpm, catalog.limits.bpm);
  assert.deepEqual(LIMITS.duration, catalog.limits.duration);
  // no id twice, no label twice: both are shown and stored
  for (const list of [catalog.styles, catalog.instruments]) {
    assert.equal(new Set(list.map((item) => item.id)).size, list.length);
    assert.equal(new Set(list.map((item) => item.label)).size, list.length);
  }
  assert.equal(new Set(catalog.keys).size, 24);
});

test("catalog: every style has its own composer definition and a preset inside the limits", () => {
  for (const style of catalog.styles) {
    assert.ok(isStyleId(style.id), style.id);
    // getStyle never throws: a style without a definition would be composed as 青春欢快
    assert.equal(
      getStyle(style.id).id,
      style.id,
      `${style.id} has no StyleDef of its own`,
    );
    assert.ok(isKey(style.key), `${style.id}: key ${style.key}`);
    assert.ok(
      isInstrumentId(style.instrument),
      `${style.id}: lead ${style.instrument}`,
    );
    const [low, high] = style.bpmRange;
    assert.ok(
      catalog.limits.bpm[0] <= low &&
        low <= style.bpm &&
        style.bpm <= high &&
        high <= catalog.limits.bpm[1],
      `${style.id}: ${low} ≤ ${style.bpm} ≤ ${high} BPM`,
    );
    for (const amount of [style.energy, style.complexity, style.reverb])
      assert.ok(amount >= 0 && amount <= 1, `${style.id}: ${amount}`);
    const preset = stylePreset(style.id);
    assert.deepEqual(
      [preset.bpm, preset.key, preset.instrument],
      [style.bpm, style.key, style.instrument],
      `${style.id}: the preset is the catalogue entry`,
    );
  }
  for (const key of catalog.keys) {
    const parsed = parseKey(key);
    assert.equal(
      `${parsed.name} ${parsed.minor ? "minor" : "major"}`,
      key,
      "a key reads back as it is written",
    );
  }
});
