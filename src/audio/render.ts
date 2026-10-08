/**
 * Score renderer: turns a Score into four finished stereo stems.
 *
 *   for each track (melody, chords, bass, drums)
 *     for each part of the track
 *       every note / hit is rendered by its Voice / DrumVoice into a scratch
 *       buffer and added to the part bus at round(t · sampleRate); in a loop
 *       the tail wraps around the end, otherwise it is cut with a short fade
 *       part chain: lowCut / highCut → drive → chorus → width → pan → duck →
 *       gain, then into the track's stem and its reverb and delay sends
 *     the track's own reverb and ping-pong delay return into its stem, so a
 *     muted track takes its ambience with it
 *   master (master.ts): bus EQ, glue compression, limiter and loudness gain
 *
 * Full-length buffers: 4 stereo stems + 1 stereo part bus + 1 stereo reverb
 * send + 1 mono delay send (6.5 stereo buffers; 300 MB for 120 s at 48 kHz).
 * Everything else works in blocks of a few thousand frames.
 *
 * The async function only orchestrates; all sample loops live in the
 * synchronous Mixer below (V8 runs loops inside an async function, whose
 * locals sit in the coroutine frame, markedly slower).
 */
import { TRACKS } from "../music/score";
import type {
  DrumEvent,
  DrumKitId,
  NoteEvent,
  Part,
  PartMix,
  Score,
  SpaceSettings,
  TrackName,
} from "../music/score";
import type {
  RenderScore,
  RenderScoreOptions,
  RenderedAudio,
  StereoPcm,
} from "./render-types";
import type {
  DrumVoice,
  Voice,
  VoiceBank,
  VoiceContext,
  VoiceNote,
} from "./voices/types";
import { VOICES } from "./voices";
import { DRUMS } from "./drums";
import { clamp, clamp01, createRng, hashSeed } from "./dsp";
import {
  Chorus,
  Drive,
  FX_BLOCK,
  PingPongDelay,
  Reverb,
  cutFilter,
  duckCurve,
  duckRelease,
  fillDuckGains,
  forLoopTail,
  stereoMatrix,
} from "./fx";
import type { BiquadCascade, DuckHit, SendFx } from "./fx";
import { masterStems } from "./master";
import type { MasterReport } from "./master";

export interface RenderBanks {
  voices: VoiceBank;
  drums: DrumVoice;
}

/** What a render did and what it cost; delivered through RenderWithOptions.onReport. */
export interface RenderReport {
  sampleRate: number;
  frames: number;
  notes: number;
  hits: number;
  /** wall-clock seconds per stage (includes time spent inside checkpoint()) */
  seconds: {
    /** voices and drums, including adding each note into its part bus */
    voices: number;
    /** part insert effects and mixing into stems and sends */
    parts: number;
    /** reverb and delay returns */
    sends: number;
    master: number;
    total: number;
  };
  /** full-length Float32Arrays allocated, counted in stereo pairs */
  fullLengthStereoBuffers: number;
  /** bytes of those buffers */
  bufferBytes: number;
  master: MasterReport;
}

export interface RenderWithOptions extends RenderScoreOptions {
  onReport?: (report: RenderReport) => void;
  /**
   * Milliseconds of work between two onProgress / checkpoint calls
   * (default 30). 0 calls them at every opportunity, which tests use to make
   * pacing independent of the machine's speed.
   */
  paceMs?: number;
}

/** Reverb return gain at SpaceSettings.level = 1 for a decay of 2 s (+4 dB over the dry part at a full send). */
export const REVERB_RETURN = 1.6;
/** High-pass in front of every reverb, Hz: keeps kick and bass out of the tail. */
export const REVERB_LOW_CUT = 150;
/**
 * A send whose wet signal would sit more than 34 dB under its dry part is
 * treated as off: it cannot be heard, and a track without audible sends does
 * not need its reverb or delay run at all (typically the bass).
 */
