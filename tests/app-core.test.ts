// The app core end to end with fakes for engine, bridge, storage, player and clock.
// Each v0.2 audit finding (APP-01..20) that concerns state has a regression here.
import assert from "node:assert/strict";
import test from "node:test";
import { encodeWav, mixStems } from "../src/audio/engine";
import { DEFAULT_CONFIG } from "../src/music/defaults";
import { studioView } from "../src/state/selectors";
import { exportProject } from "../src/storage";
import type { Project } from "../src/types";
import {
  MP3_BYTES,
  defer,
  desktopSettings,
  fakePlayer,
  harness,
  localProject,
  platformOf,
  settle,
  stems,
} from "./helpers/app-fakes";
import type { Harness } from "./helpers/app-fakes";

const studio = (h: Harness) => h.core.getState().studio;
const library = (h: Harness) => h.core.getState().library;
const toasts = (h: Harness) => h.core.getState().ui.toasts.map((toast) => toast.text);
const lastToast = (h: Harness) => toasts(h).at(-1) ?? "";

/** A started core with one generated local work loaded. */
async function withWork(options: Parameters<typeof harness>[0] = {}) {
  const h = harness(options);
  await h.core.start();
  assert.equal(await h.core.actions.send("夏日海边的轻快钢琴"), true);
  const project = studio(h).project;
  assert.ok(project);
  return { h, first: project };
}

async function desktop(options: Parameters<typeof harness>[0] = {}) {
  const h = harness({ kind: "desktop", ...options });
  await h.core.start();
  assert.ok(h.bridge);
  return { h, bridge: h.bridge };
}

function cloudWork(id: string, patch: Partial<Project> = {}): Project {
  return {
    ...localProject(id),
    provider: "tencent",
    audioBlob: new Blob([MP3_BYTES], { type: "audio/mpeg" }),
    cloud: { prompt: "纯音乐" },
    ...patch,
  };
}

/* ---------------- producing ---------------- */

test("new piece: plan → render → load with committed faders → save → library", async () => {
  const h = harness();
  await h.core.start();
  h.core.actions.setComposerText("国风古筝，悠闲的江南小镇");
  assert.equal(await h.core.actions.send(), true);
  const { project, audio, thread, job, saveState, composerText, lastLoad } = studio(h);
  assert.ok(project && audio);
  assert.equal(project.config.mood, "guofeng");
  assert.equal(project.config.engine, 2);
  assert.equal(project.revision, 1);
  assert.equal(project.parentId, undefined);
  assert.equal(project.provider, "local");
  assert.equal(project.audioDuration, 0.01);
  assert.equal(project.config.seed, h.seeds[0]);
  assert.equal(audio.kind, "stems");
  assert.equal(job, null);
  assert.equal(saveState, "saved");
  assert.equal(composerText, "", "the sent text left the composer");
  assert.deepEqual(lastLoad, { seq: 1, reason: "generated" });
  // The thread is the chat stored with the work: the user's words and the reply.
  assert.equal(thread.length, 2);
  assert.deepEqual(thread.map((turn) => turn.role), ["user", "agent"]);
  assert.equal(thread[0].text, "国风古筝，悠闲的江南小镇");
  assert.equal(thread[1].revision, 1);
  assert.equal(thread[1].brain, "rules");
  assert.deepEqual(project.chat, thread);
  // Player: stems, the committed faders, no solo, autoplay (gesture just now).
  assert.equal(h.player.loads.length, 1);
  const load = h.player.loads[0];
  assert.equal(load.source.kind, "stems");
  assert.deepEqual(load.mix, { gains: project.config.volumes, solo: null });
  assert.equal(load.options?.autoplay, true);
  assert.equal(h.player.unlocks, 1);
  // Library and storage hold exactly this work.
  assert.deepEqual(library(h).projects.map((item) => item.id), [project.id]);
  assert.deepEqual(h.storage.records.get(project.id), project);
  assert.equal(h.storage.persistenceRequests, 1, "asked once, after the first real save");
  assert.match(lastToast(h), /创作完成/);
  assert.equal(h.session.value.lastProjectId, project.id);
  assert.deepEqual(h.log.filter((entry) => !entry.startsWith("bridge")), ["render:engine2", `save:${project.id}`]);
});

test("refinement by message: new version, same seed, parentId, earlier version kept", async () => {
  const { h, first } = await withWork();
  assert.equal(await h.core.actions.send("慢一点，不要鼓"), true);
  const second = studio(h).project;
  assert.ok(second);
  assert.notEqual(second.id, first.id);
  assert.equal(second.revision, 2);
  assert.equal(second.parentId, first.id);
  assert.equal(second.title, first.title);
  assert.equal(second.config.seed, first.config.seed, "same melody material");
  assert.ok(second.config.bpm < first.config.bpm);
  assert.equal(second.config.volumes.drums, 0);
  assert.equal(second.config.prompt, first.config.prompt);
  assert.equal(studio(h).thread.length, 4);
  assert.equal(studio(h).thread[3].revision, 2);
  // Both versions are in the library; the first is untouched.
  assert.deepEqual(library(h).projects.map((item) => item.id).sort(), [first.id, second.id].sort());
  assert.deepEqual(h.storage.records.get(first.id), first);
  assert.equal(h.storage.records.get(first.id)?.chat?.length, 2);
  assert.deepEqual(h.player.loads[1].mix.gains, second.config.volumes);
  // The request the brain saw was a refinement of the committed work.
  assert.deepEqual(h.plans.map((plan) => plan.mode), ["new", "refine"]);
});

test("an unchanged plan generates nothing: the producer just answers", async () => {
  const { h, first } = await withWork();
  const renders = h.renders.length;
  const saves = h.storage.saves.length;
  const loads = h.player.loads.length;
  assert.equal(await h.core.actions.send("xyzzy"), false);
  assert.equal(h.renders.length, renders);
  assert.equal(h.storage.saves.length, saves);
  assert.equal(h.player.loads.length, loads);
  assert.equal(studio(h).project, first);
  assert.equal(studio(h).job, null);
  const thread = studio(h).thread;
  assert.equal(thread.length, 4);
  assert.equal(thread[2].text, "xyzzy");
  assert.equal(thread[3].role, "agent");
  assert.equal(thread[3].revision, undefined, "no version was made");
  assert.match(thread[3].text, /保持不变/);
  // The next real refinement stores the whole conversation, capped.
  assert.equal(await h.core.actions.send("慢一点"), true);
  assert.equal(studio(h).project?.chat?.length, 6);
});

test("the thread stored with a version never exceeds 40 turns", async () => {
  const chat = Array.from({ length: 39 }, (_, index) => ({
    id: `old-${index}`,
    role: index % 2 ? ("agent" as const) : ("user" as const),
    text: `第 ${index} 句`,
    at: "2026-10-01T08:00:00.000Z",
  }));
  const h = harness({ records: [localProject("p1", { chat })] });
  await h.core.start();
  assert.equal(await h.core.actions.openProject("p1"), true);
  assert.equal(studio(h).thread.length, 39);
  assert.equal(await h.core.actions.send("慢一点"), true);
  const stored = studio(h).project?.chat;
  assert.equal(stored?.length, 40);
  assert.equal(stored?.[0].id, "old-1", "the oldest turn went");
  assert.equal(stored?.[39].role, "agent");
  assert.equal(stored?.[38].text, "慢一点");
  assert.equal(h.storage.records.get(studio(h).project?.id ?? "")?.chat?.length, 40);
});

