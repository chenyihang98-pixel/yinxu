// The renderer's reducer: what may change what (regressions for audit APP-01..04, 13).
import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/music/defaults";
import { draftOf } from "../src/state/logic";
import { initialState, reducer } from "../src/state/reducer";
import type { AppAction, AppState } from "../src/state/reducer";
import { canApplyDraft, studioView } from "../src/state/selectors";
import type { Job, StemsAudio } from "../src/state/types";
import { desktopSettings, localProject, stems } from "./helpers/app-fakes";

const start = () => initialState({ desktop: false, version: "test" });

function run(state: AppState, ...actions: AppAction[]): AppState {
  return actions.reduce(reducer, state);
}

const job = (id: number, patch: Partial<Job> = {}): Job => ({
  id,
  kind: "generate",
  stage: "rendering",
  provider: "local",
  brain: "rules",
  phase: "正在作曲与合成",
  progress: 0,
  cancellable: true,
  startedAt: 0,
  ...patch,
});

const audio = (): StemsAudio => ({
  kind: "stems",
  stems: stems(),
  engine: 2,
  peaks: [1],
  stemPeaks: { melody: [1], chords: [1], bass: [1], drums: [1] },
  duration: 0.01,
  sampleRate: 48000,
});

/** A state with `id` loaded (through a job, like the app does it). */
function loaded(id = "p1", state = start()): AppState {
  const project = localProject(id);
  return run(
    state,
    { type: "job/start", job: job(1) },
    { type: "library/upsert", project },
    {
      type: "studio/loaded",
      job: 1,
      project,
      audio: audio(),
      audioError: null,
      thread: [],
      reason: "generated",
      saveState: "saved",
    },
    { type: "job/end", job: 1 },
  );
}

test("typing, pins, engine and producer never touch draft or committed work (APP-03)", () => {
  let state = loaded();
  state = run(
    state,
    { type: "draft/set", field: "bpm", value: 150 },
    { type: "draft/set", field: "instrument", value: "bell" },
    { type: "draft/set", field: "key", value: "D minor" },
    { type: "draft/set", field: "reverb", value: 0.9 },
  );
  const { draft, project, touched } = state.studio;
  const after = run(
    state,
    { type: "composer/text", text: "完全不同的一句话，复古电子 90 BPM 吉他" },
    {
      type: "composer/pins",
      pins: { mood: "retro", duration: 60, loop: false },
    },
    { type: "composer/provider", provider: "tencent" },
    { type: "composer/brain", brain: "llm" },
  );
  assert.equal(after.studio.draft, draft);
  assert.equal(after.studio.touched, touched);
  assert.equal(after.studio.project, project);
  assert.equal(after.library, state.library);
  assert.equal(
    after.studio.composerText,
    "完全不同的一句话，复古电子 90 BPM 吉他",
  );
  assert.deepEqual(after.studio.pins, {
    mood: "retro",
    duration: 60,
    loop: false,
  });
  // Unchanged text is not even a state change.
  assert.equal(
    reducer(after, { type: "composer/text", text: after.studio.composerText }),
    after,
  );
});

test("inspector edits change only the draft; changedFields is computed", () => {
  const state = loaded();
  const edited = run(state, { type: "draft/set", field: "bpm", value: 96 });
  assert.equal(edited.studio.project, state.studio.project);
  assert.equal(edited.library, state.library);
  const view = (value: AppState) =>
    studioView(value.studio, value.settings, {
      canUseCloud: false,
      canUseLlm: false,
    });
  assert.deepEqual(view(edited).changedFields, ["bpm"]);
  assert.equal(view(edited).canApplyDraft, true);
  assert.equal(view(edited).mode, "refine");
  const reverted = run(edited, { type: "draft/set", field: "bpm", value: 112 });
  assert.deepEqual(view(reverted).changedFields, []);
  assert.equal(view(reverted).canApplyDraft, false);
  const reset = run(edited, { type: "draft/reset" });
  assert.deepEqual(reset.studio.draft, draftOf(DEFAULT_CONFIG));
  assert.deepEqual(reset.studio.touched, []);
  // Without a work there is nothing to reset to and nothing to apply.
  assert.equal(
    reducer(start(), { type: "draft/reset" }).studio.draft,
    start().studio.draft,
  );
  assert.equal(canApplyDraft(start().studio), false);
  assert.equal(view(start()).mode, "new");
});