export const SEND_FLOOR = 0.02;
/** Default milliseconds of work between two onProgress / checkpoint calls. */
const PACE_MS = 30;
const MAX_NOTE_SECONDS = 120;
const MAX_TAIL_SECONDS = 30;
/** Seconds of the loop end a part chain hears before frame 0 (filters and chorus settle within this). */
const PART_WARM_SECONDS = 0.3;
/** A note cut off by the end of a non-looping piece fades over this many seconds. */
const CUT_FADE_SECONDS = 0.012;

/**
 * Wet gain of the reverb return. The Reverb itself is normalised to unity
 * (wet RMS = dry RMS for a full send), so a longer decay would otherwise only
 * last longer; the fourth root lets big spaces also sound a little fuller
 * without drowning the mix.
 */
export function reverbReturnGain(space: SpaceSettings): number {
  return (
    clamp01(space.level) *
    REVERB_RETURN *
    Math.pow(clamp(space.decay, 0.2, 10) / 2, 0.25)
  );
}

/**
 * Wet gain of the delay return: the per-part send at face value for any
 * normal space level, fading out together with the reverb when the user
 * turns the ambience down.
 */
export function delayReturnGain(space: SpaceSettings): number {
  return Math.min(1, clamp01(space.level) / 0.45);
}

function hashText(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++)
    hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return hash >>> 0;
}

/** Deterministic random stream of a part: depends only on the score seed and the part id. */
export function partRandom(seed: number, partId: string): () => number {
  return createRng(hashSeed(seed, hashText(partId)));
}

const now: () => number =
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? () => performance.now()
    : (() => {
        // no clock: pretend every query took a millisecond, so pacing still happens
        let fake = 0;
        return () => (fake += 1);
      })();

/** Progress accounting plus the "is it time to yield?" decision. */
class Pacer {
  private done = 0;
  private last = now();
  private reported = 0;

  private readonly paceMs: number;

  constructor(
    private readonly total: number,
    private readonly options: RenderWithOptions,
  ) {
    this.paceMs = options.paceMs ?? PACE_MS;
  }

  add(work: number): void {
    this.done += work;
  }

  /** Progress so far, below 1 until finish(). */
  get fraction(): number {
    const value = this.total > 0 ? this.done / this.total : 0;
    return value > 0.999 ? 0.999 : value;
  }

  private report(value: number): void {
    // never backwards, whatever the work estimate did
    if (value < this.reported) value = this.reported;
    this.reported = value;
    this.options.onProgress?.(value);
  }

  /** Report progress and let the host breathe (or cancel by rejecting). */
  async pause(fraction = this.fraction): Promise<void> {
    this.report(fraction);
    if (this.options.checkpoint) await this.options.checkpoint();
    this.last = now();
  }

  /** pause() if enough time has passed; undefined (nothing to await) otherwise. */
  maybe(fraction = this.fraction): Promise<void> | undefined {
    return now() - this.last >= this.paceMs ? this.pause(fraction) : undefined;
  }

  finish(): void {
    this.report(1);
  }
}

/** Insert effects and mix settings of one part. */
class PartChain {
  readonly filter: BiquadCascade | null;
  readonly drive: Drive | null;
  readonly chorus: Chorus | null;
  /** width · pan · gain as a 2×2 matrix */
  readonly ll: number;
  readonly lr: number;
  readonly rl: number;
  readonly rr: number;
  readonly duck: number;
  /** send amounts, 0 when inaudible */
  readonly reverb: number;
  readonly delay: number;
  /** frames the chain delays the part (oversampled drive) */
  readonly latency: number;
  readonly hasInserts: boolean;
  /** some insert keeps state, so a loop needs a warm-up */
  readonly stateful: boolean;

