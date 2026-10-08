// Transport arithmetic of the player: no Web Audio, no React.
import assert from "node:assert/strict";
import test from "node:test";
import {
  END_ZONE,
  MIX_TIME_CONSTANT,
  RAMP_SECONDS,
  RequestGate,
  START_LEAD,
  TOP_RAMP_SECONDS,
  TransportClock,
  cleanVolume,
  fadeInValue,
  mixTargets,
  resolveSeek,
} from "../src/player/clock";

const near = (actual: number, expected: number, message?: string) =>
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    `${message ?? "value"}: expected ${expected}, got ${actual}`,
  );

function loaded(duration: number, loop = false): TransportClock {
  const clock = new TransportClock();
  clock.load(duration, 0, false);
  if (loop) clock.setLoop(true, 0);
  return clock;
}

test("timing constants stay within what the design promises", () => {
  assert.ok(RAMP_SECONDS >= 0.008 && RAMP_SECONDS <= 0.01, "8-10 ms anti-click ramps");
  assert.ok(TOP_RAMP_SECONDS > 0 && TOP_RAMP_SECONDS < RAMP_SECONDS);
  assert.ok(Math.abs(MIX_TIME_CONSTANT - 0.015) < 1e-12, "~15 ms fader smoothing");
  assert.ok(START_LEAD > 0 && START_LEAD <= 0.05, "imperceptible scheduling lead");
  assert.equal(END_ZONE, 0.01);
});

test("an empty clock sits at zero", () => {
  const clock = new TransportClock();
  assert.equal(clock.duration, 0);
  assert.equal(clock.loop, false);
  assert.equal(clock.running, false);
  assert.equal(clock.position(123), 0);
  assert.equal(clock.startOffset(), 0);
  clock.start(1, 5);
  assert.equal(clock.position(100), 0, "nothing loaded: nothing to play");
  clock.load(Number.NaN, 0, false);
  assert.equal(clock.duration, 0);
  clock.load(-3, 0, false);
  assert.equal(clock.duration, 0);
});

test("position follows the context clock from the scheduled start", () => {
  const clock = loaded(30);
  assert.equal(clock.position(999), 0, "paused: independent of context time");
  clock.start(10.03, 4);
  assert.equal(clock.running, true);
  // the sources are scheduled slightly ahead: until then the playhead waits
  near(clock.position(10), 4);
  near(clock.position(10.03), 4);
  near(clock.position(11.03), 5);
  near(clock.position(20.03), 14);
  // 2.000 s of context time is exactly 2.000 s of audio
  near(clock.position(12.03) - clock.position(10.03), 2);
});

test("a one-shot piece holds at its end; a loop wraps", () => {
  const once = loaded(30);
  once.start(0, 28);
  near(once.position(1.5), 29.5);
  near(once.position(2), 30);
  near(once.position(500), 30);

  const loop = loaded(30, true);
  loop.start(0, 28);
  near(loop.position(1.5), 29.5);
  near(loop.position(2.25), 0.25);
  near(loop.position(2 + 30 * 7 + 12), 12, "after seven more turns");
  assert.ok(loop.position(2 + 30 * 3) < 30);
});

test("pause freezes the audible position and play resumes from it", () => {
  const clock = loaded(30);
  clock.start(5, 0);
  near(clock.pause(12.5), 7.5);
  assert.equal(clock.running, false);
  near(clock.position(999), 7.5);
  near(clock.startOffset(), 7.5);
  // resuming much later, on the same context clock
  clock.start(100, clock.startOffset());
  near(clock.position(101), 8.5);

  // pausing a loop after several turns keeps the folded position
  const loop = loaded(30, true);
  loop.start(0, 20);
  near(loop.pause(75), 5);
  near(loop.startOffset(), 5);
});