test("应用调整 keeps the seed even after typing in the composer (APP-04)", async () => {
  const { h, first } = await withWork();
  // v0.2: one keystroke replaced the draft seed. Here typing is only text.
  h.core.actions.setComposerText("完全不相干的一句话 90 BPM 吉他");
  h.core.actions.setDraft("bpm", 96);
  h.core.actions.setDraft("instrument", "guzheng");
  h.core.actions.setVolume("melody", 0.3);
  const view = studioView(studio(h), h.core.getState().settings, platformOf("web"));
  assert.deepEqual(view.changedFields, ["bpm", "instrument"]);
  assert.equal(await h.core.actions.applyDraft(), true);
  const second = studio(h).project;
  assert.ok(second);
  assert.equal(second.config.seed, first.config.seed);
  assert.equal(second.config.bpm, 96);
  assert.equal(second.config.instrument, "guzheng");
  assert.equal(second.config.prompt, first.config.prompt, "the description is the committed one");
  assert.equal(second.config.volumes.melody, 0.3, "the mix carries over");
  assert.equal(second.revision, 2);
  assert.equal(second.parentId, first.id);
  assert.equal(studio(h).composerText, "完全不相干的一句话 90 BPM 吉他", "the composer is left alone");
  assert.equal(h.plans.length, 1, "direct controls do not ask a brain");
  const [, , request, reply] = studio(h).thread;
  assert.equal(request.text, `应用调整：速度 ${first.config.bpm} → 96 BPM，主奏乐器换成古筝`);
  assert.equal(reply.brain, undefined);
  assert.equal(reply.revision, 2);
  // Nothing changed now: nothing to apply.
  assert.equal(await h.core.actions.applyDraft(), false);
  assert.equal(h.renders.length, 2);
});

test("换一版旋律 changes the seed and nothing else", async () => {
  const { h, first } = await withWork();
  h.core.actions.setDraft("bpm", 150);
  assert.equal(await h.core.actions.variation(), true);
  const second = studio(h).project;
  assert.ok(second);
  assert.notEqual(second.config.seed, first.config.seed);
  assert.equal(second.config.seed, h.seeds.at(-1));
  assert.deepEqual({ ...second.config, seed: 0 }, { ...first.config, seed: 0 }, "the unapplied draft is not used");
  assert.equal(second.revision, 2);
  assert.equal(studio(h).thread[2].text, "换一版旋律");
  // Without a work there is nothing to vary or apply.
  const empty = harness();
  await empty.core.start();
  assert.equal(await empty.core.actions.variation(), false);
  assert.equal(await empty.core.actions.applyDraft(), false);
  assert.equal(await empty.core.actions.send("   "), false);
  assert.match(lastToast(empty), /先描述一下/);
});

test("pins: chosen style, duration and structure win and are used up by the send", async () => {
  const h = harness();
  await h.core.start();
  h.core.actions.setPin("mood", "jazz");
  h.core.actions.setPin("duration", 60);
  h.core.actions.setPin("loop", false);
  assert.deepEqual(studio(h).pins, { mood: "jazz", duration: 60, loop: false });
  h.core.actions.setPin("loop", undefined);
  assert.deepEqual(studio(h).pins, { mood: "jazz", duration: 60 });
  assert.equal(await h.core.actions.send("国风古筝，15 秒"), true);
  const project = studio(h).project;
  assert.equal(project?.config.mood, "jazz");
  assert.equal(project?.config.duration, 60);
  assert.deepEqual(studio(h).pins, {}, "pins are for one send");
});

/* ---------------- one job, cancel, failure ---------------- */

test("one job at a time: a second request is refused, not queued", async () => {
  const h = harness();
  await h.core.start();
  h.gate.current = defer<void>();
  const running = h.core.actions.send("夏日海边");
  await settle();
  assert.equal(studio(h).job?.stage, "rendering");
  assert.equal(studio(h).job?.progress, 0.5);
  assert.equal(studio(h).pendingTurn?.text, "夏日海边");
  assert.equal(await h.core.actions.send("另一首"), false);
  assert.equal(await h.core.actions.variation(), false);
  assert.equal(h.core.actions.newPiece(), false);
  assert.equal(h.renders.length, 1);
  h.gate.current.resolve();
  assert.equal(await running, true);
  assert.equal(studio(h).job, null);
});

test("a cancelled job cannot write: not the work, the player, the thread or the library (S05)", async () => {
  const { h, first } = await withWork();
  h.core.actions.toggleSolo("drums");
  const before = { ...studio(h) };
  const loads = h.player.loads.length;
  const saves = h.storage.saves.length;
  h.gate.current = defer<void>();
  const running = h.core.actions.send("慢一点");
  await settle();
  assert.equal(studio(h).job?.cancellable, true);
  h.core.actions.cancelJob();
  assert.equal(studio(h).job?.stage, "cancelling");
  assert.equal(lastToast(h), "已取消本地生成");
  assert.equal(studio(h).composerText, "慢一点", "the text comes back");
  // Still locked until the work in flight has stopped.
  assert.equal(await h.core.actions.send("快一点"), false);
  // The render finishes late.
  h.gate.current.resolve();
  assert.equal(await running, false);
  await settle();
  const after = studio(h);
  assert.equal(after.project, first);
  assert.equal(after.audio, before.audio);
  assert.equal(after.solo, "drums", "solo untouched");
  assert.deepEqual(after.thread, before.thread);
  assert.equal(after.job, null);
  assert.equal(h.player.loads.length, loads);
  assert.equal(h.storage.saves.length, saves);
  assert.equal(library(h).projects.length, 1);
  // The lock is free again.
  h.gate.current = null;
  assert.equal(await h.core.actions.send("快一点"), true);
});

test("after a failed or cancelled job, export is still the full committed mix (APP-01)", async () => {
  const { h, first } = await withWork();
  h.core.actions.toggleSolo("drums");
  assert.deepEqual(h.player.mixes.at(-1), { gains: first.config.volumes, solo: "drums" });
  // v0.2: this refine cleared the solo flag but left the solo audio loaded.
  assert.equal(await h.core.actions.send("xyzzy"), false);
  h.gate.current = defer<void>();
  const variation = h.core.actions.variation();
  await settle();
  h.core.actions.cancelJob();
  h.gate.current.resolve();
  await variation;
  h.gate.current = null;
  assert.equal(studio(h).solo, "drums", "the button tells the truth");
  assert.equal(await h.core.actions.exportWork({ kind: "mix" }), true);
  const audio = studio(h).audio;
  assert.ok(audio?.kind === "stems");
  const expected = encodeWav(mixStems(audio.stems, first.config.volumes, 2));
  assert.deepEqual(new Uint8Array(h.files[0].data), new Uint8Array(expected));
  const soloOnly = encodeWav(mixStems(audio.stems, first.config.volumes, 2, "drums"));
  assert.notDeepEqual(new Uint8Array(h.files[0].data), new Uint8Array(soloOnly));
  assert.equal(h.files[0].name, first.title);
  assert.equal(studio(h).exporting, false);
});

test("generation failure: the work stays, the thread says so, the text comes back", async () => {
  const { h, first } = await withWork();
  h.renderError.current = new TypeError("Cannot read properties of undefined (reading 'x')");
  assert.equal(await h.core.actions.send("慢一点"), false);
  assert.equal(studio(h).project, first);
  assert.equal(studio(h).job, null);
  assert.equal(studio(h).saveState, "saved");
  assert.equal(studio(h).composerText, "慢一点");
  const thread = studio(h).thread;
  assert.equal(thread.length, 4);
  assert.equal(thread[3].error, true);
  assert.match(lastToast(h), /^生成失败：本地引擎出错了/);
  assert.ok(!lastToast(h).includes("Cannot read"), "no raw exception text");
  assert.equal(h.storage.saves.length, 1);
  // In the empty state a failure is a toast only: there is no thread yet.
  const fresh = harness();
  await fresh.core.start();
  fresh.renderError.current = new Error("合成器内部错误，请重试。");
  assert.equal(await fresh.core.actions.send("夏日"), false);
  assert.equal(studio(fresh).thread.length, 0);
  assert.equal(lastToast(fresh), "生成失败：合成器内部错误，请重试。");
  assert.equal(studio(fresh).composerText, "夏日");
});

