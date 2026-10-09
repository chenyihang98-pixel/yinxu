/**
 * Which instruments play in each of the four mixer groups.
 *
 * The arrangement summary lists a work's instruments as one flat list. The
 * grouping is read from the score the composer writes for the same
 * configuration (pure, a few milliseconds, kept by state/score.ts); when
 * that is not possible the flat list is sorted by name, which is right for
 * drums, bass and the lead and puts everything else under 和声.
 */
import { instrumentLabel } from "../../music/catalog";
import type { ArrangementSummary } from "../../music/score";
import { TRACKS } from "../../music/score";
import { VOICE_LABELS } from "../../music/theory";
import { scoreFacts } from "../../state/score";
import type { MusicConfig, TrackName } from "../../types";

export type StemInstruments = Record<TrackName, string[]>;

const empty = (): StemInstruments => ({
  melody: [],
  chords: [],
  bass: [],
  drums: [],
});

const DRUM_NAME = /鼓|打击/;
const BASS_NAME = /贝斯|低音提琴/;

/** Grouping from the names alone. */
export function groupByName(
  names: readonly string[],
  lead: string,
): StemInstruments {
  const groups = empty();
  for (const name of names) {
    const track: TrackName =
      name === lead
        ? "melody"
        : DRUM_NAME.test(name)
          ? "drums"
          : BASS_NAME.test(name)
            ? "bass"
            : "chords";
    if (!groups[track].includes(name)) groups[track].push(name);
  }
  return groups;
}

export interface PartLike {
  kind: "notes" | "drums";
  role: string;
  track: TrackName;
  voice?: string;
}

/**
 * Grouping from the parts of a composed score; drums come from the list.
 * The lead's instrument is named in every group it plays in: when the chords
 * are the pianist's left hand, 和声 says so instead of looking empty.
 */
export function groupByParts(
  parts: readonly PartLike[],
  names: readonly string[],
  config: Pick<MusicConfig, "instrument">,
): StemInstruments {
  const groups = empty();
  const lead = instrumentLabel(config.instrument);
  const voices = new Set<string>(Object.values(VOICE_LABELS));
  const labels: Record<string, string> = VOICE_LABELS;
  const put = (track: TrackName, name: string | undefined) => {
    if (name && names.includes(name) && !groups[track].includes(name))
      groups[track].push(name);
  };
  for (const part of parts) {
    if (part.kind !== "notes") continue;
    if (part.role === "lead" || part.voice === config.instrument)
      put(part.track, lead);
    else if (part.voice) put(part.track, labels[part.voice]);
  }
  // Kits and percussion are the names that are not pitched instruments.
  if (parts.some((part) => part.kind === "drums"))
    for (const name of names)
      if (name !== lead && !voices.has(name)) put("drums", name);
  return groups;
}

/**
 * Instruments per mixer group for a local engine-2 work; empty lists when
 * the work has no arrangement summary (old engine, cloud audio).
 */
export function stemInstruments(
  config: MusicConfig,
  arrangement: Pick<ArrangementSummary, "instruments"> | undefined,
): StemInstruments {
  const names = arrangement?.instruments ?? [];
  if (!names.length || config.engine !== 2) return empty();
  const lead = instrumentLabel(config.instrument);
  const parts = scoreFacts(config)?.parts;
  if (parts) {
    const grouped = groupByParts(parts, names, config);
    const placed = new Set(TRACKS.flatMap((track) => grouped[track]));
    // The score explains the list when every name found a group and the
    // names left for 鼓组 are no more than the drum parts it has.
    const drumParts = parts.filter((part) => part.kind === "drums").length;
    if (
      names.every((name) => placed.has(name)) &&
      grouped.drums.length <= drumParts
    )
      return grouped;
  }
  return groupByName(names, lead);
}
