/**
 * Keys group: piano, epiano, bell, musicbox, marimba, vibes, organ.
 *
 *   keys/piano.ts    piano     additive / modal grand (the group's exemplar)
 *   keys/epiano.ts   epiano    FM tine piano
 *   keys/mallets.ts  bell, musicbox, marimba, vibes   modal bars and tines
 *   keys/organ.ts    organ     additive drawbars + rotary speaker
 */
import type { VoiceId } from "../../music/score";
import type { VoiceBank } from "./types";
import type { ContractOptions } from "./testing";
import { piano } from "./keys/piano";
import { epiano } from "./keys/epiano";
import { bell, marimba, musicbox, vibes } from "./keys/mallets";
import { organ } from "./keys/organ";

/** smallest L/R correlation any note of these voices may have (mono compatibility) */
const MONO_SAFE = 0.3;

/**
 * Useful range and intended deviations of each finished voice, as options
 * for assertVoiceContract() (see testing.ts).
 */
export const KEYS_CONTRACT: Partial<Record<VoiceId, ContractOptions>> = {
  // the whole keyboard; the top octave is short by nature, so it reads quieter
  piano: { range: [21, 108] },
  // E1..C7, the compass of a 73-key stage piano plus a few keys
  epiano: { range: [28, 100], minCorrelation: MONO_SAFE },
  // C3..C8: celesta and glockenspiel together
  bell: { range: [48, 108], minCorrelation: MONO_SAFE },
  // a comb rarely goes below C3; every tine is up to 4.5 cents off by design
  musicbox: { range: [48, 108], minCorrelation: MONO_SAFE },
  // five-octave marimba C2..C7; above A4 the ring is shorter than the level
  // window, so those notes are peak-limited and read quieter. A harder stroke
  // is brighter only while the upper modes last (the first 100 ms), which the
  // 0.6 s centroid of the harness cannot see: tests/voices-keys checks it
  marimba: {
    range: [36, 96],
    rangeLevelTolerance: 8,
    minBrightnessRatio: 1,
    minCorrelation: MONO_SAFE,
  },
  // F3..F6 plus an octave of safety either side
  vibes: { range: [41, 101], minCorrelation: MONO_SAFE },
  organ: { range: [36, 96], minCorrelation: MONO_SAFE },
};

export const KEYS_VOICES: Partial<VoiceBank> = {
  piano,
  epiano,
  bell,
  musicbox,
  marimba,
  vibes,
  organ,
};