test("save failure is not a generation failure: playable, exportable, 保存失败", async () => {
  const h = harness();
  await h.core.start();
  h.storage.failSave = new Error("本地存储空间不足，作品未保存。请导出已有作品并删除不需要的作品后重试。");
  assert.equal(await h.core.actions.send("夏日海边"), true);
  const { project, audio, saveState } = studio(h);
  assert.ok(project && audio, "the audio is there");
  assert.equal(saveState, "failed");
  assert.equal(h.player.loads.length, 1);
  assert.match(lastToast(h), /^音乐已生成，但保存失败：本地存储空间不足/);
  assert.deepEqual(library(h).projects, [], "not listed as if it were saved");
  assert.equal(await h.core.actions.exportWork({ kind: "mix" }), true);
  // A later successful write (here: a fader) puts it in the library.
  h.storage.failSave = null;
  h.core.actions.setVolume("melody", 0.5);
  h.core.actions.commitMix();
  await settle();
  assert.equal(studio(h).saveState, "saved");
  assert.deepEqual(library(h).projects.map((item) => item.id), [project.id]);
});

test("autoplay only when the gesture is recent; a refusal is silent", async () => {
  const h = harness();
  await h.core.start();
  h.gate.current = defer<void>();
  const running = h.core.actions.send("夏日海边");
  await settle();
  h.clock.advance(61_000);
  h.gate.current.resolve();
  assert.equal(await running, true);
  assert.equal(h.player.loads[0].options?.autoplay, false);
  h.gate.current = null;
  assert.equal(await h.core.actions.send("慢一点"), true);
  assert.equal(h.player.loads[1].options?.autoplay, true);
  const count = toasts(h).length;
  h.core.onPlayerError("浏览器要求先与页面互动才能播放声音，请点击播放按钮开始试听。");
  assert.equal(toasts(h).length, count, "stays paused silently");
  h.clock.advance(6000);
  h.core.onPlayerError("无法初始化音频输出，请检查系统的播放设备后重试。");
  assert.match(lastToast(h), /无法初始化音频输出/);
});

/* ---------------- mixer ---------------- */

test("faders: audible at once, committed, saved 400 ms after the last move (APP-02, APP-08)", async () => {
  const { h, first } = await withWork();
  const saves = h.storage.saves.length;
  const loads = h.player.loads.length;
  for (const value of [0.7, 0.5, 0.3]) {
    h.core.actions.setVolume("melody", value);
    h.clock.advance(100);
  }
  assert.equal(studio(h).project?.config.volumes.melody, 0.3);
  assert.equal(h.player.mixes.length, 3, "one gain move per input event");
  assert.deepEqual(h.player.mixes.at(-1), { gains: { ...first.config.volumes, melody: 0.3 }, solo: null });
  assert.equal(h.player.loads.length, loads, "nothing is re-rendered or reloaded");
  assert.equal(h.storage.saves.length, saves, "not written per event");
  h.clock.advance(299);
  await settle();
  assert.equal(h.storage.saves.length, saves);
  h.clock.advance(1);
  await settle();
  assert.equal(h.storage.saves.length, saves + 1);
  assert.equal(h.storage.records.get(first.id)?.config.volumes.melody, 0.3);
  assert.equal(studio(h).saveState, "saved");
  assert.deepEqual(studio(h).audio?.peaks, [0.3, 0.64, 0.68, 0.56], "the outline follows the faders");
  // v0.2: typing reset the sliders and the next move overwrote the saved mix.
  h.core.actions.setComposerText("x");
  h.core.actions.setDraft("mood", "retro");
  assert.equal(studio(h).project?.config.volumes.melody, 0.3);
  h.core.actions.setVolume("drums", 0.5);
  h.core.actions.commitMix();
  await settle();
  assert.equal(h.storage.saves.length, saves + 2, "pointer up saves at once");
  assert.deepEqual(h.storage.records.get(first.id)?.config.volumes, { ...first.config.volumes, melody: 0.3, drums: 0.5 });
  // Releasing with nothing pending writes nothing.
  h.core.actions.commitMix();
  await settle();
  assert.equal(h.storage.saves.length, saves + 2);
  assert.equal(library(h).projects[0].config.volumes.drums, 0.5);
  assert.equal(studio(h).project?.id, first.id, "no new version");
  assert.equal(studio(h).project?.revision, 1);
});

test("mute and solo: mute is saved, solo is playback only", async () => {
  const { h, first } = await withWork();
  const saves = h.storage.saves.length;
  h.core.actions.toggleMute("drums");
  await settle();
  assert.equal(studio(h).project?.config.volumes.drums, 0);
  assert.equal(h.storage.saves.length, saves + 1);
  assert.equal(h.storage.records.get(first.id)?.config.volumes.drums, 0);
  h.core.actions.toggleMute("drums");
  await settle();
  assert.equal(studio(h).project?.config.volumes.drums, first.config.volumes.drums, "back to where it was");
  h.core.actions.toggleSolo("bass");
  assert.equal(studio(h).solo, "bass");
  assert.equal(h.player.mixes.at(-1)?.solo, "bass");
  h.core.actions.toggleSolo("bass");
  assert.equal(studio(h).solo, null);
  h.core.actions.toggleSolo("melody");
  h.clock.advance(5000);
  await settle();
  assert.equal(h.storage.saves.length, saves + 2, "solo never writes");
  assert.deepEqual(h.storage.records.get(first.id)?.config.volumes, first.config.volumes);
});

test("a pending fader save belongs to the work it was made on", async () => {
  const { h, first } = await withWork();
  h.core.actions.setVolume("bass", 0.1);
  // Before the 400 ms pass, a new version replaces the current work.
  assert.equal(await h.core.actions.send("慢一点"), true);
  await settle();
  const second = studio(h).project;
  assert.ok(second && second.id !== first.id);
  assert.equal(h.storage.records.get(first.id)?.config.volumes.bass, 0.1, "written before the switch");
  assert.equal(second.config.volumes.bass, 0.1, "the refinement started from the committed mix");
  h.clock.advance(1000);
  await settle();
  assert.equal(h.storage.records.get(second.id)?.config.volumes.bass, 0.1);
  assert.equal(studio(h).saveState, "saved");
});

/* ---------------- opening ---------------- */

test("an engine-1 work opens through the legacy engine; what is made from it is engine 2", async () => {
  const legacy = localProject("old", { title: "旧作品", audioDuration: 30 }, { engine: 1, mood: "chill", instrument: "guitar", key: "A minor", bpm: 84 });
  const h = harness({ records: [legacy] });
  await h.core.start();
  assert.equal(await h.core.actions.openProject("old"), true);
  assert.equal(h.renders[0].engine, 1);
  assert.deepEqual(h.renders[0], legacy.config, "rendered exactly as stored");
  const audio = studio(h).audio;
  assert.ok(audio?.kind === "stems");
  assert.equal(audio.engine, 1);
  assert.equal(audio.arrangement, undefined);
  const load = h.player.loads[0];
  assert.ok(load.source.kind === "stems" && load.source.engine === 1);
  assert.equal(load.options?.autoplay, false);
  assert.equal(studio(h).project?.config.engine, 1, "opening does not convert it");
  assert.equal(studio(h).saveState, "idle");
  assert.equal(h.core.getState().ui.page, "studio");
  assert.equal(studioView(studio(h), h.core.getState().settings, platformOf("web")).canApplyDraft, true);
  // The stored duration is corrected once (30 → 0.01 in this fake).
  await settle();
  assert.equal(h.storage.records.get("old")?.audioDuration, 0.01);
  assert.equal(h.storage.records.get("old")?.config.engine, 1);
  // A refinement creates an engine-2 work and leaves the old one alone.
  assert.equal(await h.core.actions.send("慢一点"), true);
  const next = studio(h).project;
  assert.equal(next?.config.engine, 2);
  assert.equal(next?.parentId, "old");
  assert.equal(next?.revision, 2);
  assert.equal(next?.config.seed, legacy.config.seed);
  assert.equal(h.renders[1].engine, 2);
  assert.equal(h.storage.records.get("old")?.config.engine, 1);
});