test("an engine-1 work can always be applied (it becomes an engine-2 work)", () => {
  const legacy = localProject("old", {}, { engine: 1 });
  const state = run(
    start(),
    { type: "job/start", job: job(1, { kind: "open" }) },
    {
      type: "studio/loaded",
      job: 1,
      project: legacy,
      audio: { ...audio(), engine: 1 },
      audioError: null,
      thread: [],
      reason: "opened",
      saveState: "idle",
    },
  );
  assert.equal(canApplyDraft(state.studio), true);
});

test("mixer writes the committed volumes, in the studio and in the list (APP-02)", () => {
  let state = loaded();
  state = run(state, { type: "mix/volume", track: "melody", value: 0.3 });
  assert.equal(state.studio.project?.config.volumes.melody, 0.3);
  assert.equal(state.library.projects[0].config.volumes.melody, 0.3);
  assert.equal(state.library.projects[0], state.studio.project);
  assert.ok(!("volumes" in state.studio.draft));
  // Typing afterwards changes neither the slider value nor what will be saved.
  state = run(
    state,
    { type: "composer/text", text: "x" },
    { type: "draft/set", field: "mood", value: "retro" },
  );
  assert.equal(state.studio.project?.config.volumes.melody, 0.3);
  state = run(state, { type: "mix/volume", track: "drums", value: 7 });
  assert.deepEqual(state.studio.project?.config.volumes, {
    melody: 0.3,
    chords: 0.64,
    bass: 0.68,
    drums: 1,
  });
  // Mute remembers, unmute returns.
  state = run(state, { type: "mix/mute", track: "melody", fallback: 0.8 });
  assert.equal(state.studio.project?.config.volumes.melody, 0);
  assert.deepEqual(state.studio.mutedFrom, { melody: 0.3 });
  state = run(state, { type: "mix/mute", track: "melody", fallback: 0.8 });
  assert.equal(state.studio.project?.config.volumes.melody, 0.3);
  assert.deepEqual(state.studio.mutedFrom, {});
  // Moving a muted fader by hand forgets the remembered level.
  state = run(
    state,
    { type: "mix/mute", track: "bass", fallback: 0.68 },
    { type: "mix/volume", track: "bass", value: 0.2 },
  );
  assert.deepEqual(state.studio.mutedFrom, {});
});

test("no mixer without stems: nothing loaded, or a cloud mix", () => {
  const empty = start();
  assert.equal(
    reducer(empty, { type: "mix/volume", track: "melody", value: 0.1 }),
    empty,
  );
  assert.equal(reducer(empty, { type: "studio/solo", track: "drums" }), empty);
  const cloud = run(
    start(),
    { type: "job/start", job: job(1) },
    {
      type: "studio/loaded",
      job: 1,
      project: { ...localProject("c"), provider: "tencent" },
      audio: {
        kind: "mix",
        buffer: stems().melody,
        peaks: [1],
        duration: 1,
        sampleRate: 48000,
      },
      audioError: null,
      thread: [],
      reason: "generated",
      saveState: "saved",
    },
  );
  assert.equal(
    reducer(cloud, { type: "mix/volume", track: "melody", value: 0.1 }),
    cloud,
  );
  assert.equal(
    reducer(cloud, { type: "mix/mute", track: "melody", fallback: 0.8 }),
    cloud,
  );
  assert.equal(reducer(cloud, { type: "studio/solo", track: "drums" }), cloud);
});

test("solo survives everything except a new load or the user (APP-01)", () => {
  let state = run(loaded(), { type: "studio/solo", track: "drums" });
  assert.equal(state.studio.solo, "drums");
  // A job starts, reports, fails or is cancelled: solo, audio and project stay.
  const before = state.studio;
  state = run(
    state,
    { type: "job/start", job: job(2) },
    { type: "job/update", job: 2, patch: { progress: 0.4 } },
    { type: "job/cancel", job: 2, phase: "正在取消" },
    { type: "job/end", job: 2 },
  );
  assert.equal(state.studio.solo, "drums");
  assert.equal(state.studio.audio, before.audio);
  assert.equal(state.studio.project, before.project);
  // A volume change does not clear it either.
  state = run(state, { type: "mix/volume", track: "melody", value: 0.5 });
  assert.equal(state.studio.solo, "drums");
  // A successful load does, together with draft, thread and mute memory.
  const next = localProject("p2", { revision: 2, parentId: "p1" }, { bpm: 90 });
  state = run(
    state,
    { type: "draft/set", field: "bpm", value: 140 },
    { type: "mix/mute", track: "bass", fallback: 0.6 },
    { type: "job/start", job: job(3) },
    {
      type: "studio/loaded",
      job: 3,
      project: next,
      audio: audio(),
      audioError: null,
      thread: [
        {
          id: "u",
          role: "user",
          text: "慢一点",
          at: "2026-10-09T00:00:00.000Z",
        },
      ],
      reason: "generated",
      saveState: "saving",
    },
  );
  assert.equal(state.studio.solo, null);
  assert.deepEqual(state.studio.mutedFrom, {});
  assert.deepEqual(state.studio.draft, draftOf(next.config));
  assert.deepEqual(state.studio.touched, []);
  assert.equal(state.studio.thread.length, 1);
  assert.equal(state.studio.saveState, "saving");
  assert.equal(state.studio.lastLoad?.seq, 2);
  assert.equal(state.studio.lastLoad?.reason, "generated");
});