  constructor(
    mix: PartMix,
    sampleRate: number,
    loopSeconds: number | undefined,
    space: SpaceSettings,
  ) {
    this.filter = cutFilter(sampleRate, mix.lowCut, mix.highCut);
    this.drive = mix.drive > 0.005 ? new Drive(mix.drive) : null;
    this.chorus =
      mix.chorus > 0.005
        ? new Chorus(sampleRate, mix.chorus, { loopSeconds })
        : null;
    const matrix = stereoMatrix(mix.width, mix.pan);
    const gain = Math.max(0, mix.gain);
    this.ll = matrix.ll * gain;
    this.lr = matrix.lr * gain;
    this.rl = matrix.rl * gain;
    this.rr = matrix.rr * gain;
    this.duck = clamp01(mix.duck);
    const reverb = clamp01(mix.reverb);
    const delay = clamp01(mix.delay);
    this.reverb = reverb * reverbReturnGain(space) >= SEND_FLOOR ? reverb : 0;
    this.delay =
      delay * delayReturnGain(space) >= SEND_FLOOR && space.delayTime > 0
        ? delay
        : 0;
    this.latency = this.drive ? this.drive.latency : 0;
    this.hasInserts = Boolean(this.filter || this.drive || this.chorus);
    this.stateful = Boolean(this.filter || this.chorus || this.latency);
  }

  /** The insert effects in place on a block. */
  inserts(left: Float32Array, right: Float32Array, n: number): void {
    this.filter?.process(left, right, n);
    this.drive?.process(left, right, n);
    this.chorus?.process(left, right, n);
  }
}

/** All buffers of a render and every loop that touches samples. Synchronous. */
class Mixer {
  readonly stems: Record<TrackName, StereoPcm>;
  readonly busLeft: Float32Array;
  readonly busRight: Float32Array;
  reverbLeft: Float32Array | null = null;
  reverbRight: Float32Array | null = null;
  delaySend: Float32Array | null = null;
  duck: Float32Array | null = null;
  /** full-length Float32Arrays allocated so far */
  allocated = 0;
  private noteLeft: Float32Array;
  private noteRight: Float32Array;
  private readonly workLeft = new Float32Array(FX_BLOCK);
  private readonly workRight = new Float32Array(FX_BLOCK);
  private readonly wetLeft = new Float32Array(FX_BLOCK);
  private readonly wetRight = new Float32Array(FX_BLOCK);
  private readonly duckGains = new Float32Array(FX_BLOCK);

  constructor(
    readonly frames: number,
    readonly sampleRate: number,
    readonly loop: boolean,
    withBus: boolean,
  ) {
    this.stems = Object.fromEntries(
      TRACKS.map((track) => [
        track,
        [this.allocate(), this.allocate()] as StereoPcm,
      ]),
    ) as Record<TrackName, StereoPcm>;
    this.busLeft = withBus ? this.allocate() : new Float32Array(0);
    this.busRight = withBus ? this.allocate() : new Float32Array(0);
    this.noteLeft = new Float32Array(sampleRate);
    this.noteRight = new Float32Array(sampleRate);
  }

  allocate(): Float32Array {
    this.allocated++;
    return new Float32Array(this.frames);
  }

  clearBus(): void {
    this.busLeft.fill(0);
    this.busRight.fill(0);
  }

  /** Zeroed scratch pair of at least `count` frames. */
  private scratch(count: number): void {
    if (this.noteLeft.length < count) {
      const size = Math.ceil(count * 1.25);
      this.noteLeft = new Float32Array(size);
      this.noteRight = new Float32Array(size);
    } else {
      this.noteLeft.fill(0, 0, count);
      this.noteRight.fill(0, 0, count);
    }
  }

  /**
   * Add the first `count` frames of the scratch pair into the part bus at
   * `start`. Returns true when the end of a non-looping piece cut it short.
   */
  private place(count: number, start: number): boolean {
    const { frames, busLeft, busRight, noteLeft, noteRight } = this;
    let cut = false;
    let source = 0;
    let target = start;
    let length = count;
    if (this.loop) {
      target = ((start % frames) + frames) % frames;
    } else {
      if (target < 0) {
        source = -target;
        target = 0;
      }
      if (target + (length - source) > frames) {
        length = source + Math.max(0, frames - target);
        cut = true;
      }
    }
    while (source < length) {
      const run = Math.min(length - source, frames - target);
      // the hottest loops of the mixer: every frame of every note passes here
      for (let i = 0; i < run; i++) busLeft[target + i] += noteLeft[source + i];
      for (let i = 0; i < run; i++)
        busRight[target + i] += noteRight[source + i];
      source += run;
      target = 0;
    }
    return cut;
  }