test("opening: quick play, already loaded, missing, busy, and cancel wording (APP-13)", async () => {
  const a = localProject("a");
  const b = localProject("b", { updatedAt: "2026-10-02T08:00:00.000Z" });
  const { h, bridge } = await desktop({ records: [a, b] });
  assert.equal(await h.core.actions.openProject("a", { autoplay: true }), true);
  assert.equal(h.player.loads[0].options?.autoplay, true);
  assert.equal(studio(h).thread.length, 0);
  // Already loaded: no second render; quick play just plays.
  h.core.actions.navigate("library");
  assert.equal(await h.core.actions.openProject("a", { autoplay: true }), true);
  assert.equal(h.renders.length, 1);
  assert.equal(h.player.plays, 1);
  assert.equal(h.core.getState().ui.page, "studio");
  assert.equal(await h.core.actions.openProject("ghost"), false);
  assert.match(lastToast(h), /找不到这首作品/);
  // The composer's engine selector says "tencent" while a LOCAL work is opening.
  h.core.actions.setProvider("tencent");
  assert.equal(studio(h).provider, "tencent");
  h.gate.current = defer<void>();
  const opening = h.core.actions.openProject("b");
  await settle();
  assert.equal(studio(h).job?.kind, "open");
  assert.equal(studio(h).job?.provider, "local");
  assert.equal(studio(h).job?.progress, 0.5, "a local open shows progress");
  assert.equal(await h.core.actions.openProject("a"), false, "busy");
  h.core.actions.cancelJob();
  assert.equal(lastToast(h), "已取消打开作品");
  assert.ok(!bridge.calls.includes("cancelGeneration"), "nothing cloud was running");
  h.gate.current.resolve();
  assert.equal(await opening, false);
  assert.equal(studio(h).project?.id, "a", "the cancelled open changed nothing");
});

test("session restore: the last work and the composer text, without playing", async () => {
  const h = harness({
    records: [localProject("p1"), localProject("p2")],
    session: { lastProjectId: "p2", composerText: "写到一半", brain: "llm" },
  });
  assert.equal(studio(h).composerText, "写到一半");
  await h.core.start();
  await h.core.start();
  assert.equal(studio(h).project?.id, "p2");
  assert.equal(h.player.loads.length, 1, "start() is idempotent");
  assert.equal(h.player.loads[0].options?.autoplay, false);
  assert.equal(h.player.unlocks, 0);
  assert.equal(studio(h).lastLoad?.reason, "restored");
  assert.equal(studio(h).brain, "llm");
  assert.equal(studioView(studio(h), h.core.getState().settings, platformOf("web")).activeBrain, "rules", "no model on the web");
  // A work that no longer exists is simply not restored.
  const gone = harness({ session: { lastProjectId: "deleted" } });
  await gone.core.start();
  assert.equal(studio(gone).project, null);
  assert.equal(library(gone).status, "ready");
  // Typing is remembered a moment later, not per keystroke.
  h.core.actions.setComposerText("a");
  h.core.actions.setComposerText("ab");
  const writes = h.session.writes.length;
  h.clock.advance(499);
  assert.equal(h.session.writes.length, writes);
  h.clock.advance(1);
  assert.equal(h.session.writes.length, writes + 1);
  assert.deepEqual(h.session.value, { lastProjectId: "p2", composerText: "ab", brain: "llm", pendingRemovals: [] });
  assert.equal(h.core.actions.newPiece(), true);
  assert.equal(h.session.value.lastProjectId, null);
  assert.equal(h.player.unloads, 1);
});

test("an unreadable library is reported and does not stop composing", async () => {
  const h = harness();
  h.storage.failList = new Error("当前环境不允许使用本地作品库（隐私模式、受限的内嵌页面或已禁用网站数据）。");
  await h.core.start();
  assert.equal(library(h).status, "error");
  assert.match(library(h).error ?? "", /不允许使用本地作品库/);
  assert.equal(await h.core.actions.send("夏日海边"), true);
  assert.ok(studio(h).audio);
});

test("a rebuilt interface gets the loaded work back in its new player (error boundary recovery)", async () => {
  const { h, first } = await withWork();
  h.core.actions.setVolume("melody", 0.25);
  h.core.actions.toggleSolo("bass");
  const loads = h.player.loads.length;
  // The same player attached again (an effect that re-runs) reloads nothing.
  h.core.attachPlayer(h.player);
  assert.equal(h.player.loads.length, loads);
  // The component tree failed and was rebuilt: the old player is gone, a new one arrives.
  h.core.detachPlayer();
  const rebuilt = fakePlayer();
  h.core.attachPlayer(rebuilt);
  assert.equal(h.player.loads.length, loads, "nothing more goes to the old player");
  assert.equal(rebuilt.loads.length, 1, "the loaded work is handed to the new one");
  assert.equal(rebuilt.loads[0].source.kind, "stems");
  assert.equal(rebuilt.loads[0].mix.gains.melody, 0.25, "with the committed faders");
  assert.equal(rebuilt.loads[0].mix.solo, "bass", "and the solo the mixer still shows");
  assert.equal(rebuilt.loads[0].options?.autoplay, false, "paused");
  assert.equal(studio(h).project?.id, first.id);
  // The mixer keeps working on the new player.
  h.core.actions.setVolume("drums", 0.1);
  assert.equal(rebuilt.mixes.at(-1)?.gains.drums, 0.1);
  // A job that finishes while no interface is mounted loads its audio nowhere…
  h.core.detachPlayer();
  h.gate.current = defer<void>();
  const running = h.core.actions.send("慢一点");
  await settle();
  h.gate.current.resolve();
  assert.equal(await running, true);
  assert.equal(rebuilt.loads.length, 1);
  // …and the next player gets the new version.
  const third = fakePlayer();
  h.core.attachPlayer(third);
  assert.equal(third.loads.length, 1);
  assert.equal(studio(h).project?.revision, 2);
  assert.equal(third.loads[0].options?.autoplay, false);
  // Nothing loaded: nothing to hand over.
  const empty = harness();
  await empty.core.start();
  const other = fakePlayer();
  empty.core.attachPlayer(other);
  assert.equal(other.loads.length, 0);
});

/* ---------------- library ---------------- */

