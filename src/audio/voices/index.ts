/**
 * The complete voice bank: one Voice per VoiceId, assembled from the four
 * group modules. A missing voice is a build error, not a silent fallback:
 * under a test runner this module THROWS at import time, and
 * MISSING_VOICES / ALIASED_VOICES tell you exactly what is left to write.
 */
import { VOICE_IDS } from "../../music/score";
import type { VoiceId } from "../../music/score";
import type { Voice, VoiceBank } from "./types";
import { isAliasVoice } from "../dsp";
import type { ContractOptions } from "./testing";
import { KEYS_CONTRACT, KEYS_VOICES } from "./group-keys";
import { PLUCKED_CONTRACT, PLUCKED_VOICES } from "./group-plucked";
import { SUSTAINED_CONTRACT, SUSTAINED_VOICES } from "./group-sustained";
import { BASS_CONTRACT, BASS_VOICES } from "./group-bass";

export interface AssembledBank {
  voices: Partial<VoiceBank>;
  /** ids from VOICE_IDS no group provides (or whose voice carries another id) */
  missing: VoiceId[];
  /** ids provided by more than one group */
  duplicates: VoiceId[];
  /** ids still served by a temporary alias of another voice */
  aliased: VoiceId[];
}

/** Merge group modules and report what is missing, duplicated or still aliased. */
export function assembleVoiceBank(
  groups: readonly Partial<VoiceBank>[],
): AssembledBank {
  const voices: Partial<VoiceBank> = {};
  const duplicates: VoiceId[] = [];
  for (const group of groups)
    for (const id of VOICE_IDS) {
      const voice = group[id];
      if (!voice) continue;
      if (voices[id]) duplicates.push(id);
      voices[id] = voice;
    }
  const missing = VOICE_IDS.filter((id) => voices[id]?.id !== id);
  const aliased = VOICE_IDS.filter((id) => {
    const voice = voices[id];
    return voice !== undefined && isAliasVoice(voice);
  });
  return { voices, missing, duplicates, aliased };
}

/** "" for a complete bank, otherwise a message naming every missing / duplicated id. */
export function bankProblem(bank: AssembledBank): string {
  if (!bank.missing.length && !bank.duplicates.length) return "";
  return (
    `voice bank is incomplete — missing: [${bank.missing.join(", ")}]` +
    ` duplicated: [${bank.duplicates.join(", ")}]`
  );
}

/**
 * A full VoiceBank from an assembled one. An id without an implementation
 * gets a voice that THROWS when used, so outside the test runner an
 * incomplete bank still loads but can never render a wrong timbre unnoticed.
 */
export function completeBank(bank: AssembledBank): VoiceBank {
  const problem = bankProblem(bank);
  const unimplemented = (id: VoiceId): Voice => {
    const fail = (): never => {
      throw new Error(`voice "${id}" is not implemented (${problem})`);
    };
    return { id, tail: fail, render: fail };
  };
  return Object.fromEntries(
    VOICE_IDS.map((id) => {
      const voice = bank.voices[id];
      return [id, voice && voice.id === id ? voice : unimplemented(id)];
    }),
  ) as VoiceBank;
}

function underTestRunner(): boolean {
  const host = (
    globalThis as {
      process?: {
        env?: Record<string, string | undefined>;
        execArgv?: string[];
      };
    }
  ).process;
  if (!host) return false;
  return (
    host.env?.NODE_TEST_CONTEXT !== undefined ||
    host.env?.NODE_ENV === "test" ||
    host.env?.VITEST !== undefined ||
    (host.execArgv ?? []).includes("--test")
  );
}

const assembled = assembleVoiceBank([
  KEYS_VOICES,
  PLUCKED_VOICES,
  SUSTAINED_VOICES,
  BASS_VOICES,
]);

/** VoiceIds without an implementation. Must be empty. */
export const MISSING_VOICES: readonly VoiceId[] = assembled.missing;
/** VoiceIds two groups both define. Must be empty. */
export const DUPLICATE_VOICES: readonly VoiceId[] = assembled.duplicates;
/** VoiceIds still rendered by a temporary alias (empty once every voice is written). */
export const ALIASED_VOICES: readonly VoiceId[] = assembled.aliased;

if (bankProblem(assembled) && underTestRunner())
  throw new Error(bankProblem(assembled));

export const VOICES: VoiceBank = completeBank(assembled);

/**
 * assertVoiceContract() options per finished voice (useful MIDI range and
 * any intended deviation). Tests check every voice listed here.
 */
export const VOICE_CONTRACTS: Partial<Record<VoiceId, ContractOptions>> = {
  ...KEYS_CONTRACT,
  ...PLUCKED_CONTRACT,
  ...SUSTAINED_CONTRACT,
  ...BASS_CONTRACT,
};