test("one job at a time; a cancelled or finished job cannot write (S05)", () => {
  const base = loaded();
  let state = run(base, { type: "job/start", job: job(2) });
  // A second start is dropped.
  assert.equal(reducer(state, { type: "job/start", job: job(3) }), state);
  state = run(state, { type: "job/cancel", job: 2, phase: "正在取消" });
  assert.equal(state.studio.job?.stage, "cancelling");
  assert.equal(state.studio.job?.cancellable, false);
  const late: AppAction[] = [
    { type: "job/update", job: 2, patch: { progress: 1, stage: "saving" } },
    {
      type: "studio/loaded",
      job: 2,
      project: localProject("late"),
      audio: audio(),
      audioError: null,
      thread: [],
      reason: "generated",
      saveState: "saved",
    },
    {
      type: "thread/append",
      job: 2,
      turns: [
        {
          id: "x",
          role: "agent",
          text: "迟到",
          at: "2026-10-09T00:00:00.000Z",
        },
      ],
    },
  ];
  for (const action of late)
    assert.equal(reducer(state, action), state, action.type);
  // Results of a job that is not the running one are dropped as well.
  for (const action of late)
    assert.equal(reducer(base, action), base, `${action.type} without a job`);
  const other = run(base, { type: "job/start", job: job(9) });
  for (const action of late)
    assert.equal(
      reducer(other, action),
      other,
      `${action.type} from another job`,
    );
  // Only its own end releases the lock.
  assert.equal(reducer(state, { type: "job/end", job: 7 }), state);
  assert.equal(run(state, { type: "job/end", job: 2 }).studio.job, null);
});

test("the pending user turn lives with its job", () => {
  const mine = {
    id: "u1",
    role: "user" as const,
    text: "慢一点",
    at: "2026-10-09T00:00:00.000Z",
  };
  let state = run(loaded(), {
    type: "job/start",
    job: job(2),
    pendingTurn: mine,
  });
  assert.equal(state.studio.pendingTurn, mine);
  const answered = run(state, {
    type: "thread/append",
    job: 2,
    turns: [
      mine,
      {
        id: "a1",
        role: "agent",
        text: "没听懂",
        at: "2026-10-09T00:00:01.000Z",
      },
    ],
    notes: { a1: { fallbackReason: "大模型暂时不可用，已改用离线规则" } },
  });
  assert.equal(answered.studio.pendingTurn, null);
  assert.equal(answered.studio.thread.length, 2);
  assert.equal(
    answered.studio.turnNotes.a1.fallbackReason,
    "大模型暂时不可用，已改用离线规则",
  );
  state = run(state, { type: "job/cancel", job: 2, phase: "正在取消" });
  assert.equal(state.studio.pendingTurn, null);
  assert.equal(state.studio.thread.length, 0);
});

test("thread never grows past 40 turns", () => {
  let state = run(loaded(), { type: "job/start", job: job(2) });
  const turns = Array.from({ length: 30 }, (_, index) => ({
    id: `t${index}`,
    role: "user" as const,
    text: `${index}`,
    at: "2026-10-09T00:00:00.000Z",
  }));
  state = run(
    state,
    { type: "thread/append", job: 2, turns },
    {
      type: "thread/append",
      job: 2,
      turns: turns.map((item) => ({ ...item, id: `b${item.id}` })),
    },
  );
  assert.equal(state.studio.thread.length, 40);
  assert.equal(state.studio.thread[39].id, "bt29");
  assert.equal(state.studio.thread[0].id, "t20");
});