test("pressing play at the end starts from the top (v0.2 rule)", () => {
  const clock = loaded(30);
  clock.park(30);
  assert.equal(clock.startOffset(), 0);
  clock.park(30 - END_ZONE / 2);
  assert.equal(clock.startOffset(), 0);
  clock.park(29.98);
  near(clock.startOffset(), 29.98);
  // a piece that played to its end and was paused there by the clamp
  clock.start(0, 29);
  clock.pause(50);
  near(clock.position(0), 30);
  assert.equal(clock.startOffset(), 0);
});

test("seeking while paused moves the playhead at once and playback starts there", () => {
  const clock = loaded(30);
  clock.start(0, 0);
  clock.pause(3);
  clock.park(resolveSeek(12.5, clock.duration, clock.loop).position);
  near(clock.position(3), 12.5);
  near(clock.position(1000), 12.5, "stays put while paused");
  assert.equal(clock.running, false);
  near(clock.startOffset(), 12.5);
  clock.start(40, clock.startOffset());
  near(clock.position(41), 13.5);
  // garbage never poisons the clock
  clock.park(Number.NaN);
  assert.equal(clock.position(0), 0);
  clock.park(-5);
  assert.equal(clock.position(0), 0);
  clock.park(1e9);
  assert.equal(clock.position(0), 30);
});

test("seeking while playing re-anchors the clock at the new voice", () => {
  const clock = loaded(30);
  clock.start(0, 0);
  near(clock.position(4), 4);
  // the player schedules the new voice a little ahead and anchors there
  clock.start(4 + START_LEAD, 20);
  near(clock.position(4), 20, "the target shows immediately, no snap back");
  near(clock.position(5 + START_LEAD), 21);
});

test("turning the loop off while playing keeps the audible position (v0.2 invariant)", () => {
  const clock = loaded(30, true);
  clock.start(10, 5);
  // 70 s later the source has wrapped twice: 5 + 70 = 75 → 15 s into the third pass
  near(clock.position(80), 15);
  clock.setLoop(false, 80);
  assert.equal(clock.loop, false);
  near(clock.position(80), 15, "not clamped to the end by the accumulated time");
  near(clock.position(85), 20, "keeps advancing from the audible position");
  near(clock.position(95), 30, "and now stops at the end of this pass");
  near(clock.position(500), 30);
});

test("turning the loop on while playing lets the playhead wrap from where it is", () => {
  const clock = loaded(30);
  clock.start(0, 20);
  near(clock.position(5), 25);
  clock.setLoop(true, 5);
  near(clock.position(5), 25);
  near(clock.position(12), 2);
  // toggling back and forth never moves the playhead
  clock.setLoop(false, 12);
  near(clock.position(12), 2);
  clock.setLoop(true, 12);
  clock.setLoop(false, 12);
  clock.setLoop(true, 12);
  near(clock.position(12), 2);
  near(clock.position(14), 4);
});

test("toggling the loop before the scheduled start or while paused changes nothing else", () => {
  const clock = loaded(30);
  clock.start(10.03, 7);
  clock.setLoop(true, 10);
  near(clock.position(10), 7);
  near(clock.position(10.03), 7);
  near(clock.position(11.03), 8, "the anchor is still the scheduled start");

  const paused = loaded(30);
  paused.park(12);
  paused.setLoop(true, 999);
  near(paused.position(0), 12);
  assert.equal(paused.running, false);
  near(paused.startOffset(), 12);
});

test("natural end returns to the top, stopped", () => {
  const clock = loaded(30);
  clock.start(0, 25);
  near(clock.position(100), 30);
  clock.finish();
  assert.equal(clock.running, false);
  assert.equal(clock.position(100), 0);
  assert.equal(clock.startOffset(), 0);
});

test("loading new audio stops the clock and can keep the position", () => {
  const clock = loaded(30);
  clock.start(0, 10);
  clock.load(60, 5, true);
  assert.equal(clock.running, false);
  assert.equal(clock.duration, 60);
  near(clock.position(999), 15);
  // a shorter replacement clamps; pressing play then starts from the top
  clock.load(12, 0, true);
  near(clock.position(0), 12);
  assert.equal(clock.startOffset(), 0);
  // without keepPosition a new work starts at zero
  clock.park(7);
  clock.load(40, 0, false);
  assert.equal(clock.position(0), 0);
  // the loop choice belongs to the listener, not to the work
  clock.setLoop(true, 0);
  clock.load(20, 0, false);
  assert.equal(clock.loop, true);
});