  /** -1 = skipped, 0 = placed, 1 = placed but cut off by the end of the piece. */
  note(voice: Voice, event: NoteEvent, context: VoiceContext): number {
    if (
      !(event.d > 0) ||
      !(event.vel > 0) ||
      !Number.isFinite(event.t) ||
      !Number.isFinite(event.midi)
    )
      return -1;
    const note: VoiceNote = {
      midi: event.midi,
      vel: clamp01(event.vel),
      duration: Math.min(event.d, MAX_NOTE_SECONDS),
    };
    if (event.bend) note.bend = event.bend;
    const tail = clamp(voice.tail(note) || 0, 0, MAX_TAIL_SECONDS);
    const count = Math.max(
      1,
      Math.ceil((note.duration + tail) * this.sampleRate),
    );
    const start = Math.round(event.t * this.sampleRate);
    if (!this.loop && (start >= this.frames || start + count <= 0)) return -1;
    this.scratch(count);
    voice.render(this.noteLeft, this.noteRight, count, note, context);
    return this.place(count, start) ? 1 : 0;
  }

  /** -1 = skipped, 0 = placed, 1 = placed but cut off by the end of the piece. */
  hit(
    drums: DrumVoice,
    event: DrumEvent,
    kit: DrumKitId,
    context: VoiceContext,
  ): number {
    if (!(event.vel > 0) || !Number.isFinite(event.t)) return -1;
    const length = clamp(
      drums.length(event.kind, kit) || 0,
      0,
      MAX_TAIL_SECONDS,
    );
    const count = Math.max(1, Math.ceil(length * this.sampleRate));
    const start = Math.round(event.t * this.sampleRate);
    if (!this.loop && (start >= this.frames || start + count <= 0)) return -1;
    this.scratch(count);
    drums.render(
      this.noteLeft,
      this.noteRight,
      count,
      event.kind,
      kit,
      clamp01(event.vel),
      context,
    );
    return this.place(count, start) ? 1 : 0;
  }

  /** Short fade at the very end of the part bus (something was cut off there). */
  fadeBusEnd(): void {
    const { frames, busLeft, busRight } = this;
    const fade = Math.min(
      frames,
      Math.round(CUT_FADE_SECONDS * this.sampleRate),
    );
    for (let i = 0; i < fade; i++) {
      const gain = 0.5 - 0.5 * Math.cos((Math.PI * i) / fade);
      busLeft[frames - 1 - i] *= gain;
      busRight[frames - 1 - i] *= gain;
    }
  }

  /** Let the part's inserts hear the end of the loop before frame 0. */
  warmPart(chain: PartChain): void {
    if (!this.loop || !chain.stateful) return;
    const warm = Math.round(PART_WARM_SECONDS * this.sampleRate);
    chain.chorus?.seek(-warm);
    forLoopTail(
      this.frames,
      warm,
      FX_BLOCK,
      (from, count) => {
        this.workLeft.set(this.busLeft.subarray(from, from + count));
        this.workRight.set(this.busRight.subarray(from, from + count));
        chain.inserts(this.workLeft, this.workRight, count);
      },
    );
  }

