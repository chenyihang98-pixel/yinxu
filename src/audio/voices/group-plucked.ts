/**
 * Plucked group: guitar, nylon, guzheng, pluck, pizzicato, overdrive.
 *
 *   plucked/strings.ts    guitar, nylon, guzheng, pizzicato   Karplus-Strong
 *                         string + body (guitar is the group's exemplar)
 *   plucked/pluck.ts      pluck       saw / square through a snapping filter
 *   plucked/overdrive.ts  overdrive   string into a clipping amp and cabinet
 */
import type { VoiceId } from "../../music/score";
import type { VoiceBank } from "./types";
import type { ContractOptions } from "./testing";
import { guitar, guzheng, nylon, pizzicato } from "./plucked/strings";
import { pluck } from "./plucked/pluck";
import { overdrive } from "./plucked/overdrive";

/** a pluck is allowed a steeper first millisecond than a keyboard */
const PLUCK_CLICKS = { startJump: 0.35 };
/** that, plus an L/R correlation of at least 0.3 on every note (mono compatibility) */
const PLUCK: ContractOptions = { clicks: PLUCK_CLICKS, minCorrelation: 0.3 };

/**
 * Useful range and intended deviations of each finished voice, as options
 * for assertVoiceContract() (see testing.ts).
 */
export const PLUCKED_CONTRACT: Partial<Record<VoiceId, ContractOptions>> = {
  // E2..E6
  guitar: { range: [40, 88], clicks: PLUCK_CLICKS },
  nylon: { range: [40, 88], ...PLUCK },
  // 21 strings D2..D6, plus a few notes either side
  guzheng: { range: [36, 91], ...PLUCK },
  pluck: { range: [36, 96], ...PLUCK },
  // double bass E1 to the top of the violin's pizzicato range. A pizzicato is
  // shorter than the level window: above A4 it is peak-limited and reads quieter
  pizzicato: { range: [28, 96], rangeLevelTolerance: 8, ...PLUCK },
  // drop-C power chords up to the 24th fret
  overdrive: { range: [36, 88], ...PLUCK },
};

export const PLUCKED_VOICES: Partial<VoiceBank> = {
  guitar,
  nylon,
  guzheng,
  pluck,
  pizzicato,
  overdrive,
};