test("新建创作 clears the work, its thread, the text and the pins — not the library", () => {
  let state = run(
    loaded(),
    { type: "composer/text", text: "写了一半" },
    { type: "composer/pins", pins: { mood: "jazz" } },
    { type: "studio/solo", track: "bass" },
    { type: "composer/provider", provider: "tencent" },
  );
  const library = state.library;
  state = run(state, { type: "studio/unloaded" });
  assert.equal(state.studio.project, null);
  assert.equal(state.studio.audio, null);
  assert.equal(state.studio.solo, null);
  assert.equal(state.studio.composerText, "");
  assert.deepEqual(state.studio.pins, {});
  assert.deepEqual(state.studio.draft, draftOf(DEFAULT_CONFIG));
  assert.equal(state.studio.provider, "tencent");
  assert.equal(state.library, library);
});

test("metadata patches reach the studio and the list; the id cannot change", () => {
  let state = loaded();
  state = run(state, {
    type: "project/patch",
    id: "p1",
    patch: { title: "新名字", favorite: true, id: "hacked" },
  });
  assert.equal(state.studio.project?.title, "新名字");
  assert.equal(state.studio.project?.id, "p1");
  assert.equal(state.library.projects[0].favorite, true);
  assert.equal(
    reducer(state, {
      type: "project/patch",
      id: "nope",
      patch: { title: "x" },
    }),
    state,
  );
  // Save state belongs to the current work only.
  assert.equal(
    reducer(state, {
      type: "studio/saveState",
      id: "other",
      saveState: "failed",
    }),
    state,
  );
  assert.equal(
    run(state, { type: "studio/saveState", id: "p1", saveState: "failed" })
      .studio.saveState,
    "failed",
  );
  assert.equal(
    reducer(state, { type: "studio/peaks", id: "other", peaks: [0] }),
    state,
  );
});

test("soft delete: hidden at once, restorable, and a deleted work cannot stay loaded (APP-06)", () => {
  let state = run(loaded("p1"), {
    type: "library/upsert",
    project: localProject("p2", { updatedAt: "2026-10-02T08:00:00.000Z" }),
  });
  assert.deepEqual(
    state.library.projects.map((item) => item.id),
    ["p2", "p1"],
  );
  state = run(state, { type: "library/hide", id: "p2", expiresAt: 8000 });
  assert.deepEqual(
    state.library.projects.map((item) => item.id),
    ["p1"],
  );
  assert.equal(state.library.removing.length, 1);
  assert.equal(state.studio.project?.id, "p1", "another work stays loaded");
  // A reload of the list while the undo window is open does not bring it back.
  state = run(state, {
    type: "library/loaded",
    projects: [localProject("p2"), localProject("p1")],
    damaged: [],
  });
  assert.deepEqual(
    state.library.projects.map((item) => item.id),
    ["p1"],
  );
  state = run(state, { type: "library/restore", id: "p2" });
  assert.equal(state.library.projects.length, 2);
  assert.equal(state.library.removing.length, 0);
  // Deleting the loaded work unloads it in the same step.
  state = run(
    state,
    { type: "studio/solo", track: "drums" },
    { type: "library/hide", id: "p1", expiresAt: 8000 },
  );
  assert.equal(state.studio.project, null);
  assert.equal(state.studio.audio, null);
  assert.equal(state.studio.solo, null);
  state = run(state, { type: "library/removed", id: "p1" });
  assert.equal(state.library.removing.length, 0);
  assert.equal(
    reducer(state, { type: "library/hide", id: "ghost", expiresAt: 1 }),
    state,
  );
  assert.equal(reducer(state, { type: "library/restore", id: "ghost" }), state);
});

test("library status, damaged records and storage use", () => {
  let state = start();
  assert.equal(state.library.status, "loading");
  state = run(state, {
    type: "library/failed",
    error: "无法读取「我的作品」，请重试。",
  });
  assert.equal(state.library.status, "error");
  state = run(state, {
    type: "library/loaded",
    projects: [localProject("p1")],
    damaged: [{ id: "d1", title: "坏记录", reason: "数据已损坏，无法读取" }],
  });
  assert.equal(state.library.status, "ready");
  assert.equal(state.library.error, null);
  state = run(
    state,
    { type: "library/damagedRemoved", id: "d1" },
    {
      type: "library/storage",
      storage: { usage: 1, quota: 2, persisted: true },
    },
  );
  assert.deepEqual(state.library.damaged, []);
  assert.deepEqual(state.library.storage, {
    usage: 1,
    quota: 2,
    persisted: true,
  });
});