test("seek targets are clamped into the audio", () => {
  assert.deepEqual(resolveSeek(12, 30, false), { position: 12, ended: false });
  assert.deepEqual(resolveSeek(-4, 30, false), { position: 0, ended: false });
  assert.deepEqual(resolveSeek(Number.NaN, 30, false), { position: 0, ended: false });
  assert.deepEqual(resolveSeek(Number.NEGATIVE_INFINITY, 30, true), { position: 0, ended: false });
  assert.deepEqual(resolveSeek(5, 0, false), { position: 0, ended: false });
  assert.deepEqual(resolveSeek(5, Number.NaN, true), { position: 0, ended: false });
  assert.deepEqual(resolveSeek(29.98, 30, false), { position: 29.98, ended: false });
});

test("at the end a one-shot piece stops and a loop wraps", () => {
  for (const wanted of [30, 29.995, 29.99, 31, 1e6, Number.POSITIVE_INFINITY]) {
    const target = resolveSeek(wanted, 30, false);
    assert.equal(target.ended, true, String(wanted));
    assert.ok(target.position >= 0 && target.position < 30, `inside [0, duration): ${wanted}`);
    // a loop never ends: the same request wraps to the top and keeps going
    assert.deepEqual(resolveSeek(wanted, 30, true), { position: 0, ended: false }, String(wanted));
  }
  const end = resolveSeek(30, 30, false);
  near(end.position, 30 - END_ZONE / 2);
  // just outside the end zone nothing special happens, looping or not
  assert.deepEqual(resolveSeek(29.98, 30, true), { position: 29.98, ended: false });
  // a piece shorter than the end zone is all "end"
  assert.deepEqual(resolveSeek(0, 0.005, true), { position: 0, ended: false });
  assert.equal(resolveSeek(0, 0.005, false).ended, true);
  // every result stays inside [0, duration)
  for (let i = 0; i <= 1000; i++) {
    const wanted = (i / 1000) * 90 - 10;
    for (const loop of [false, true]) {
      const { position } = resolveSeek(wanted, 30, loop);
      assert.ok(position >= 0 && position < 30, `${wanted} loop=${loop} → ${position}`);
    }
  }
  // a parked "ended" position restarts from the top
  const clock = loaded(30);
  clock.park(end.position);
  assert.equal(clock.startOffset(), 0);
});

test("the clock agrees with a sample-by-sample model of a looping source", () => {
  // Reference: what an AudioBufferSourceNode does, advanced in 1 ms steps.
  const duration = 7.3;
  const step = 0.001;
  let seed = 20261008;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const clock = loaded(duration);
  let now = 0;
  let playhead = 0;
  let playing = false;
  let loop = false;
  let checks = 0;
  const advance = (seconds: number) => {
    const steps = Math.round(seconds / step);
    for (let i = 0; i < steps; i++) {
      now += step;
      if (!playing) continue;
      playhead += step;
      if (playhead >= duration) playhead = loop ? playhead - duration : duration;
    }
  };
  for (let round = 0; round < 400; round++) {
    advance(0.05 + random() * 9);
    const action = Math.floor(random() * 5);
    if (action === 0) {
      loop = !loop;
      clock.setLoop(loop, now);
      // a one-shot source that already ran out restarts from the top when looped
      if (loop && playing && playhead >= duration) playhead = 0;
    } else if (action === 1 && playing) {
      playing = false;
      clock.pause(now);
    } else if (action === 2 && !playing) {
      playing = true;
      playhead = clock.startOffset();
      clock.start(now, playhead);
    } else if (action === 3) {
      const target = resolveSeek(random() * duration * 1.2, duration, loop);
      playhead = target.position;
      if (playing) clock.start(now, playhead);
      else clock.park(playhead);
    }
    const reported = clock.position(now);
    assert.ok(reported >= 0 && reported <= duration);
    // compare on the circle: just before and just after a wrap are neighbours
    const direct = Math.abs(reported - playhead);
    const distance = loop ? Math.min(direct, duration - direct) : direct;
    assert.ok(
      distance < 0.0025,
      `round ${round}: clock ${reported} vs model ${playhead} (loop=${loop}, playing=${playing})`,
    );
    checks++;
  }
  assert.equal(checks, 400);
});