  /**
   * Frames [from, from + count) of the part bus through the part chain and
   * into the stem and the sends. Returns a checksum that is NaN or infinite
   * if the part's audio is.
   */
  mixBlock(
    chain: PartChain,
    stem: StereoPcm,
    from: number,
    count: number,
  ): number {
    const { frames, workLeft, workRight, duckGains } = this;
    const stemLeft = stem[0];
    const stemRight = stem[1];
    let sourceLeft = this.busLeft;
    let sourceRight = this.busRight;
    let base = from;
    if (chain.hasInserts) {
      workLeft.set(sourceLeft.subarray(from, from + count));
      workRight.set(sourceRight.subarray(from, from + count));
      chain.inserts(workLeft, workRight, count);
      sourceLeft = workLeft;
      sourceRight = workRight;
      base = 0;
    }
    const { ll, lr, rl, rr } = chain;
    const duck = chain.duck > 0 ? this.duck : null;
    const reverbLeft = chain.reverb > 0 ? this.reverbLeft : null;
    const reverbRight = this.reverbRight;
    const delaySend = chain.delay > 0 ? this.delaySend : null;
    let check = 0;
    // the chain may lag by a few frames: put the block back where it belongs
    let source = 0;
    let target = from - chain.latency;
    if (target < 0) {
      if (this.loop) target += frames;
      else {
        source = -target;
        target = 0;
      }
    }
    while (source < count) {
      const run = Math.min(count - source, frames - target);
      const at = base + source;
      // width, pan, gain and duck in one go; the result stays in the work
      // pair for the sends
      if (duck) {
        fillDuckGains(duckGains, run, duck, target, chain.duck);
        for (let i = 0; i < run; i++) {
          const l = sourceLeft[at + i];
          const r = sourceRight[at + i];
          check += l + r;
          const g = duckGains[i];
          const left = (ll * l + lr * r) * g;
          const right = (rl * l + rr * r) * g;
          workLeft[i] = left;
          workRight[i] = right;
          stemLeft[target + i] += left;
          stemRight[target + i] += right;
        }
      } else
        for (let i = 0; i < run; i++) {
          const l = sourceLeft[at + i];
          const r = sourceRight[at + i];
          check += l + r;
          const left = ll * l + lr * r;
          const right = rl * l + rr * r;
          workLeft[i] = left;
          workRight[i] = right;
          stemLeft[target + i] += left;
          stemRight[target + i] += right;
        }
      if (reverbLeft && reverbRight) {
        const send = chain.reverb;
        for (let i = 0; i < run; i++) {
          reverbLeft[target + i] += workLeft[i] * send;
          reverbRight[target + i] += workRight[i] * send;
        }
      }
      if (delaySend) {
        const send = chain.delay * 0.5;
        for (let i = 0; i < run; i++)
          delaySend[target + i] += (workLeft[i] + workRight[i]) * send;
      }
      source += run;
      target = target + run >= frames ? 0 : target + run;
    }
    return check;
  }

  /** Run `fx` over the tail of the loop so it is ringing at frame 0. */
  warmSend(
    fx: SendFx,
    inLeft: Float32Array,
    inRight: Float32Array,
    warmFrames: number,
  ): void {
    if (!this.loop || warmFrames <= 0) return;
    fx.seek?.(-warmFrames);
    forLoopTail(this.frames, warmFrames, FX_BLOCK, (from, count) =>
      fx.process(
        inLeft.subarray(from, from + count),
        inRight.subarray(from, from + count),
        this.wetLeft,
        this.wetRight,
        count,
      ),
    );
  }

  /** One block of a send effect: `gain` times its wet output is added to the stem. */
  sendBlock(
    fx: SendFx,
    inLeft: Float32Array,
    inRight: Float32Array,
    stem: StereoPcm,
    gain: number,
    from: number,
    count: number,
  ): void {
    const { wetLeft, wetRight } = this;
    fx.process(
      inLeft.subarray(from, from + count),
      inRight.subarray(from, from + count),
      wetLeft,
      wetRight,
      count,
    );
    const stemLeft = stem[0];
    const stemRight = stem[1];
    for (let i = 0; i < count; i++) {
      stemLeft[from + i] += wetLeft[i] * gain;
      stemRight[from + i] += wetRight[i] * gain;
    }
  }
}

function eventCount(part: Part): number {
  return part.kind === "notes" ? part.notes.length : part.hits.length;
}

/**
 * Render `score` with the given voice and drum banks. Deterministic: the same
 * score always produces the same samples, whatever the pacing.
 */