test("settings: unavailable on the web, loaded and merged on desktop", () => {
  const web = start();
  assert.equal(web.settings.status, "unavailable");
  assert.equal(reducer(web, { type: "settings/loading" }), web);
  assert.equal(reducer(web, { type: "settings/failed", error: "x" }), web);
  let desktop = initialState({
    desktop: true,
    version: "0.4.0",
    brain: "llm",
    composerText: "上次写的",
  });
  assert.equal(desktop.settings.status, "loading");
  assert.equal(desktop.studio.brain, "llm");
  assert.equal(desktop.studio.composerText, "上次写的");
  desktop = run(desktop, {
    type: "settings/loaded",
    settings: desktopSettings({ llm: { configured: true, model: "m" } }),
  });
  assert.equal(desktop.settings.status, "ready");
  assert.equal(desktop.settings.providers.tencent.configured, true);
  assert.equal(desktop.settings.providers.aliyun.configured, false);
  assert.equal(desktop.settings.llm.model, "m");
  const view = studioView(desktop.studio, desktop.settings, {
    canUseCloud: true,
    canUseLlm: true,
  });
  assert.equal(view.activeBrain, "llm");
  assert.equal(
    view.engines.find((option) => option.id === "tencent")?.available,
    true,
  );
  desktop = run(desktop, { type: "settings/failed", error: "无法读取设置" });
  assert.equal(desktop.settings.status, "error");
  assert.equal(
    desktop.settings.providers.tencent.configured,
    true,
    "the last known statuses stay",
  );
});

test("shell: pages, modals and toasts", () => {
  let state = start();
  state = run(
    state,
    { type: "ui/navigate", page: "library" },
    { type: "ui/modal", modal: "settings", settingsTab: "llm" },
  );
  assert.equal(state.ui.page, "library");
  assert.equal(state.ui.modal, "settings");
  assert.equal(state.ui.settingsTab, "llm");
  state = run(state, { type: "ui/modal", modal: null });
  assert.equal(state.ui.modal, null);
  assert.equal(state.ui.settingsTab, "llm");
  for (let id = 1; id <= 6; id++)
    state = run(state, {
      type: "toast/push",
      toast: { id, kind: "info", text: `t${id}` },
    });
  assert.deepEqual(
    state.ui.toasts.map((toast) => toast.id),
    [3, 4, 5, 6],
  );
  state = run(state, { type: "toast/dismiss", id: 4 });
  assert.deepEqual(
    state.ui.toasts.map((toast) => toast.id),
    [3, 5, 6],
  );
  assert.equal(reducer(state, { type: "toast/dismiss", id: 99 }), state);
  assert.equal(reducer(state, { type: "ui/navigate", page: "library" }), state);
});

/* ---------------- stored / unsaved, carried draft, questions, works gone elsewhere ---------------- */

test("stored: a fresh result is not in the library until a write says so; unsaved follows from it", () => {
  const web = { canUseCloud: false, canUseLlm: false };
  const unsaved = (state: AppState) =>
    studioView(state.studio, state.settings, web).unsaved;
  const fresh = (saveState: "saving" | "failed" | "saved" | "idle") =>
    run(
      start(),
      { type: "job/start", job: job(1) },
      {
        type: "studio/loaded",
        job: 1,
        project: localProject("p1"),
        audio: audio(),
        audioError: null,
        thread: [],
        reason: saveState === "idle" ? "opened" : "generated",
        saveState,
      },
    );
  assert.equal(fresh("idle").studio.stored, true, "opened from the library");
  assert.equal(fresh("saved").studio.stored, true);
  assert.equal(fresh("saving").studio.stored, false);
  assert.equal(
    unsaved(fresh("saving")),
    false,
    "the first save is simply in flight",
  );
  let state = fresh("failed");
  assert.equal(state.studio.stored, false);
  assert.equal(unsaved(state), true, "exists only in this window");
  // an attempt in flight does not make it "saved"
  state = run(state, {
    type: "studio/saveState",
    id: "p1",
    saveState: "saving",
  });
  assert.equal(state.studio.stored, false);
  state = run(state, {
    type: "studio/saveState",
    id: "p1",
    saveState: "saved",
    stored: true,
  });
  assert.equal(state.studio.stored, true);
  assert.equal(unsaved(state), false);
  // a later failed fader write is "保存失败", but the work itself is in the library
  state = run(state, {
    type: "studio/saveState",
    id: "p1",
    saveState: "failed",
  });
  assert.equal(state.studio.stored, true);
  assert.equal(unsaved(state), false);
  assert.equal(
    reducer(state, { type: "studio/saveState", id: "p1", saveState: "failed" }),
    state,
  );
  assert.equal(
    reducer(state, {
      type: "studio/saveState",
      id: "other",
      saveState: "saved",
      stored: true,
    }),
    state,
  );
  // leaving the work forgets it
  assert.equal(run(state, { type: "studio/unloaded" }).studio.stored, false);
  assert.equal(
    unsaved(run(fresh("failed"), { type: "studio/unloaded" })),
    false,
  );
});

