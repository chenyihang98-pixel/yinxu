/**
 * Sustained group: strings, pad, airpad, brass, choir, flute, dizi, synth,
 * chip, chipPulse. One file per engine under ./sustained; this module only
 * assembles them and states how each is checked.
 */
import type { VoiceId } from "../../music/score";
import type { VoiceBank } from "./types";
import type { ContractOptions } from "./testing";
import { airpad } from "./sustained/airpad";
import { brass } from "./sustained/brass";
import { chip, chipPulse } from "./sustained/chip";
import { choir } from "./sustained/choir";
import { synth } from "./sustained/lead";
import { pad } from "./sustained/pad";
import { strings } from "./sustained/strings";
import { dizi, flute } from "./sustained/winds";

/**
 * Useful range and intended deviations of each voice, as options for
 * assertVoiceContract() (see testing.ts).
 */
export const SUSTAINED_CONTRACT: Partial<Record<VoiceId, ContractOptions>> = {
  // ensembles: wide but never out of phase
  strings: { range: [36, 96], minCorrelation: 0.3 },
  pad: { range: [36, 96], minCorrelation: 0.3 },
  airpad: { range: [36, 96], minCorrelation: 0.3 },
  brass: { range: [36, 91], minCorrelation: 0.3 },
  choir: { range: [36, 91], minCorrelation: 0.3 },
  // G3..E7; the real instruments start at C4 / A4, the octave below is safety
  flute: { range: [55, 100], minCorrelation: 0.3 },
  dizi: { range: [57, 100], minCorrelation: 0.3 },
  synth: { range: [36, 96], minCorrelation: 0.3 },
  // A console pulse channel has no filter: velocity sets level, accent and
  // the opening duty, so a hard note is not asked to be brighter overall
  // (only not to be duller).
  chip: { range: [36, 96], minBrightnessRatio: 0.98, minCorrelation: 0.99 },
  chipPulse: { range: [36, 96], minCorrelation: 0.99 },
};

export const SUSTAINED_VOICES: Partial<VoiceBank> = {
  strings,
  pad,
  airpad,
  brass,
  choir,
  flute,
  dizi,
  synth,
  chip,
  chipPulse,
};