test("delete is soft with an undo window; cloud audio asks first (APP-06)", async () => {
  const h = harness({ records: [localProject("a"), localProject("b"), cloudWork("c")] });
  await h.core.start();
  assert.equal(h.core.actions.removeProject("a"), "removed");
  assert.deepEqual(library(h).projects.map((item) => item.id).sort(), ["b", "c"]);
  assert.equal(h.storage.deletes.length, 0, "nothing is deleted yet");
  const toast = h.core.getState().ui.toasts.at(-1);
  assert.equal(toast?.text, "已删除《夏日小事》");
  assert.equal(toast?.action?.label, "撤销");
  h.clock.advance(7000);
  toast?.action?.run();
  assert.equal(library(h).projects.length, 3);
  assert.ok(!h.core.getState().ui.toasts.some((item) => item.id === toast?.id));
  h.clock.advance(5000);
  await settle();
  assert.equal(h.storage.deletes.length, 0, "undo cancelled the deletion");
  assert.ok(h.storage.records.has("a"));
  // Paid audio: the first click deletes nothing.
  assert.equal(h.core.actions.removeProject("c"), "confirm");
  assert.equal(library(h).projects.length, 3);
  assert.equal(h.core.actions.removeProject("c", true), "removed");
  assert.equal(h.core.actions.removeProject("ghost"), "refused");
  h.clock.advance(7999);
  await settle();
  assert.ok(h.storage.records.has("c"));
  h.clock.advance(1);
  await settle();
  assert.deepEqual(h.storage.deletes, ["c"]);
  assert.equal(library(h).removing.length, 0);
  // Undo after the window does nothing.
  h.core.actions.undoRemove("c");
  assert.equal(library(h).projects.length, 2);
});

test("deleting the loaded work unloads it, and its fader save cannot bring it back", async () => {
  const { h, first } = await withWork();
  h.core.actions.setVolume("melody", 0.2);
  assert.equal(h.core.actions.removeProject(first.id), "removed");
  assert.equal(studio(h).project, null);
  assert.equal(h.player.unloads, 1);
  assert.equal(h.session.value.lastProjectId, null);
  await settle();
  assert.equal(h.storage.records.get(first.id)?.config.volumes.melody, 0.2, "the last mix was written first");
  assert.deepEqual(library(h).projects, [], "and the save did not re-list it");
  h.clock.advance(8000);
  await settle();
  assert.equal(h.storage.records.has(first.id), false);
  // While a job runs, deleting is refused.
  h.gate.current = defer<void>();
  const running = h.core.actions.send("新的一首");
  await settle();
  assert.equal(h.core.actions.removeProject("anything"), "refused");
  h.gate.current.resolve();
  await running;
  const id = studio(h).project?.id ?? "";
  h.gate.current = defer<void>();
  const again = h.core.actions.send("慢一点");
  await settle();
  assert.equal(h.core.actions.removeProject(id), "refused");
  assert.match(lastToast(h), /完成或取消后再试/);
  h.gate.current.resolve();
  await again;
});

test("closing the page carries out pending deletions; hiding it only flushes", async () => {
  const { h, first } = await withWork();
  h.core.actions.removeProject(first.id);
  h.core.flush();
  await settle();
  assert.equal(h.storage.deletes.length, 0);
  h.core.close();
  await settle();
  assert.deepEqual(h.storage.deletes, [first.id]);
});

test("a deletion is remembered in the session until the record is really gone", async () => {
  const h = harness({ records: [localProject("a"), localProject("b"), localProject("c")] });
  await h.core.start();
  assert.deepEqual(h.session.value.pendingRemovals, []);
  h.core.actions.removeProject("a");
  assert.deepEqual(h.session.value.pendingRemovals, ["a"], "written at once, before anything asynchronous");
  h.core.actions.removeProject("b");
  assert.deepEqual(h.session.value.pendingRemovals, ["a", "b"]);
  h.core.actions.undoRemove("a");
  assert.deepEqual(h.session.value.pendingRemovals, ["b"], "an undone deletion is forgotten");
  // Other session writes keep the list.
  h.core.actions.setComposerText("写点什么");
  h.clock.advance(500);
  assert.deepEqual(h.session.value.pendingRemovals, ["b"]);
  h.clock.advance(8000);
  await settle();
  assert.deepEqual(h.storage.deletes, ["b"]);
  assert.deepEqual(h.session.value.pendingRemovals, [], "nothing left to finish");
  // A deletion that fails puts the work back and is not retried behind the user's back.
  h.storage.deleteProject = async () => {
    throw new Error("作品库连接已断开，无法删除。请重试。");
  };
  h.core.actions.removeProject("c");
  assert.deepEqual(h.session.value.pendingRemovals, ["c"]);
  h.clock.advance(8000);
  await settle();
  assert.ok(library(h).projects.some((item) => item.id === "c"));
  assert.match(lastToast(h), /删除失败，作品仍在作品库中/);
  assert.deepEqual(h.session.value.pendingRemovals, []);
});

test("the page went away inside the undo window: the next start finishes the deletion", async () => {
  // What a real page leaves behind: the id in the session, the record still stored
  // (the write started during pagehide never happened).
  const h = harness({
    records: [localProject("kept"), localProject("doomed")],
    session: { lastProjectId: "doomed", composerText: "", brain: "rules", pendingRemovals: ["doomed", "already-gone"] },
  });
  await h.core.start();
  assert.deepEqual(h.storage.deletes, ["doomed", "already-gone"]);
  assert.equal(h.log.indexOf("delete:doomed") < h.log.indexOf("render:engine2") || !h.log.includes("render:engine2"), true);
  assert.deepEqual(library(h).projects.map((item) => item.id), ["kept"], "the deleted work does not come back");
  assert.equal(studio(h).project, null, "and it is not restored as the last work");
  assert.equal(h.player.loads.length, 0);
  assert.deepEqual(h.session.value.pendingRemovals, []);
  assert.deepEqual(toasts(h), [], "finishing old business is silent");
  // A library that cannot be written: the work stays, nothing is retried forever.
  const broken = harness({ records: [localProject("x")], session: { pendingRemovals: ["x"] } });
  broken.storage.deleteProject = async () => {
    throw new Error("作品库连接已断开");
  };
  await broken.core.start();
  assert.deepEqual(library(broken).projects.map((item) => item.id), ["x"]);
  assert.deepEqual(broken.session.value.pendingRemovals, []);
});

test("rename and favourite: no redundant writes, rollback on failure (APP-19, APP-20)", async () => {
  const { h, first } = await withWork();
  const saves = h.storage.saves.length;
  assert.equal(await h.core.actions.rename(first.id, first.title), false);
  assert.equal(await h.core.actions.rename(first.id, `  ${first.title}  `), false);
  assert.equal(await h.core.actions.rename(first.id, "   "), false);
  assert.equal(h.storage.saves.length, saves, "an unchanged title writes nothing");
  assert.equal(await h.core.actions.rename(first.id, " 海边的下午 "), true);
  assert.equal(studio(h).project?.title, "海边的下午");
  assert.equal(library(h).projects[0].title, "海边的下午");
  assert.equal(h.storage.records.get(first.id)?.title, "海边的下午");
  assert.equal(library(h).projects[0].updatedAt, first.updatedAt, "renaming does not reorder the library");
  assert.equal(await h.core.actions.toggleFavourite(first.id), true);
  assert.equal(studio(h).project?.favorite, true);
  h.storage.failSave = new Error("作品库连接已断开，无法保存。请重试。");
  assert.equal(await h.core.actions.toggleFavourite(first.id), false);
  assert.equal(studio(h).project?.favorite, true, "rolled back");
  assert.equal(library(h).projects[0].favorite, true);
  assert.match(lastToast(h), /^收藏状态没有保存：作品库连接已断开/);
  assert.equal(await h.core.actions.rename(first.id, "失败的名字"), false);
  assert.equal(studio(h).project?.title, "海边的下午");
  assert.equal(await h.core.actions.rename("ghost", "x"), false);
  // A version made afterwards keeps the user's title.
  h.storage.failSave = null;
  assert.equal(await h.core.actions.send("慢一点"), true);
  assert.equal(studio(h).project?.title, "海边的下午");
});