export async function renderScoreWith(
  score: Score,
  banks: RenderBanks,
  options: RenderWithOptions = {},
): Promise<RenderedAudio> {
  const sampleRate = score.sampleRate;
  if (!(sampleRate >= 8000 && sampleRate <= 192000))
    throw new RangeError(`renderScore: unsupported sample rate ${sampleRate}`);
  const frames = Math.max(0, Math.round(score.duration * sampleRate));
  const loop = score.loop;
  const started = now();
  const parts = score.parts.filter(
    (part) => eventCount(part) > 0 && TRACKS.includes(part.track),
  );
  const active = frames > 0 && parts.length > 0;
  const mixer = new Mixer(frames, sampleRate, loop, active);
  const stems = mixer.stems;
  const seconds = { voices: 0, parts: 0, sends: 0, master: 0, total: 0 };
  let noteCount = 0;
  let hitCount = 0;
  let master: MasterReport;

  if (!active) {
    options.onProgress?.(0);
    master = await masterStems(stems, score.master, {
      sampleRate,
      loop,
      seed: score.seed,
    });
    options.onProgress?.(1);
  } else {
    const duration = frames / sampleRate;
    const loopSeconds = loop ? duration : undefined;
    const space = score.space;
    const chains = new Map<Part, PartChain>(
      parts.map((part) => [
        part,
        new PartChain(part.mix, sampleRate, loopSeconds, space),
      ]),
    );
    const chainOf = (part: Part) => chains.get(part) as PartChain;
    const usesReverb = (track: TrackName) =>
      parts.some((part) => part.track === track && chainOf(part).reverb > 0);
    const usesDelay = (track: TrackName) =>
      parts.some((part) => part.track === track && chainOf(part).delay > 0);

    // rough work units for the progress bar: frames weighted by what a stage costs
    let totalWork = frames * 2.5; // master
    for (const part of parts) {
      totalWork += frames * 0.4;
      if (part.kind === "notes")
        for (const note of part.notes)
          totalWork +=
            (clamp(note.d || 0, 0, MAX_NOTE_SECONDS) + 0.5) * sampleRate;
      else totalWork += part.hits.length * 0.3 * sampleRate;
    }
    for (const track of TRACKS)
      totalWork +=
        frames * ((usesReverb(track) ? 0.8 : 0) + (usesDelay(track) ? 0.2 : 0));
    const pacer = new Pacer(totalWork, options);
    options.onProgress?.(0);

    if (TRACKS.some(usesReverb)) {
      mixer.reverbLeft = mixer.allocate();
      mixer.reverbRight = mixer.allocate();
    }
    if (TRACKS.some(usesDelay)) mixer.delaySend = mixer.allocate();

    // kick-keyed ducking curve, shared by every part that asks for it
    const kicks: DuckHit[] = [];
    for (const part of parts)
      if (part.kind === "drums")
        for (const hit of part.hits)
          if (hit.kind === "kick") kicks.push({ t: hit.t, vel: hit.vel });
    if (kicks.length && parts.some((part) => chainOf(part).duck > 0))
      mixer.duck = duckCurve(kicks, frames, sampleRate, {
        release: duckRelease(score.bpm),
        loop,
      });

    for (const track of TRACKS) {
      const trackParts = parts.filter((part) => part.track === track);
      if (!trackParts.length) continue;
      const stem = stems[track];
      const reverbLeft = usesReverb(track) ? mixer.reverbLeft : null;
      const reverbRight = mixer.reverbRight;
      const delaySend = usesDelay(track) ? mixer.delaySend : null;
      reverbLeft?.fill(0);
      if (reverbLeft) reverbRight?.fill(0);
      delaySend?.fill(0);

      for (const part of trackParts) {
        let mark = now();
        mixer.clearBus();
        const context: VoiceContext = {
          sampleRate,
          random: partRandom(score.seed, part.id),
        };
        let cut = false;
        if (part.kind === "notes") {
          const voice = banks.voices[part.voice];
          if (!voice)
            throw new Error(
              `renderScore: no voice "${part.voice}" (part ${part.id})`,
            );
          for (const event of part.notes) {
            const placed = mixer.note(voice, event, context);
            if (placed < 0) continue;
            if (placed) cut = true;
            noteCount++;
            pacer.add((Math.min(event.d, MAX_NOTE_SECONDS) + 0.5) * sampleRate);
            const pending = pacer.maybe();
            if (pending) await pending;
          }
        } else
          for (const event of part.hits) {
            const placed = mixer.hit(banks.drums, event, part.kit, context);
            if (placed < 0) continue;
            if (placed) cut = true;
            hitCount++;
            pacer.add(0.3 * sampleRate);
            const pending = pacer.maybe();
            if (pending) await pending;
          }
        if (cut) mixer.fadeBusEnd();
        seconds.voices += now() - mark;

        mark = now();
        const chain = chainOf(part);
        mixer.warmPart(chain);
        let check = 0;
        for (let from = 0; from < frames; from += FX_BLOCK) {
          const count = Math.min(FX_BLOCK, frames - from);
          check += mixer.mixBlock(chain, stem, from, count);
          pacer.add(count * 0.4);
          const pending = pacer.maybe();
          if (pending) await pending;
        }
        if (!Number.isFinite(check))
          throw new Error(
            `renderScore: part "${part.id}" (${
              part.kind === "notes" ? `voice ${part.voice}` : `kit ${part.kit}`
            }) produced non-finite audio`,
          );
        seconds.parts += now() - mark;
      }

      const mark = now();
      if (reverbLeft && reverbRight) {
        const reverb = new Reverb(sampleRate, space, {
          loopSeconds,
          lowCutHz: REVERB_LOW_CUT,
        });
        const gain = reverbReturnGain(space);
        mixer.warmSend(
          reverb,
          reverbLeft,
          reverbRight,
          Math.ceil(reverb.tailSeconds * 1.4 * sampleRate),
        );
        for (let from = 0; from < frames; from += FX_BLOCK) {
          const count = Math.min(FX_BLOCK, frames - from);
          mixer.sendBlock(
            reverb,
            reverbLeft,
            reverbRight,
            stem,
            gain,
            from,
            count,
          );
          pacer.add(count * 0.8);
          const pending = pacer.maybe();
          if (pending) await pending;
        }
      }
      if (delaySend) {
        const delay = new PingPongDelay(
          sampleRate,
          space.delayTime,
          space.delayFeedback,
        );
        const gain = delayReturnGain(space);
        mixer.warmSend(
          delay,
          delaySend,
          delaySend,
          Math.ceil(Math.min(delay.tailSeconds, 30) * sampleRate),
        );
        for (let from = 0; from < frames; from += FX_BLOCK) {
          const count = Math.min(FX_BLOCK, frames - from);
          mixer.sendBlock(delay, delaySend, delaySend, stem, gain, from, count);
          pacer.add(count * 0.2);
          const pending = pacer.maybe();
          if (pending) await pending;
        }
      }
      seconds.sends += now() - mark;
    }

    const mark = now();
    const masterFrom = pacer.fraction;
    master = await masterStems(stems, score.master, {
      sampleRate,
      loop,
      seed: score.seed,
      // the part bus has done its job; the master may use it as work space
      scratch: mixer.busLeft,
      tick: (fraction) =>
        pacer.maybe(masterFrom + (0.999 - masterFrom) * fraction),
    });
    seconds.master = now() - mark;
    pacer.finish();
  }
  seconds.total = now() - started;

  options.onReport?.({
    sampleRate,
    frames,
    notes: noteCount,
    hits: hitCount,
    seconds: {
      voices: seconds.voices / 1000,
      parts: seconds.parts / 1000,
      sends: seconds.sends / 1000,
      master: seconds.master / 1000,
      total: seconds.total / 1000,
    },
    fullLengthStereoBuffers: mixer.allocated / 2,
    bufferBytes: mixer.allocated * frames * 4,
    master,
  });
  return { sampleRate, frames, stems };
}

/** Render a Score with the built-in voices and drum kits. */
export const renderScore: RenderScore = (score, options) =>
  renderScoreWith(score, { voices: VOICES, drums: DRUMS }, options);
