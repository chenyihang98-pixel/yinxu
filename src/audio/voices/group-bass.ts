/**
 * Bass group: subBass, fingerBass, synthBass, uprightBass, chipBass,
 * bass808. One file per engine under ./bass; this module only assembles
 * them and states how each is checked. Every bass voice is mono.
 */
import type { VoiceId } from "../../music/score";
import type { VoiceBank } from "./types";
import type { ContractOptions } from "./testing";
import { bass808 } from "./bass/b808";
import { chipBass } from "./bass/chip";
import { fingerBass, uprightBass } from "./bass/plucked";
import { subBass } from "./bass/sub";
import { synthBass } from "./bass/synth";

/** A1, D#2, A2: where the level convention is checked for a bass. */
const BASS_LEVEL_MIDIS = [33, 39, 45];

/**
 * Useful range and intended deviations of each voice, as options for
 * assertVoiceContract() (see testing.ts).
 */
export const BASS_CONTRACT: Partial<Record<VoiceId, ContractOptions>> = {
  // C1..C4, and the level convention is also checked at A3..A4
  subBass: {
    range: [24, 60],
    levelMidis: [33, 40, 45, 57, 63, 69],
    minCorrelation: 0.99,
  },
  // C1..G4 (a four-string bass is E1..G4); a pluck may start steeper than a keyboard
  fingerBass: {
    range: [24, 67],
    levelMidis: BASS_LEVEL_MIDIS,
    minCorrelation: 0.99,
    clicks: { startJump: 0.35 },
  },
  uprightBass: {
    range: [24, 67],
    levelMidis: BASS_LEVEL_MIDIS,
    minCorrelation: 0.99,
    clicks: { startJump: 0.35 },
  },
  synthBass: {
    range: [24, 72],
    levelMidis: BASS_LEVEL_MIDIS,
    minCorrelation: 0.99,
  },
  chipBass: {
    range: [24, 72],
    levelMidis: BASS_LEVEL_MIDIS,
    minCorrelation: 0.99,
  },
  bass808: {
    range: [21, 60],
    levelMidis: BASS_LEVEL_MIDIS,
    minCorrelation: 0.99,
  },
};

export const BASS_VOICES: Partial<VoiceBank> = {
  subBass,
  fingerBass,
  synthBass,
  uprightBass,
  chipBass,
  bass808,
};