test("import: a project JSON becomes a new work and is opened", async () => {
  const { h, first } = await withWork();
  const text = exportProject(first);
  const file = { name: "夏日.json", size: text.length, text: async () => text };
  assert.equal(await h.core.actions.importFile(file), true);
  const imported = studio(h).project;
  assert.ok(imported && imported.id !== first.id);
  assert.deepEqual(imported.config, first.config);
  assert.equal(library(h).projects.length, 2);
  assert.equal(studio(h).thread.length, 2, "the conversation travels with the file");
  assert.equal(h.player.loads.at(-1)?.options?.autoplay, false);
  assert.equal(await h.core.actions.importFile({ size: 5, text: async () => "{bad" }), false);
  assert.match(lastToast(h), /无法读取工程文件/);
  assert.equal(await h.core.actions.importFile({ size: 2 * 1024 * 1024, text: async () => "" }), false);
  assert.match(lastToast(h), /小于 1 MB/);
  const cloud = JSON.stringify({ ...JSON.parse(text), provider: "tencent" });
  assert.equal(await h.core.actions.importFile({ size: cloud.length, text: async () => cloud }), false);
  assert.match(lastToast(h), /不包含音频/);
  assert.equal(library(h).projects.length, 2);
});

test("damaged records are listed, exportable as raw data and removable", async () => {
  const h = harness({ records: [localProject("ok")] });
  h.storage.damaged = [{ id: "bad", title: "坏掉的作品", reason: "由更新版本的音序创建，请升级后打开" }];
  h.storage.raw.set("bad", '{"id":"bad","title":"坏掉的作品","config":{"mood":"polka"}}');
  await h.core.start();
  assert.equal(library(h).projects.length, 1, "good works are not hidden by a bad one");
  assert.deepEqual(library(h).damaged.map((item) => item.id), ["bad"]);
  assert.equal(await h.core.actions.exportDamaged("bad"), true);
  assert.equal(h.files[0].format, "json");
  assert.equal(h.files[0].name, "坏掉的作品-原始数据");
  assert.match(new TextDecoder().decode(h.files[0].data), /polka/);
  assert.equal(await h.core.actions.exportDamaged("nope"), false);
  assert.equal(await h.core.actions.removeDamaged("bad"), true);
  assert.deepEqual(h.storage.deletes, ["bad"]);
  assert.deepEqual(library(h).damaged, []);
  assert.equal(await h.core.actions.removeDamaged("bad"), false);
});

/* ---------------- cloud ---------------- */

test("cloud generation: prompt from the plan, stored before decoding, mixed audio loaded", async () => {
  const { h, bridge } = await desktop();
  h.core.actions.setProvider("tencent");
  let sent: { prompt: string; duration: number; provider?: string } | undefined;
  bridge.generate = async (input) => {
    sent = input;
    return { audio: MP3_BYTES.slice().buffer, mimeType: "audio/mpeg" };
  };
  assert.equal(await h.core.actions.send("雨夜咖啡馆，慵懒的钢琴"), true);
  const { project, audio, saveState } = studio(h);
  assert.ok(project && audio);
  assert.equal(audio.kind, "mix");
  assert.equal(project.provider, "tencent");
  assert.equal(project.audioDuration, 0.02, "the decoded length");
  assert.equal(project.cloud?.prompt, sent?.prompt);
  assert.equal(project.cloud?.model, "minimax-music-v3.0");
  assert.match(sent?.prompt ?? "", /纯音乐，无人声，无歌词/);
  assert.equal(sent?.provider, "tencent");
  assert.equal(sent?.duration, project.config.duration);
  assert.deepEqual(new Uint8Array(await (project.audioBlob as Blob).arrayBuffer()), MP3_BYTES);
  assert.equal(saveState, "saved");
  assert.equal(h.player.loads[0].source.kind, "mix");
  const order = h.log.filter((entry) => /^(bridge:generateMusic|save|decode)/.test(entry));
  assert.deepEqual(order.slice(0, 3), ["bridge:generateMusic:tencent", `save:${project.id}`, "decode"]);
  assert.equal(h.storage.records.get(project.id)?.audioDuration, 0.02);
  assert.equal(library(h).projects[0].audioDuration, 0.02);
  // No mixer for a mixed track.
  h.core.actions.setVolume("melody", 0.1);
  h.core.actions.toggleSolo("drums");
  assert.equal(studio(h).project, project);
  assert.equal(studio(h).solo, null);
  // Export: WAV of the decoded mix, or the exact original bytes.
  assert.equal(await h.core.actions.exportWork({ kind: "original" }), true);
  assert.deepEqual(new Uint8Array(h.files[0].data), MP3_BYTES);
  assert.equal(h.files[0].format, "mp3");
});

test("cloud audio that cannot be decoded stays in the library and can be exported (APP-05)", async () => {
  const { h } = await desktop();
  h.core.actions.setProvider("tencent");
  h.decodeError.current = new DOMException("Unable to decode audio data", "EncodingError");
  assert.equal(await h.core.actions.send("雨夜咖啡馆"), true);
  const { project, audio, audioError, saveState } = studio(h);
  assert.ok(project);
  assert.equal(audio, null);
  assert.match(audioError ?? "", /无法解码/);
  assert.equal(saveState, "saved");
  assert.ok(h.storage.records.get(project.id)?.audioBlob, "the paid audio is in the library");
  assert.deepEqual(library(h).projects.map((item) => item.id), [project.id]);
  assert.equal(h.player.loads.length, 0);
  assert.equal(await h.core.actions.exportWork({ kind: "original" }), true);
  assert.deepEqual(new Uint8Array(h.files[0].data), MP3_BYTES);
  assert.equal(await h.core.actions.exportWork({ kind: "mix" }), false);
  assert.match(lastToast(h), /无法导出 WAV/);
  // Reopening tries to decode again and never calls the service.
  const calls = h.bridge?.calls.filter((call) => call.startsWith("generateMusic")).length;
  h.decodeError.current = null;
  assert.equal(await h.core.actions.openProject(project.id), true);
  assert.equal(studio(h).audio?.kind, "mix");
  assert.equal(studio(h).audioError, null);
  assert.equal(h.bridge?.calls.filter((call) => call.startsWith("generateMusic")).length, calls);
});

test("cloud: cancel while waiting is honest about billing; a late result is kept, not loaded", async () => {
  const local = localProject("mine");
  const { h, bridge } = await desktop({ records: [local] });
  await h.core.actions.openProject("mine");
  h.core.actions.setProvider("tencent");
  const answer = defer<{ audio: ArrayBuffer; mimeType: string }>();
  bridge.generate = () => answer.promise;
  const running = h.core.actions.send("换成更慵懒的感觉，慢一点");
  await settle();
  assert.equal(studio(h).job?.stage, "cloud");
  assert.equal(studio(h).job?.progress, null);
  assert.match(studio(h).job?.phase ?? "", /腾讯云 TokenHub 正在创作/);
  h.core.actions.cancelJob();
  assert.equal(lastToast(h), "已取消等待。已提交的云端生成可能仍会计费。");
  assert.ok(bridge.calls.includes("cancelGeneration"));
  // The service answers anyway (the request could not be withdrawn in time).
  answer.resolve({ audio: MP3_BYTES.slice().buffer, mimeType: "audio/mpeg" });
  assert.equal(await running, false);
  await settle();
  assert.equal(studio(h).project?.id, "mine", "the current work is untouched");
  assert.equal(h.player.loads.length, 1);
  assert.equal(h.decodes, 0);
  const kept = library(h).projects.find((item) => item.provider === "tencent");
  assert.ok(kept?.audioBlob, "but the paid audio is in the library");
  assert.equal(kept.parentId, "mine");
  assert.match(lastToast(h), /取消后到达，已保存/);
  // Normal case: the main process rejects after a cancel — nothing is added.
  const count = library(h).projects.length;
  const refused = defer<{ audio: ArrayBuffer; mimeType: string }>();
  bridge.generate = () => refused.promise;
  const second = h.core.actions.send("再慢一点");
  await settle();
  h.core.actions.cancelJob();
  refused.reject(new Error("已取消生成。"));
  assert.equal(await second, false);
  assert.equal(library(h).projects.length, count);
  assert.equal(studio(h).job, null);
});