test("a generated work keeps the inspector edits the job did not use (CORE-03)", () => {
  const base = loaded();
  const next = {
    ...localProject("p2"),
    config: { ...localProject("p2").config, bpm: 100 },
  };
  let state = run(
    base,
    { type: "draft/set", field: "reverb", value: 0.9 },
    { type: "job/start", job: job(2) },
  );
  state = run(state, {
    type: "studio/loaded",
    job: 2,
    project: next,
    audio: audio(),
    audioError: null,
    thread: [],
    reason: "generated",
    saveState: "saving",
    // bpm is already what the new version has: nothing pending about it
    carry: { reverb: 0.9, bpm: 100 },
  });
  assert.equal(state.studio.draft.reverb, 0.9);
  assert.equal(state.studio.draft.bpm, 100);
  assert.deepEqual(state.studio.touched, ["reverb"]);
  assert.deepEqual(
    studioView(state.studio, state.settings, {
      canUseCloud: false,
      canUseLlm: false,
    }).changedFields,
    ["reverb"],
  );
  // without anything to carry the draft is the new work's own values
  const plain = run(
    base,
    { type: "draft/set", field: "reverb", value: 0.9 },
    { type: "job/start", job: job(3) },
    {
      type: "studio/loaded",
      job: 3,
      project: next,
      audio: audio(),
      audioError: null,
      thread: [],
      reason: "opened",
      saveState: "idle",
    },
  );
  assert.equal(plain.studio.draft.reverb, next.config.reverb);
  assert.deepEqual(plain.studio.touched, []);
});

test("a question from the core is one object in ui.dialog", () => {
  const dialog = {
    id: 1,
    kind: "paid" as const,
    title: "发送付费生成请求？",
    body: ["将向腾讯云 TokenHub 发送一次新的生成请求，按该服务计费。"],
    choices: [
      { id: "cancel", label: "取消" },
      { id: "confirm", label: "发送请求" },
    ],
    cancel: "cancel",
  };
  let state = start();
  assert.equal(state.ui.dialog, null);
  state = run(state, { type: "ui/dialog", dialog });
  assert.equal(state.ui.dialog, dialog);
  assert.equal(reducer(state, { type: "ui/dialog", dialog }), state);
  assert.equal(run(state, { type: "ui/dialog", dialog: null }).ui.dialog, null);
});

test("library/gone: a work deleted in another window leaves the list, the undo list and the studio", () => {
  let state = run(loaded("p1"), {
    type: "library/upsert",
    project: localProject("p2"),
  });
  // not loaded: it just leaves the list
  state = run(state, { type: "library/gone", id: "p2" });
  assert.deepEqual(
    state.library.projects.map((item) => item.id),
    ["p1"],
  );
  assert.equal(state.studio.project?.id, "p1");
  // waiting for undo here: nothing left to undo
  const hidden = run(
    state,
    { type: "library/upsert", project: localProject("p3") },
    { type: "library/hide", id: "p3", expiresAt: 5 },
  );
  assert.equal(hidden.library.removing.length, 1);
  assert.equal(
    run(hidden, { type: "library/gone", id: "p3" }).library.removing.length,
    0,
  );
  // loaded: unloaded like a delete made here, composer text kept
  const typed = run(state, { type: "composer/text", text: "写到一半" });
  const gone = run(typed, { type: "library/gone", id: "p1" });
  assert.equal(gone.studio.project, null);
  assert.equal(gone.studio.audio, null);
  assert.equal(gone.studio.stored, false);
  assert.equal(gone.studio.composerText, "写到一半");
  assert.deepEqual(gone.library.projects, []);
  // while a job runs on it the studio is left alone (the job's own commit or failure decides)
  const busy = run(state, { type: "job/start", job: job(5) });
  const during = run(busy, { type: "library/gone", id: "p1" });
  assert.equal(during.studio.project?.id, "p1");
  assert.deepEqual(during.library.projects, []);
  assert.equal(reducer(state, { type: "library/gone", id: "ghost" }), state);
});