test("play requests: only the newest uncancelled one may start audio", () => {
  const gate = new RequestGate();
  const first = gate.begin();
  assert.equal(gate.isCurrent(first), true);
  // pause while resume() is still pending
  gate.cancel();
  assert.equal(gate.isCurrent(first), false);
  // two quick plays: the earlier one is stale
  const second = gate.begin();
  const third = gate.begin();
  assert.equal(gate.isCurrent(second), false);
  assert.equal(gate.isCurrent(third), true);
  // loading another work, seeking or unmounting cancels whatever is in flight
  gate.cancel();
  gate.cancel();
  assert.equal(gate.isCurrent(third), false);
  const fourth = gate.begin();
  assert.equal(gate.isCurrent(fourth), true);
  assert.equal(new Set([first, second, third, fourth]).size, 4);
  // gates are independent
  assert.equal(new RequestGate().isCurrent(fourth), false);
});

test("fader targets: clamped, and solo silences every other stem", () => {
  const gains = { melody: 0.8, chords: 0.64, bass: 0.68, drums: 0.56 };
  assert.deepEqual(mixTargets(gains, null), gains);
  assert.deepEqual(mixTargets(gains, "drums"), { melody: 0, chords: 0, bass: 0, drums: 0.56 });
  // a soloed stem plays at its own fader level, including silent
  assert.deepEqual(mixTargets({ ...gains, bass: 0 }, "bass"), { melody: 0, chords: 0, bass: 0, drums: 0 });
  assert.deepEqual(
    mixTargets({ melody: 7, chords: -1, bass: Number.NaN, drums: Number.POSITIVE_INFINITY }, null),
    { melody: 1, chords: 0, bass: 0, drums: 0 },
  );
  assert.deepEqual(mixTargets({ melody: 0.5 }, undefined), { melody: 0.5, chords: 0, bass: 0, drums: 0 });
  assert.deepEqual(mixTargets(null, null), { melody: 0, chords: 0, bass: 0, drums: 0 });
  assert.deepEqual(
    mixTargets({ melody: "1" as unknown as number, chords: 1, bass: 1, drums: 1 }, null),
    { melody: 0, chords: 1, bass: 1, drums: 1 },
  );
  // the result is a fresh object: the caller's mix is never mutated
  const result = mixTargets(gains, "melody");
  assert.notEqual(result, gains);
  assert.equal(gains.chords, 0.64);
});

test("the fade-in is known at every instant, so a stop can continue from it", () => {
  assert.equal(fadeInValue(1, 0.01, 0.5), 0);
  assert.equal(fadeInValue(1, 0.01, 1), 0);
  near(fadeInValue(1, 0.01, 1.004), 0.4);
  assert.equal(fadeInValue(1, 0.01, 1.01), 1);
  assert.equal(fadeInValue(1, 0.01, 99), 1);
  assert.equal(fadeInValue(1, 0, 0.99), 0);
  assert.equal(fadeInValue(1, 0, 1), 1);
});

test("listening volume is finite and within 0..1", () => {
  assert.equal(cleanVolume(0.5, 0.8), 0.5);
  assert.equal(cleanVolume(3, 0.8), 1);
  assert.equal(cleanVolume(-1, 0.8), 0);
  assert.equal(cleanVolume(Number.NaN, 0.8), 0.8);
  assert.equal(cleanVolume(Number.POSITIVE_INFINITY, 0.8), 0.8);
  assert.equal(cleanVolume("1" as unknown as number, 0.3), 0.3);
});