test("cloud: service errors are shown as they are; a failed save keeps the audio playable", async () => {
  const { h, bridge } = await desktop();
  h.core.actions.setProvider("tencent");
  bridge.generate = async () => {
    throw new Error("Error invoking remote method 'muse:generate-music': Error: API Key 无效或已过期，请在设置中更新密钥。");
  };
  assert.equal(await h.core.actions.send("雨夜咖啡馆"), false);
  assert.equal(lastToast(h), "生成失败：API Key 无效或已过期，请在设置中更新密钥。");
  assert.equal(studio(h).project, null);
  assert.equal(studio(h).composerText, "雨夜咖啡馆");
  bridge.generate = async () => ({ audio: MP3_BYTES.slice().buffer, mimeType: "audio/mpeg" });
  h.storage.failSave = new Error("本地存储空间不足，作品未保存。");
  assert.equal(await h.core.actions.send(), true);
  assert.ok(studio(h).audio, "decoded and playable");
  assert.equal(studio(h).saveState, "failed");
  assert.match(lastToast(h), /保存失败：本地存储空间不足.*导出.*原始音频/);
  assert.deepEqual(library(h).projects, []);
  assert.equal(await h.core.actions.exportWork({ kind: "original" }), true);
});

test("service limits are checked against the planned configuration before paying (APP-19)", async () => {
  const { h, bridge } = await desktop({ records: [localProject("mine", {}, { duration: 60 })] });
  await h.core.actions.openProject("mine");
  h.core.actions.setProvider("volcengine");
  // The current work is 60 s, but the message asks for 15 s: refused, unpaid.
  assert.equal(await h.core.actions.send("改成 15 秒"), false);
  assert.match(lastToast(h), /火山引擎 AI 音乐支持 30–120 秒，这次的时长是 15 秒/);
  assert.ok(!bridge.calls.some((call) => call.startsWith("generateMusic")));
  assert.equal(studio(h).thread.at(-1)?.error, true);
  // And the other way round: a 15 s work refined to 45 s is fine.
  assert.equal(await h.core.actions.send("改成 45 秒"), true);
  assert.equal(studio(h).project?.config.duration, 45);
});

test("a loaded work borrows the engine selector; leaving it returns the user's own choice", async () => {
  const { h } = await desktop({ records: [localProject("mine"), cloudWork("paid")] });
  assert.equal(studio(h).provider, "local");
  // Listening to an old cloud work must not make the next new piece a paid one.
  assert.equal(await h.core.actions.openProject("paid"), true);
  assert.equal(studio(h).provider, "tencent", "refinements continue on the work's engine");
  assert.equal(h.core.actions.newPiece(), true);
  assert.equal(studio(h).provider, "local");
  assert.equal(await h.core.actions.openProject("paid"), true);
  h.core.actions.chooseInspiration({ text: "夏日海边" });
  assert.equal(studio(h).provider, "local");
  assert.equal(await h.core.actions.openProject("paid"), true);
  assert.equal(h.core.actions.removeProject("paid", true), "removed");
  assert.equal(studio(h).project, null);
  assert.equal(studio(h).provider, "local", "deleting the loaded work leaves the empty composer on the user's engine");
  h.core.actions.undoRemove("paid");
  // A choice made by hand is the one that comes back, in both directions.
  h.core.actions.setProvider("tencent");
  assert.equal(await h.core.actions.openProject("mine"), true);
  assert.equal(studio(h).provider, "local");
  assert.equal(h.core.actions.newPiece(), true);
  assert.equal(studio(h).provider, "tencent");
  // …unless that service is no longer usable.
  assert.equal(await h.core.actions.openProject("mine"), true);
  assert.deepEqual(await h.core.actions.removeProvider("tencent"), { ok: true });
  assert.equal(h.core.actions.newPiece(), true);
  assert.equal(studio(h).provider, "local");
  assert.equal(h.bridge?.calls.includes("generateMusic"), false, "none of this generated anything");
});

test("engines and producers that cannot be used are refused with a way forward", async () => {
  const web = harness();
  await web.core.start();
  web.core.actions.setProvider("tencent");
  assert.equal(studio(web).provider, "local");
  assert.match(lastToast(web), /只在 Windows 桌面版中可用/);
  assert.equal(web.core.getState().ui.modal, null);
  web.core.actions.setBrain("llm");
  assert.equal(studio(web).brain, "rules");
  assert.equal(web.core.getState().settings.status, "unavailable");
  assert.deepEqual(await web.core.actions.saveLlm({ kind: "ollama", preset: "ollama", apiKey: "", model: "m" }), {
    ok: false,
    message: "这项设置只在 Windows 桌面版中可用。",
  });

  const { h, bridge } = await desktop();
  h.core.actions.setProvider("aliyun");
  assert.equal(studio(h).provider, "local");
  assert.match(lastToast(h), /请先在设置中保存阿里云百炼 Fun-Music 的服务凭据/);
  assert.equal(h.core.getState().ui.modal, "settings");
  assert.equal(h.core.getState().ui.settingsTab, "music");
  h.core.actions.closeModal();
  h.core.actions.setBrain("llm");
  assert.equal(studio(h).brain, "rules");
  assert.equal(h.core.getState().ui.settingsTab, "llm");
  assert.equal(lastToast(h), "请先在设置中填写大模型的连接信息。");
  // Stored but unreadable settings are a different problem with a different fix.
  bridge.settings = { ...bridge.settings, llm: { configured: true, damaged: true } };
  await h.core.actions.refreshSettings();
  h.core.actions.closeModal();
  h.core.actions.setBrain("llm");
  assert.equal(studio(h).brain, "rules");
  assert.equal(lastToast(h), "大模型设置无法读取，请在设置中重新保存。");
  assert.equal(h.core.getState().ui.modal, "settings");
  assert.equal(h.core.getState().ui.settingsTab, "llm");
  bridge.settings = { ...bridge.settings, llm: { configured: false } };
  await h.core.actions.refreshSettings();
  // Saving a service makes it selectable; failures come back for the form.
  assert.deepEqual(await h.core.actions.saveProvider("aliyun", { apiKey: "sk-test-123456", workspaceId: "ws" }), { ok: true });
  h.core.actions.setProvider("aliyun");
  assert.equal(studio(h).provider, "aliyun");
  bridge.saveProviderCredentials = async () => {
    throw new Error("API Key 格式不正确，请粘贴完整密钥。");
  };
  assert.deepEqual(await h.core.actions.saveProvider("tencent", { apiKey: "x" }), {
    ok: false,
    message: "API Key 格式不正确，请粘贴完整密钥。",
  });
  // Removing the selected service falls back to local.
  assert.deepEqual(await h.core.actions.removeProvider("aliyun"), { ok: true });
  assert.equal(studio(h).provider, "local");
});

test("the language model plans only when it is selected and configured; failures fall back", async () => {
  const { h, bridge } = await desktop();
  assert.equal(await h.core.actions.send("夏日海边"), true);
  assert.deepEqual(h.plans.map((plan) => plan.llm), [false]);
  assert.ok(!bridge.calls.includes("agentPlan"));
  assert.deepEqual(await h.core.actions.saveLlm({ kind: "anthropic", preset: "anthropic", apiKey: "sk-ant-test-0000", model: "claude-opus-5-5" }), { ok: true });
  assert.equal(studio(h).brain, "llm", "saving a model selects it");
  assert.equal(h.session.value.brain, "llm");
  // The model answers with a plan.
  bridge.plan = async (input) => ({
    model: "claude-opus-5-5",
    plan: {
      reply: "慢下来了，换成了古筝。",
      title: "x",
      style: input.current.style,
      instrument: "guzheng",
      key: input.current.key,
      bpm: 90,
      duration: input.current.duration,
      energy: input.current.energy,
      complexity: input.current.complexity,
      reverb: input.current.reverb,
      loop: input.current.loop,
      newMelody: false,
      volumes: input.current.volumes,
      arrangement: {
        progression: [],
        form: [],
        drums: "auto",
        bass: "auto",
        swing: -1,
        layers: { pad: "auto", arp: "auto", counter: "auto", perc: "auto" },
        melody: { density: -1, register: "auto", motion: "auto" },
      },
      reasoning: ["速度降到 90", "主奏换成古筝"],
      cloudPrompt: "",
    },
  });
  assert.equal(await h.core.actions.send("慢一点，换成古筝"), true);
  assert.equal(h.plans.at(-1)?.llm, true);
  const turn = studio(h).thread.at(-1);
  assert.equal(turn?.brain, "llm");
  assert.equal(turn?.text, "慢下来了，换成了古筝。");
  assert.equal(studio(h).turnNotes[turn?.id ?? ""]?.model, "claude-opus-5-5");
  assert.equal(studio(h).project?.config.bpm, 90);
  assert.equal(studio(h).project?.config.instrument, "guzheng");
  // The model fails: the rules answer, and the user is told.
  bridge.plan = async () => {
    throw new Error("大模型超过 90 秒没有回应，已停止等待。");
  };
  assert.equal(await h.core.actions.send("快一点"), true);
  const fallback = studio(h).thread.at(-1);
  assert.equal(fallback?.brain, "rules");
  // one clause of what happened, then what was done about it: no advice, nothing in brackets
  assert.equal(studio(h).turnNotes[fallback?.id ?? ""]?.fallbackReason, "大模型超过 90 秒没有回应，已改用离线规则");
  assert.ok(toasts(h).includes("大模型超过 90 秒没有回应，已改用离线规则"));
  // Direct controls never ask the model.
  const asked = bridge.calls.filter((call) => call === "agentPlan").length;
  assert.equal(await h.core.actions.variation(), true);
  assert.equal(bridge.calls.filter((call) => call === "agentPlan").length, asked);
  // Cancelling while the model thinks tells the main process.
  const thinking = defer<never>();
  bridge.plan = () => thinking.promise;
  const running = h.core.actions.send("更有活力");
  await settle();
  assert.equal(studio(h).job?.stage, "planning");
  assert.equal(studio(h).job?.brain, "llm");
  h.core.actions.cancelJob();
  assert.ok(bridge.calls.includes("cancelAgent"));
  assert.equal(lastToast(h), "已取消本次编排");
  thinking.reject(new Error("已取消本次编排。"));
  assert.equal(await running, false);
  assert.equal(h.renders.length, 4, "the fallback plan of a cancelled job is not rendered");
  assert.deepEqual(await h.core.actions.removeLlm(), { ok: true });
  assert.equal(studio(h).brain, "rules");
});

test("opening a cloud work only decodes its stored bytes and follows its engine when usable", async () => {
  const stored = cloudWork("c1", { chat: [{ id: "u1", role: "user", text: "雨夜", at: "2026-10-01T08:00:00.000Z" }] });
  const { h, bridge } = await desktop({ records: [stored, cloudWork("c2", { provider: "elevenlabs" })] });
  assert.equal(await h.core.actions.openProject("c1"), true);
  assert.equal(studio(h).audio?.kind, "mix");
  assert.equal(studio(h).provider, "tencent");
  assert.equal(studio(h).thread.length, 1);
  assert.equal(h.renders.length, 0);
  assert.ok(!bridge.calls.some((call) => call.startsWith("generateMusic")));
  assert.equal(await h.core.actions.openProject("c2"), true);
  assert.equal(studio(h).provider, "local", "elevenlabs is not configured here");
  // No bytes at all: opened with a clear message instead of failing.
  const broken = harness({ kind: "desktop", records: [{ ...cloudWork("c3"), audioBlob: undefined }] });
  await broken.core.start();
  assert.equal(await broken.core.actions.openProject("c3"), true);
  assert.equal(studio(broken).audio, null);
  assert.equal(studio(broken).audioError, "这首作品的音频文件不可用。");
});

test("a cancelled open cannot write either, although decoding cannot be aborted", async () => {
  const { h } = await desktop({ records: [localProject("mine"), cloudWork("c1")] });
  await h.core.actions.openProject("mine");
  const loads = h.player.loads.length;
  h.decodeGate.current = defer<void>();
  const opening = h.core.actions.openProject("c1");
  await settle();
  assert.equal(studio(h).job?.stage, "decoding");
  assert.equal(studio(h).job?.progress, null);
  h.core.actions.cancelJob();
  assert.equal(lastToast(h), "已取消打开作品");
  // The decoder finishes anyway, with perfectly good audio.
  h.decodeGate.current.resolve();
  assert.equal(await opening, false);
  await settle();
  assert.equal(studio(h).project?.id, "mine");
  assert.equal(studio(h).audio?.kind, "stems");
  assert.equal(h.player.loads.length, loads, "the late audio never reached the player");
  assert.equal(h.player.unloads, 0);
  assert.equal(studio(h).job, null);
  assert.equal(h.session.value.lastProjectId, "mine");
});

/* ---------------- shell ---------------- */

test("inspiration and new piece: text and style pin into an empty studio", async () => {
  const { h } = await withWork();
  h.core.actions.navigate("inspiration");
  h.core.actions.chooseInspiration({ text: "爵士小馆：摇摆的行走贝斯", mood: "jazz" });
  assert.equal(studio(h).project, null);
  assert.equal(studio(h).composerText, "爵士小馆：摇摆的行走贝斯");
  assert.deepEqual(studio(h).pins, { mood: "jazz" });
  assert.equal(h.core.getState().ui.page, "studio");
  assert.equal(library(h).projects.length, 1, "the work is still in the library");
  h.core.actions.chooseInspiration({ text: "雨天咖啡馆" });
  assert.deepEqual(studio(h).pins, {});
  assert.equal(await h.core.actions.send(), true);
  assert.equal(studio(h).project?.revision, 1, "a new lineage");
  assert.equal(studio(h).project?.parentId, undefined);
  assert.equal(studio(h).thread.length, 2);
});

test("toasts dismiss themselves: info after 4 s, errors after 8 s", async () => {
  const h = harness();
  h.core.actions.notify("已保存");
  h.core.actions.notify("出错了", "error");
  h.core.actions.notify("   ");
  assert.equal(toasts(h).length, 2);
  h.clock.advance(4000);
  assert.deepEqual(toasts(h), ["出错了"]);
  h.clock.advance(4000);
  assert.deepEqual(toasts(h), []);
  h.core.actions.openModal("export");
  assert.equal(h.core.getState().ui.modal, null, "nothing to export");
  h.core.actions.openModal("help");
  assert.equal(h.core.getState().ui.modal, "help");
});

test("the fake stems are what the tests think they are", () => {
  assert.equal(stems().melody.getChannelData(0)[0], Math.fround(0.1));
  assert.equal(DEFAULT_CONFIG.engine, 2);
  assert.equal(desktopSettings().providers.tencent.configured, true);
});
