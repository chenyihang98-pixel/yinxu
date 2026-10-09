// Billing safety, data safety and state: regressions for the v0.3 review
// (CORE-01…09, RB-01…07, UX-01/03/10). Same fakes as app-core.test.ts; two
// harnesses on one SharedOrigin are two tabs.
import assert from "node:assert/strict";
import test from "node:test";
import { melodyNote } from "../src/agent/cloudPrompt";
import { planWithRules } from "../src/agent/rules";
import type { AgentPlan, AgentTurn } from "../src/agent/types";
import { STYLES, styleLabel } from "../src/music/catalog";
import { stylePreset } from "../src/music/defaults";
import { styleInspiration } from "../src/state/content";
import { formatBpm } from "../src/state/format";
import { fittedTiming } from "../src/state/score";
import {
  OUT_OF_MEMORY_TEXT,
  SAVE_RETRY_MS,
  appendPhrase,
  carriedDraft,
  draftOf,
  errorText,
  rebaseVolumes,
} from "../src/state/logic";
import {
  applyHint,
  buildAgentRequest,
  canSendPinsOnly,
  enforcePins,
  honestPlan,
  paidNotice,
  pinsOnlyText,
  planFromDraft,
  planPreview,
  planVariation,
  variationLabel,
  withStylePrompt,
} from "../src/state/plan";
import { initialState, reducer } from "../src/state/reducer";
import type { AppState } from "../src/state/reducer";
import { studioView } from "../src/state/selectors";
import { SYNC_KEY, createTabSync, parseSyncMessage } from "../src/state/sync";
import type { SyncMessage } from "../src/state/sync";
import type { Toast } from "../src/state/types";
import {
  lineage,
  lineageOf,
  nextRevisionIn,
  versionOfTurn,
} from "../src/state/works";
import type { Project } from "../src/types";
import {
  MP3_BYTES,
  defer,
  harness,
  localProject,
  platformOf,
  settle,
  sharedOrigin,
} from "./helpers/app-fakes";
import type { Harness } from "./helpers/app-fakes";

const studio = (h: Harness) => h.core.getState().studio;
const library = (h: Harness) => h.core.getState().library;
const ui = (h: Harness) => h.core.getState().ui;
const toasts = (h: Harness) => ui(h).toasts.map((toast) => toast.text);
const view = (h: Harness) =>
  studioView(
    studio(h),
    h.core.getState().settings,
    platformOf(h.bridge ? "desktop" : "web"),
  );
const paidCalls = (h: Harness) =>
  (h.bridge?.calls ?? []).filter((call) => call.startsWith("generateMusic"))
    .length;
const ids = (h: Harness) =>
  library(h)
    .projects.map((item) => item.id)
    .sort();

/** Answer the question on screen. */
async function answer(h: Harness, choice: string, remember = false) {
  await settle();
  const dialog = ui(h).dialog;
  assert.ok(dialog, "a question is on screen");
  h.core.actions.answerDialog(dialog.id, choice, remember);
  await settle();
  return dialog;
}

/** Start something that costs money and say yes to the question it has to ask. */
async function paid<T>(
  h: Harness,
  action: () => Promise<T>,
  remember = false,
): Promise<T> {
  const running = action();
  await answer(h, "confirm", remember);
  return running;
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

async function desktop(options: Parameters<typeof harness>[0] = {}) {
  const h = harness({ kind: "desktop", ...options });
  await h.core.start();
  assert.ok(h.bridge);
  return { h, bridge: h.bridge };
}

async function withWork(options: Parameters<typeof harness>[0] = {}) {
  const h = harness(options);
  await h.core.start();
  assert.equal(await h.core.actions.send("夏日海边的轻快钢琴"), true);
  const first = studio(h).project;
  assert.ok(first);
  return { h, first };
}

const turn = (
  id: string,
  role: "user" | "agent",
  revision?: number,
): AgentTurn => ({
  id,
  role,
  text: id,
  at: "2026-10-01T08:00:00.000Z",
  ...(revision !== undefined ? { revision } : {}),
});

/* ================================================================== */
/* paid requests are never a surprise                                   */
/* ================================================================== */

test("CORE-01 / UX-01: with a cloud engine nothing is sent without a yes, and a chip never sends", async () => {
  // The session restores a cloud work: nobody picked a paid engine in this session.
  const { h } = await desktop({
    records: [cloudWork("paid")],
    session: { lastProjectId: "paid" },
  });
  assert.equal(studio(h).project?.id, "paid");
  assert.equal(
    studio(h).provider,
    "tencent",
    "refinements continue on the work's own engine",
  );
  // The cost is on screen before anything is clicked.
  const notice = view(h).paid;
  assert.equal(
    notice?.text,
    "将向腾讯云 TokenHub 发送一次新的生成请求，按该服务计费；云端每次都是重新生成，不保留原旋律。",
  );
  assert.equal(view(h).variationLabel, "重新生成一版（计费）");
  assert.match(view(h).applyHint, /重新生成一首并计费，不保留原旋律/);
  assert.ok(
    view(h)
      .engines.filter((engine) => engine.id !== "local" && engine.available)
      .every((engine) => engine.billing === "按服务商计费"),
  );
  // One click on a chip: the phrase goes into the composer, nothing is sent.
  h.core.actions.setComposerText("再安静一些");
  const chips = view(h).suggestions;
  assert.ok(chips.length >= 4);
  for (const chip of chips)
    assert.equal(await h.core.actions.pickSuggestion(chip), false);
  await settle();
  assert.equal(paidCalls(h), 0, "four chips used to be four paid requests");
  assert.equal(ui(h).dialog, null);
  assert.equal(studio(h).job, null);
  assert.ok(
    studio(h).composerText.startsWith("再安静一些，"),
    "what was typed is still there",
  );
  for (const chip of chips) assert.ok(studio(h).composerText.includes(chip));
  // Sending asks first. No: nothing is sent and nothing is lost.
  h.core.actions.setComposerText("慢一点");
  const refused = h.core.actions.send();
  const dialog = await answer(h, "cancel");
  assert.equal(dialog.kind, "paid");
  assert.match(
    dialog.body.join(""),
    /腾讯云 TokenHub 发送一次新的生成请求，按该服务计费.*不保留原旋律.*仍可能计费/,
  );
  assert.equal(dialog.remember, "本次会话不再提示（腾讯云 TokenHub）");
  assert.equal(dialog.cancel, "cancel");
  assert.equal(await refused, false);
  assert.equal(paidCalls(h), 0);
  assert.equal(studio(h).composerText, "慢一点");
  assert.equal(studio(h).thread.length, 0);
  // While the question is open, nothing else starts either.
  const waiting = h.core.actions.send();
  await settle();
  assert.equal(await h.core.actions.variation(), false);
  assert.equal(h.core.actions.newPiece(), false);
  assert.equal(
    await h.core.actions.openProject("paid"),
    true,
    "the loaded work is simply shown",
  );
  // An answer for another question, or a choice it does not have, is ignored.
  const open = ui(h).dialog;
  assert.ok(open);
  h.core.actions.answerDialog(open.id + 7, "confirm");
  h.core.actions.answerDialog(open.id, "whatever");
  assert.equal(ui(h).dialog, open);
  assert.equal(paidCalls(h), 0);
  // Yes: exactly one request.
  h.core.actions.answerDialog(open.id, "confirm");
  assert.equal(await waiting, true);
  assert.equal(paidCalls(h), 1);
  assert.equal(studio(h).project?.revision, 2);
  // The yes was for that one request: 应用调整 asks again…
  h.core.actions.setDraft("bpm", 90);
  const apply = h.core.actions.applyDraft();
  assert.equal((await answer(h, "cancel")).kind, "paid");
  assert.equal(await apply, false);
  assert.equal(paidCalls(h), 1);
  assert.deepEqual(
    view(h).changedFields,
    ["bpm"],
    "the draft is still there to apply",
  );
  // …and so does 换一版旋律. Ticking the box ends the questions for this service.
  const again = h.core.actions.variation();
  await answer(h, "confirm", true);
  assert.equal(await again, true);
  assert.equal(paidCalls(h), 2);
  assert.equal(await h.core.actions.applyDraft(), true);
  assert.equal(paidCalls(h), 3);
  assert.equal(ui(h).dialog, null);
  // Another service was never agreed to.
  h.core.actions.setProvider("volcengine");
  const other = h.core.actions.variation();
  const second = await answer(h, "cancel");
  assert.match(second.body[0], /火山引擎 AI 音乐/);
  assert.equal(await other, false);
  assert.equal(paidCalls(h), 3);
  // The local engine is free: no notice, no question, chips send at once.
  h.core.actions.setProvider("local");
  assert.equal(view(h).paid, null);
  assert.equal(view(h).variationLabel, "换一版旋律");
  assert.equal(await h.core.actions.pickSuggestion("慢一点"), true);
  assert.equal(paidCalls(h), 3);
});

test("UX-01: the new-piece composer shows the cost and words the preview as a target", async () => {
  const { h } = await desktop();
  assert.equal(view(h).paid, null);
  assert.match(
    planPreview("国风古筝，悠闲", {})?.line ?? "",
    /^将创作：国风古韵/,
  );
  h.core.actions.setProvider("tencent");
  assert.equal(
    view(h).paid?.text,
    "将向腾讯云 TokenHub 发送一次新的生成请求，按该服务计费。",
  );
  assert.match(
    planPreview("国风古筝，悠闲", {}, "tencent")?.line ?? "",
    /^目标：国风古韵.*（云端按描述生成，结果可能不同）$/,
  );
  assert.equal(paidNotice("local", true), null);
  assert.equal(variationLabel("local"), "换一版旋律");
});

test("CORE-06: when the language model fails before a paid request, nothing is paid on the rules' guess", async () => {
  const { h, bridge } = await desktop();
  assert.deepEqual(
    await h.core.actions.saveLlm({
      kind: "anthropic",
      preset: "anthropic",
      apiKey: "sk-ant-test-0000",
      model: "claude-opus-5-5",
    }),
    { ok: true },
  );
  h.core.actions.setProvider("tencent");
  bridge.plan = async () => {
    throw new Error("大模型超过 90 秒没有回应，已停止等待。");
  };
  const typed = "something the rules cannot parse zzz qqq";
  h.core.actions.setComposerText(typed);
  // 1 — cancel: no request, the text is back.
  const first = h.core.actions.send();
  assert.equal((await answer(h, "confirm", true)).kind, "paid");
  await settle();
  const question = ui(h).dialog;
  assert.equal(question?.kind, "fallback");
  assert.match(
    question?.body.join("") ?? "",
    /大模型超过 90 秒没有回应。.*腾讯云 TokenHub.*付费请求/,
  );
  assert.deepEqual(
    question?.choices.map((choice) => choice.id),
    ["cancel", "retry", "rules"],
  );
  assert.equal(studio(h).job?.stage, "asking");
  assert.equal(studio(h).job?.cancellable, false);
  assert.equal(paidCalls(h), 0, "the model failed and nothing was bought");
  await answer(h, "cancel");
  assert.equal(await first, false);
  assert.equal(paidCalls(h), 0);
  assert.equal(studio(h).job, null);
  assert.equal(studio(h).composerText, typed);
  assert.equal(studio(h).project, null);
  assert.ok(toasts(h).includes("已取消，没有发送生成请求。"));
  // 2 — retry: the model is asked again; when it answers, its plan is the one that is paid for.
  const asked = () =>
    bridge.calls.filter((call) => call === "agentPlan").length;
  const before = asked();
  const second = h.core.actions.send();
  await settle();
  assert.equal(ui(h).dialog?.kind, "fallback");
  await answer(h, "retry");
  assert.equal(asked(), before + 2);
  assert.equal(ui(h).dialog?.kind, "fallback", "it failed again: asked again");
  // 3 — continue with the rules: one request, and the thread says who planned it.
  await answer(h, "rules");
  assert.equal(await second, true);
  assert.equal(paidCalls(h), 1);
  const reply = studio(h).thread.at(-1);
  assert.equal(reply?.brain, "rules");
  assert.match(
    studio(h).turnNotes[reply?.id ?? ""]?.fallbackReason ?? "",
    /没有回应/,
  );
  // The free local engine keeps the automatic fallback: no question.
  h.core.actions.setProvider("local");
  assert.equal(await h.core.actions.send("快一点"), true);
  assert.equal(ui(h).dialog, null);
  // A fallback that would generate nothing is just an answer: nothing to ask about.
  h.core.actions.setProvider("tencent");
  assert.equal(await h.core.actions.send("xyzzy"), false);
  assert.equal(ui(h).dialog, null);
  assert.equal(paidCalls(h), 1);
});

test("CORE-04 / UX-01: replies and hints never promise a melody that will not be kept", async () => {
  const { h } = await desktop({ records: [cloudWork("paid")] });
  assert.equal(await h.core.actions.openProject("paid"), true);
  const keeps = /旋律素材保持不变|旋律保持不变|保留旋律/;
  // a message on a cloud work
  h.core.actions.setComposerText("慢一点");
  assert.equal(await paid(h, () => h.core.actions.send(), true), true);
  const once = (text: string | undefined) =>
    (text ?? "").split("重新生成").length - 1;
  let reply = studio(h).thread.at(-1);
  assert.doesNotMatch(reply?.text ?? "", keeps);
  assert.match(reply?.text ?? "", /^好的：速度 .*重新生成/);
  assert.equal(once(reply?.text), 1, `said once: ${reply?.text}`);
  // 应用调整 on a cloud work
  h.core.actions.setDraft("reverb", 0.9);
  assert.equal(await h.core.actions.applyDraft(), true);
  reply = studio(h).thread.at(-1);
  assert.doesNotMatch(reply?.text ?? "", keeps);
  assert.match(
    reply?.text ?? "",
    /^已按你的调整生成新版本：.*云端服务会按新的设置重新生成，旋律会和上一版不同。$/,
  );
  assert.equal(once(reply?.text), 1, `said once: ${reply?.text}`);
  // 换一版旋律 on a cloud work says what it is
  assert.equal(await h.core.actions.variation(), true);
  assert.equal(studio(h).thread.at(-2)?.text, "重新生成一版");
  assert.match(
    studio(h).thread.at(-1)?.text ?? "",
    /腾讯云 TokenHub 按相同的设置重新生成了一首：这是一次新的生成，不保留原旋律/,
  );
  // a cloud work redone by the local engine is recomposed, not "kept"
  h.core.actions.setProvider("local");
  h.core.actions.setDraft("bpm", 77);
  assert.match(view(h).applyHint, /改用本地作曲，按这些参数重新写一首，不计费/);
  assert.equal(await h.core.actions.applyDraft(), true);
  assert.match(
    studio(h).thread.at(-1)?.text ?? "",
    /改用本地作曲后，会按这些设置重新写一首/,
  );

  // engine 1 → engine 2: the tune is rewritten by another composer
  const legacy = localProject(
    "old",
    { title: "旧作品" },
    { engine: 1, mood: "chill", instrument: "guitar", key: "A minor", bpm: 84 },
  );
  const local = harness({ records: [legacy] });
  await local.core.start();
  assert.equal(await local.core.actions.openProject("old"), true);
  assert.match(view(local).applyHint, /新版引擎重新编写旋律/);
  assert.equal(
    await local.core.actions.applyDraft(),
    true,
    "zero changes: redo with the new engine",
  );
  reply = studio(local).thread.at(-1);
  assert.doesNotMatch(reply?.text ?? "", keeps);
  assert.match(reply?.text ?? "", /新版引擎会重新编写旋律/);
  assert.equal(await local.core.actions.openProject("old"), true);
  assert.equal(await local.core.actions.send("慢一点"), true);
  reply = studio(local).thread.at(-1);
  assert.doesNotMatch(reply?.text ?? "", keeps);
  assert.match(reply?.text ?? "", /新的旋律|重新编写旋律/);

  // Whoever wrote the reply — rules or a language model — it is corrected for the engine that runs it.
  const base = localProject("b");
  const said: AgentPlan = {
    config: { ...base.config, bpm: 90 },
    title: "x",
    reply: "慢下来了。旋律和素材都保留，只是更从容。还加了一点混响。",
    reasoning: ["速度 112 → 90 BPM", "旋律素材保持不变"],
    tags: [],
    unchanged: false,
    brain: "llm",
  };
  const honest = honestPlan(said, "tencent", base);
  assert.equal(
    honest.reply,
    "慢下来了。还加了一点混响。云端服务会按新的设置重新生成，旋律会和上一版不同。",
  );
  assert.deepEqual(honest.reasoning, ["速度 112 → 90 BPM"]);
  assert.equal(
    honestPlan(said, "local", base),
    said,
    "a local engine-2 refinement is the producer's to describe",
  );
  assert.equal(
    honestPlan(said, "tencent", null),
    said,
    "a new piece replaces nothing",
  );
  assert.equal(
    honestPlan({ ...said, unchanged: true }, "tencent", base).reply,
    said.reply,
  );
  // A reply that already says so is left alone: the truth is said once, in the producer's own words.
  const already = {
    ...said,
    reply: `好的：速度 112 → 90 BPM。${melodyNote(base.config, said.config, "tencent")}`,
    reasoning: ["速度 112 → 90 BPM"],
  };
  assert.equal(
    honest.reply.endsWith(melodyNote(base.config, said.config, "tencent")),
    true,
    "one sentence for it, whoever says it",
  );
  assert.equal(honestPlan(already, "tencent", base), already);
  assert.equal(
    honestPlan(honest, "tencent", base).reply,
    honest.reply,
    "applying it twice changes nothing",
  );
  // The direct controls of a local engine-2 work say what the composer itself says about the change.
  const wetter = { ...base.config, reverb: 0.9 };
  assert.equal(melodyNote(base.config, wetter), "旋律保持不变。");
  assert.ok(
    planFromDraft(base, draftOf(wetter), "local").plan.reply.endsWith(
      melodyNote(base.config, wetter),
    ),
  );
  const slow = { ...base.config, bpm: 90 };
  const slower = planFromDraft(base, draftOf(slow), "local").plan.reply;
  assert.doesNotMatch(
    slower,
    /保持不变/,
    "a tempo change re-fits the tune: v0.3.0 said 旋律素材保持不变",
  );
  assert.ok(
    melodyNote(base.config, slow).length > 0 &&
      slower.endsWith(melodyNote(base.config, slow)),
  );
  assert.equal(planVariation(base, 5, "local").request, "换一版旋律");
  // the hint says what THIS draft does to the tune, in the composer's own words
  assert.equal(
    applyHint(base, "local"),
    "应用调整会生成一个新版本，之前的版本会保留。",
  );
  assert.equal(
    applyHint(base, "local", draftOf(slow)),
    `应用调整会生成一个新版本，之前的版本会保留。${melodyNote(base.config, slow)}`,
  );
  assert.doesNotMatch(applyHint(base, "local", draftOf(slow)), /种子|保持不变/);
  assert.equal(applyHint(null, "local"), "");
});

test("CORE-04: a language model's promise about the melody is corrected before it reaches the thread", async () => {
  const { h, bridge } = await desktop({ records: [cloudWork("paid")] });
  assert.equal(await h.core.actions.openProject("paid"), true);
  assert.deepEqual(
    await h.core.actions.saveLlm({
      kind: "anthropic",
      preset: "anthropic",
      apiKey: "sk-ant-test-0000",
      model: "claude-opus-5-5",
    }),
    { ok: true },
  );
  // The model does what the rules used to do: it says the tune stays — on a cloud engine, where it cannot.
  bridge.plan = async (input) => ({
    model: "claude-opus-5-5",
    plan: {
      reply: "慢下来了。旋律素材保持不变，只是更从容一些。",
      title: "x",
      style: input.current.style,
      instrument: input.current.instrument,
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
      reasoning: ["速度降到 90", "旋律保持不变"],
      cloudPrompt: "",
    },
  });
  h.core.actions.setComposerText("慢一点");
  assert.equal(await paid(h, () => h.core.actions.send()), true);
  const reply = studio(h).thread.at(-1);
  assert.equal(reply?.brain, "llm");
  assert.doesNotMatch(reply?.text ?? "", /保持不变/);
  assert.equal(
    reply?.text,
    "慢下来了。云端服务会按新的设置重新生成，旋律会和上一版不同。",
  );
  assert.deepEqual(reply?.reasoning, ["速度降到 90"]);
  assert.equal(
    studio(h).project?.chat?.at(-1)?.text,
    reply?.text,
    "and that is what is stored with the work",
  );
});

/* ================================================================== */
/* paid results are never lost                                          */
/* ================================================================== */

test("RB-01: a paid result whose first save fails is saved by the automatic retry", async () => {
  const { h } = await desktop();
  h.core.actions.setProvider("tencent");
  // exactly one write fails; storage is healthy afterwards
  h.storage.failNext = {
    count: 1,
    error: new Error(
      "本地数据库出现内部错误，暂时无法保存到「我的作品」。请稍后重试；如仍失败，请检查磁盘剩余空间。本次作品尚未保存。",
    ),
  };
  assert.equal(
    await paid(h, () => h.core.actions.send("雨夜咖啡馆，慵懒的钢琴"), true),
    true,
  );
  const project = studio(h).project;
  assert.ok(project?.audioBlob);
  assert.equal(studio(h).saveState, "failed");
  assert.equal(studio(h).stored, false);
  assert.equal(view(h).unsaved, true, "the banner is up");
  assert.ok(studio(h).audio, "and the audio plays");
  const said = toasts(h).at(-1) ?? "";
  assert.match(said, /^音乐已生成，但没能保存到「我的作品」：/);
  assert.match(
    said,
    /音频还在当前窗口，请先导出原始音频；稍后会自动再试一次保存。$/,
  );
  assert.doesNotMatch(
    said,
    /重新启动|刷新页面/,
    "never told to restart: the only copy is in this window",
  );
  assert.equal(h.storage.records.size, 0);
  assert.match(h.core.closeRisk() ?? "", /付费生成的音频还没有保存/);
  // nothing happens before the backoff…
  h.clock.advance(SAVE_RETRY_MS - 1);
  await settle();
  assert.equal(h.storage.records.size, 0);
  // …then one automatic retry.
  h.clock.advance(1);
  await settle();
  assert.deepEqual(
    new Uint8Array(
      await (
        h.storage.records.get(project.id)?.audioBlob as Blob
      ).arrayBuffer(),
    ),
    MP3_BYTES,
  );
  assert.equal(studio(h).saveState, "saved");
  assert.equal(view(h).unsaved, false);
  assert.deepEqual(ids(h), [project.id]);
  assert.ok(toasts(h).includes("已保存到「我的作品」"));
  assert.ok(
    !toasts(h).some((text) => text.startsWith("音乐已生成，但没能保存")),
    "the failure notice is withdrawn",
  );
  assert.equal(h.core.closeRisk(), null);
  assert.equal(
    h.core.actions.newPiece(),
    true,
    "saved: leaving needs no question",
  );
});

test("RB-01 / CORE-02: an unsaved paid result can be retried by hand and is not left, replaced or closed without a question", async () => {
  const other = localProject("other");
  const { h } = await desktop({ records: [other] });
  h.core.actions.setProvider("tencent");
  h.storage.failSave = new Error(
    "本地存储空间不足，作品未保存。请导出已有作品并删除不需要的作品后重试。",
  );
  assert.equal(
    await paid(h, () => h.core.actions.send("雨夜咖啡馆"), true),
    true,
  );
  const project = studio(h).project;
  assert.ok(project);
  h.clock.advance(SAVE_RETRY_MS);
  await settle();
  assert.equal(
    view(h).unsaved,
    true,
    "the automatic retry failed too: still here",
  );
  const writes = () =>
    h.log.filter((entry) => entry.startsWith("save:")).length;
  // 新建创作: one more attempt, then the question. "Stay" keeps everything.
  assert.equal(h.core.actions.newPiece(), false);
  let dialog = await answer(h, "stay");
  assert.equal(dialog.kind, "unsaved");
  assert.equal(dialog.title, "付费生成的音频还没有保存");
  assert.match(
    dialog.body.join(""),
    /腾讯云 TokenHub 生成.*只存在于当前窗口.*重新生成需要再次付费/,
  );
  assert.deepEqual(
    dialog.choices.map((choice) => choice.id),
    ["stay", "export", "leave"],
  );
  assert.equal(dialog.cancel, "stay", "Escape never discards paid audio");
  assert.equal(studio(h).project?.id, project.id);
  assert.ok(studio(h).audio);
  // Opening another work asks as well.
  const opening = h.core.actions.openProject("other");
  assert.equal((await answer(h, "stay")).kind, "unsaved");
  assert.equal(await opening, false);
  assert.equal(studio(h).project?.id, project.id);
  // So does a new version, which would take its place — before any payment is discussed.
  const refining = h.core.actions.send("慢一点");
  assert.equal((await answer(h, "stay")).kind, "unsaved");
  assert.equal(await refining, false);
  assert.equal(paidCalls(h), 1);
  // An inspiration card would replace it too.
  h.core.actions.chooseInspiration({ text: "夏日海边" });
  assert.equal((await answer(h, "stay")).kind, "unsaved");
  assert.equal(studio(h).project?.id, project.id);
  assert.equal(studio(h).composerText, "");
  // 重试保存 while the library still refuses: said once, still unsaved.
  assert.equal(await h.core.actions.retrySave(), false);
  assert.match(toasts(h).at(-1) ?? "", /^还是没能保存：本地存储空间不足/);
  assert.equal(await h.core.actions.retrySave(), false);
  assert.equal(
    toasts(h).filter((text) => text.startsWith("还是没能保存")).length,
    1,
  );
  assert.equal(view(h).unsaved, true);
  assert.equal(
    studio(h).saveState,
    "failed",
    "the banner does not blink away during an attempt",
  );
  assert.match(h.core.closeRisk() ?? "", /请先导出原始音频/);
  // The library works again: 重试保存 stores it, bytes included.
  h.storage.failSave = null;
  const before = writes();
  assert.equal(await h.core.actions.retrySave(), true);
  assert.equal(writes(), before + 1);
  assert.ok(h.storage.records.get(project.id)?.audioBlob);
  assert.equal(view(h).unsaved, false);
  assert.equal(studio(h).saveState, "saved");
  assert.deepEqual(ids(h), ["other", project.id].sort());
  assert.equal(h.core.closeRisk(), null);
  assert.equal(
    await h.core.actions.openProject("other"),
    true,
    "no question any more",
  );
});

test("RB-01: leaving an unsaved result — export first, or leave knowingly", async () => {
  const { h } = await desktop({ records: [localProject("other")] });
  h.core.actions.setProvider("tencent");
  h.storage.failSave = new Error("本地存储空间不足，作品未保存。");
  assert.equal(
    await paid(h, () => h.core.actions.send("雨夜咖啡馆"), true),
    true,
  );
  const project = studio(h).project;
  assert.ok(project);
  // "导出原始音频" from the question: the exact bytes, and the work stays loaded.
  assert.equal(h.core.actions.newPiece(), false);
  await answer(h, "export");
  await settle();
  assert.equal(h.files.length, 1);
  assert.equal(h.files[0].format, "mp3");
  assert.deepEqual(new Uint8Array(h.files[0].data), MP3_BYTES);
  assert.equal(studio(h).project?.id, project.id);
  // The user holds the file now: no more questions, no close warning.
  assert.equal(h.core.closeRisk(), null);
  assert.equal(h.core.actions.newPiece(), true);
  assert.equal(studio(h).project, null);
  assert.equal(ui(h).dialog, null);

  // "仍然离开" leaves; the unsaved result is gone because the user said so.
  assert.equal(await h.core.actions.send("另一首雨夜"), true);
  const second = studio(h).project;
  assert.ok(second && view(h).unsaved);
  const opening = h.core.actions.openProject("other");
  await answer(h, "leave");
  assert.equal(await opening, true);
  assert.equal(studio(h).project?.id, "other");
  assert.equal(view(h).unsaved, false);

  // A local work whose save failed shows the same banner and gets the same retries, but it cost
  // nothing: no question (where storage is blocked for good, every single work would ask).
  const web = harness();
  await web.core.start();
  web.storage.failSave = new Error(
    "当前环境不允许使用「我的作品」（隐私模式、受限的内嵌页面或已禁用网站数据）。",
  );
  assert.equal(await web.core.actions.send("夏日海边"), true);
  assert.equal(view(web).unsaved, true);
  assert.equal(web.core.closeRisk(), null, "nothing paid for is at risk");
  assert.equal(await web.core.actions.send("慢一点"), true, "refining goes on");
  assert.equal(ui(web).dialog, null);
  assert.equal(studio(web).project?.revision, 2);
  // The automatic retry puts the loaded work in the library as soon as storage works.
  web.storage.failSave = null;
  web.clock.advance(SAVE_RETRY_MS);
  await settle();
  assert.equal(view(web).unsaved, false);
  assert.equal(
    web.storage.records.get(studio(web).project?.id ?? "")?.revision,
    2,
  );
  web.storage.failSave = new Error("本地存储空间不足，作品未保存。");
  assert.equal(await web.core.actions.send("换成古筝"), true);
  assert.equal(view(web).unsaved, true);
  assert.equal(web.core.actions.newPiece(), true, "and so does leaving");
  assert.equal(ui(web).dialog, null);
});

test("RB-01: a paid result that arrives after a cancel and cannot be stored is kept for the retry or an export", async () => {
  const { h, bridge } = await desktop({ records: [localProject("mine")] });
  await h.core.actions.openProject("mine");
  h.core.actions.setProvider("tencent");
  const service = defer<{ audio: ArrayBuffer; mimeType: string }>();
  bridge.generate = () => service.promise;
  const running = h.core.actions.send("换成更慵懒的感觉，慢一点");
  await answer(h, "confirm", true);
  h.core.actions.cancelJob();
  h.storage.failSave = new Error("本地存储空间不足，作品未保存。");
  service.resolve({ audio: MP3_BYTES.slice().buffer, mimeType: "audio/mpeg" });
  assert.equal(await running, false);
  await settle();
  assert.equal(studio(h).project?.id, "mine", "the current work is untouched");
  const notice = ui(h).toasts.find((toast) =>
    toast.text.startsWith("云端结果在取消后到达"),
  );
  assert.ok(notice?.sticky, "the notice stays");
  assert.equal(notice.action?.label, "导出原始音频");
  assert.match(notice.text, /没能保存到「我的作品」.*音频还在当前窗口/);
  assert.match(h.core.closeRisk() ?? "", /付费生成的音频还没有保存/);
  // Export from the notice: the paid bytes.
  notice.action?.run();
  await settle();
  assert.deepEqual(new Uint8Array(h.files[0].data), MP3_BYTES);
  assert.equal(h.core.closeRisk(), null);

  // Or the automatic retry stores it once the library works again.
  const again = defer<{ audio: ArrayBuffer; mimeType: string }>();
  bridge.generate = () => again.promise;
  const second = h.core.actions.send("再慢一点");
  await settle();
  h.core.actions.cancelJob();
  again.resolve({ audio: MP3_BYTES.slice().buffer, mimeType: "audio/mpeg" });
  assert.equal(await second, false);
  await settle();
  assert.match(h.core.closeRisk() ?? "", /付费生成/);
  h.storage.failSave = null;
  h.clock.advance(SAVE_RETRY_MS);
  await settle();
  const kept = library(h).projects.find((item) => item.provider === "tencent");
  assert.ok(kept?.audioBlob, "the late result reached the library");
  assert.ok(h.storage.records.get(kept.id)?.audioBlob);
  assert.equal(h.core.closeRisk(), null);
  assert.ok(toasts(h).includes("刚才没能保存的云端结果已保存到「我的作品」。"));
  assert.ok(!toasts(h).some((text) => text.startsWith("云端结果在取消后到达")));
});

test("RB-03: closing during a paid request is a risk the page can name", async () => {
  const { h, bridge } = await desktop();
  assert.equal(h.core.closeRisk(), null);
  h.core.actions.setProvider("tencent");
  const service = defer<{ audio: ArrayBuffer; mimeType: string }>();
  bridge.generate = () => service.promise;
  const running = h.core.actions.send("雨夜咖啡馆");
  await answer(h, "confirm");
  assert.equal(studio(h).job?.stage, "cloud");
  assert.match(
    h.core.closeRisk() ?? "",
    /正在生成付费音乐，现在关闭可能仍会计费且得不到结果/,
  );
  assert.deepEqual(
    bridge.risk,
    [true],
    "the desktop shell is told, so its close button asks first",
  );
  service.resolve({ audio: MP3_BYTES.slice().buffer, mimeType: "audio/mpeg" });
  assert.equal(await running, true);
  assert.equal(h.core.closeRisk(), null);
  assert.deepEqual(
    bridge.risk,
    [true, false],
    "and told again once the result is safely stored",
  );
  // An unsaved paid result keeps the flag up until it is stored or exported.
  h.storage.failSave = new Error("本地存储空间不足，作品未保存。");
  assert.equal(await paid(h, () => h.core.actions.send("慢一点")), true);
  assert.deepEqual(bridge.risk, [true, false, true]);
  assert.equal(await h.core.actions.exportWork({ kind: "original" }), true);
  assert.deepEqual(
    bridge.risk,
    [true, false, true, false],
    "exported: nothing to lose",
  );
  h.storage.failSave = null;
  assert.equal(await h.core.actions.retrySave(), true);
  // A local render is free: closing loses nothing that was paid for.
  h.core.actions.setProvider("local");
  h.gate.current = defer<void>();
  const local = h.core.actions.send("慢一点");
  await settle();
  assert.equal(h.core.closeRisk(), null);
  h.gate.current.resolve();
  await local;
  assert.equal(bridge.risk.length, 4, "nothing more was reported");
  // A shell without the method (an older build), or a bridge that throws, changes nothing.
  const old = await desktop();
  delete (old.bridge as Partial<typeof old.bridge>).setUnsavedWork;
  old.h.core.actions.setProvider("tencent");
  assert.equal(
    await paid(old.h, () => old.h.core.actions.send("雨夜咖啡馆")),
    true,
  );
});

test("RB-04: a damaged cloud record offers its audio, not only JSON without it", async () => {
  const h = harness({ kind: "desktop" });
  h.storage.damaged = [
    {
      id: "future",
      title: "付费作品",
      reason: "由更新版本的音序创建，请升级后打开",
      audio: { type: "audio/mpeg", size: MP3_BYTES.length },
      paid: true,
    },
    {
      id: "odd",
      title: "来历不明",
      reason: "数据已损坏，无法读取",
      audio: { type: "", size: 4 },
      paid: true,
    },
    { id: "plain", title: "没有音频", reason: "不是音序的工程数据" },
  ];
  h.storage.raw.set(
    "future",
    '{"id":"future","title":"付费作品","provider":"tencent"}',
  );
  h.storage.raw.set("plain", '{"hello":"world"}');
  h.storage.rawAudio.set(
    "future",
    new Blob([MP3_BYTES], { type: "audio/mpeg" }),
  );
  h.storage.rawAudio.set("odd", new Blob([new Uint8Array([1, 2, 3, 4])]));
  await h.core.start();
  assert.deepEqual(
    library(h).damaged.map((item) => !!item.audio),
    [true, true, false],
  );
  // The JSON export says what it does not contain.
  assert.equal(await h.core.actions.exportDamaged("future"), true);
  assert.equal(
    toasts(h).at(-1),
    "已导出这条记录的原始数据。其中不含音频，请再导出原始音频。",
  );
  // The audio export hands over the exact bytes under a name that opens.
  assert.equal(await h.core.actions.exportDamagedAudio("future"), true);
  assert.equal(h.files[1].name, "付费作品-原始音频");
  assert.equal(h.files[1].format, "mp3");
  assert.deepEqual(new Uint8Array(h.files[1].data), MP3_BYTES);
  assert.equal(toasts(h).at(-1), "已导出这条记录的原始音频");
  // Bytes nobody can name are still handed over, and the toast says how.
  assert.equal(await h.core.actions.exportDamagedAudio("odd"), true);
  assert.equal(h.files[2].name, "来历不明-原始音频-未知格式");
  assert.deepEqual(
    new Uint8Array(h.files[2].data),
    new Uint8Array([1, 2, 3, 4]),
  );
  assert.match(toasts(h).at(-1) ?? "", /格式无法识别.*内容未作改动/);
  assert.equal(await h.core.actions.exportDamagedAudio("plain"), false);
  assert.equal(toasts(h).at(-1), "这条记录里没有音频。");
  assert.equal(await h.core.actions.exportDamagedAudio("nope"), false);
  assert.equal(await h.core.actions.exportDamaged("plain"), true);
  assert.equal(toasts(h).at(-1), "已导出这条记录的原始数据");
});

/* ================================================================== */
/* undo and toasts                                                      */
/* ================================================================== */

test("RB-06 / CORE-07: five quick deletes can all still be undone, whatever is toasted meanwhile", async () => {
  const records = ["a", "b", "c", "d", "e"].map((id, index) =>
    localProject(id, { title: `作品${index + 1}` }),
  );
  const h = harness({ records });
  await h.core.start();
  const undo = () => ui(h).toasts.filter((toast) => toast.action);
  for (const id of ["a", "b", "c", "d", "e"]) {
    assert.equal(h.core.actions.removeProject(id), "removed");
    h.clock.advance(250);
  }
  // one notice, for all five
  assert.equal(undo().length, 1);
  assert.equal(undo()[0].text, "已删除 5 首作品");
  assert.equal(undo()[0].action?.label, "全部撤销");
  assert.equal(undo()[0].sticky, true);
  // any number of other toasts cannot push it out (v0.3.0 kept only the last four toasts)
  for (let index = 0; index < 8; index++)
    h.core.actions.notify(`别的提示 ${index}`, index % 2 ? "error" : "info");
  assert.equal(undo().length, 1);
  assert.equal(
    ui(h).toasts.filter((toast) => !toast.action).length,
    4,
    "plain notices are still capped",
  );
  assert.deepEqual(
    library(h).removing.map((entry) => entry.project.id),
    ["a", "b", "c", "d", "e"],
  );
  // one of them can be put back on its own…
  h.core.actions.undoRemove("c");
  await settle();
  assert.equal(undo()[0].text, "已删除 4 首作品");
  assert.deepEqual(ids(h), ["c"]);
  // …and the first delete, 7 s old by now, is still undoable with the rest.
  h.clock.advance(7000 - 5 * 250);
  undo()[0].action?.run();
  await settle();
  assert.deepEqual(ids(h), ["a", "b", "c", "d", "e"]);
  assert.equal(undo().length, 0);
  assert.ok(toasts(h).includes("已恢复 4 首作品"));
  h.clock.advance(20_000);
  await settle();
  assert.deepEqual(h.storage.deletes, [], "nothing was deleted");
  assert.equal(h.storage.records.size, 5);
  assert.deepEqual(h.session.value.pendingRemovals, []);

  // The notice follows the windows: when the first one closes it speaks for what is left.
  h.core.actions.removeProject("a");
  h.clock.advance(6000);
  h.core.actions.removeProject("b");
  assert.equal(undo()[0].text, "已删除 2 首作品");
  h.clock.advance(2000);
  await settle();
  assert.deepEqual(h.storage.deletes, ["a"]);
  assert.equal(undo()[0].text, "已删除《作品2》");
  assert.equal(undo()[0].action?.label, "撤销");
  h.clock.advance(6000);
  await settle();
  assert.deepEqual(h.storage.deletes, ["a", "b"]);
  assert.equal(undo().length, 0, "nothing left to undo: the notice goes");
});

test("RB-06 / RB-05: toasts — protected, keyed and identical ones (reducer)", () => {
  let state: AppState = initialState({ desktop: false, version: "t" });
  const push = (toast: Toast) => {
    state = reducer(state, { type: "toast/push", toast });
  };
  const shown = () => state.ui.toasts.map((toast) => toast.id);
  push({
    id: 1,
    kind: "info",
    text: "已删除《A》",
    action: { label: "撤销", run() {} },
  });
  push({
    id: 2,
    kind: "error",
    text: "混音没有保存",
    key: "mix",
    sticky: true,
  });
  for (let id = 3; id <= 9; id++)
    push({ id, kind: "info", text: `提示 ${id}` });
  assert.deepEqual(shown(), [1, 2, 6, 7, 8, 9], "only plain toasts make room");
  // the same plain text again replaces, it does not stack
  push({ id: 10, kind: "info", text: "提示 9" });
  assert.deepEqual(shown(), [1, 2, 6, 7, 8, 10]);
  push({ id: 11, kind: "error", text: "提示 9" });
  assert.deepEqual(
    shown(),
    [1, 2, 7, 8, 10, 11],
    "a different kind is a different notice",
  );
  // a keyed toast takes the place of the one with its key
  push({
    id: 12,
    kind: "error",
    text: "混音还是没有保存",
    key: "mix",
    sticky: true,
  });
  assert.deepEqual(shown(), [1, 12, 7, 8, 10, 11]);
  state = reducer(state, { type: "toast/withdraw", key: "mix" });
  assert.deepEqual(shown(), [1, 7, 8, 10, 11]);
  const same = state;
  state = reducer(state, { type: "toast/withdraw", key: "mix" });
  assert.equal(state, same);
  // a toast with an action is not "identical" to a plain one with the same words
  push({ id: 13, kind: "info", text: "已删除《A》" });
  assert.ok(shown().includes(1) && shown().includes(13));
});

test("RB-05: while the library refuses a work's faders, one sticky notice — not one per gesture", async () => {
  const { h, first } = await withWork();
  const errors = () =>
    ui(h).toasts.filter((toast) => toast.text.startsWith("混音没有保存"));
  h.storage.failSave = new Error(
    "当前环境不允许使用「我的作品」（隐私模式、受限的内嵌页面或已禁用网站数据）。请允许此页面保存数据，或使用桌面版。本次作品尚未保存。",
  );
  for (let step = 0; step < 6; step++) {
    h.core.actions.setVolume("melody", 0.7 - step * 0.05);
    h.core.actions.commitMix();
    await settle();
    h.clock.advance(700);
  }
  assert.equal(
    errors().length,
    1,
    "six gestures used to stack four identical 8-second toasts",
  );
  assert.equal(errors()[0].sticky, true);
  assert.equal(
    studio(h).saveState,
    "failed",
    "the indicator carries the state",
  );
  assert.equal(
    view(h).unsaved,
    false,
    "the work itself is in the library: no unsaved banner",
  );
  // closed by the user: the streak does not raise it again
  h.core.actions.dismissToast(errors()[0].id);
  h.core.actions.setVolume("melody", 0.2);
  h.core.actions.commitMix();
  await settle();
  assert.equal(errors().length, 0);
  // the library works again: the next gesture saves everything that was owed
  h.storage.failSave = null;
  h.core.actions.setVolume("drums", 0.3);
  h.core.actions.commitMix();
  await settle();
  assert.equal(studio(h).saveState, "saved");
  assert.equal(
    h.storage.records.get(first.id)?.config.volumes.melody,
    0.2,
    "the fader that failed to save went with it",
  );
  assert.equal(h.storage.records.get(first.id)?.config.volumes.drums, 0.3);
  // a new streak is a new notice; a hand retry from the indicator clears it
  h.storage.failSave = new Error(
    "「我的作品」的连接已断开，无法保存。请重试。",
  );
  h.core.actions.setVolume("bass", 0.1);
  h.core.actions.commitMix();
  await settle();
  assert.equal(errors().length, 1);
  assert.equal(await h.core.actions.retrySave(), false);
  assert.equal(errors().length, 1);
  h.storage.failSave = null;
  assert.equal(await h.core.actions.retrySave(), true);
  assert.equal(errors().length, 0, "withdrawn once the save went through");
  assert.equal(studio(h).saveState, "saved");
  assert.equal(h.storage.records.get(first.id)?.config.volumes.bass, 0.1);
});

/* ================================================================== */
/* several tabs                                                         */
/* ================================================================== */

/** Two tabs of one origin, both started, with these works in the library. */
async function twoTabs(records: Project[]) {
  const origin = sharedOrigin();
  for (const record of records) origin.storage.records.set(record.id, record);
  const a = harness({ origin });
  const b = harness({ origin, clock: a.clock });
  await a.core.start();
  await b.core.start();
  return { origin, a, b, storage: origin.storage };
}

test("RB-02: undo is only reported once the record is really back", async () => {
  const origin = sharedOrigin();
  for (const id of ["x1", "x2", "x3"])
    origin.storage.records.set(id, localProject(id, { title: `work-${id}` }));
  const a = harness({ origin });
  await a.core.start();
  assert.equal(a.core.actions.removeProject("x1"), "removed");
  a.clock.advance(1000);
  // A second tab starts inside tab A's undo window: the deletion is A's, and A may still undo it.
  const b = harness({ origin, clock: a.clock });
  await b.core.start();
  assert.deepEqual(
    origin.storage.deletes,
    [],
    "v0.3.0: the new tab deleted x1 at once",
  );
  assert.ok(origin.storage.records.has("x1"));
  assert.deepEqual(
    a.session.value.pendingRemovals.map((note) => note.id),
    ["x1"],
    "and A's note is still in the shared session",
  );
  // Worst case anyway: the record disappears under tab A (a tab of the old build, a cleared store…).
  origin.storage.records.delete("x1");
  a.core.actions.undoRemove("x1");
  assert.ok(!toasts(a).includes("已恢复"), "not said before it is true");
  await settle();
  assert.ok(origin.storage.records.has("x1"), "undo wrote the work back");
  assert.ok(toasts(a).includes("已恢复"));
  assert.deepEqual(ids(a), ["x1", "x2", "x3"]);
  a.clock.advance(10_000);
  await settle();
  assert.ok(origin.storage.records.has("x1"), "and it stays");
  assert.deepEqual(a.session.value.pendingRemovals, []);
  // When the record cannot be written back, undo says so instead of "已恢复".
  a.core.actions.removeProject("x2");
  origin.storage.records.delete("x2");
  origin.storage.failSave = new Error(
    "「我的作品」的连接已断开，无法保存。请重试。",
  );
  const said = toasts(a).length;
  a.core.actions.undoRemove("x2");
  await settle();
  assert.match(
    toasts(a).at(-1) ?? "",
    /^《work-x2》没能放回「我的作品」：「我的作品」的连接已断开/,
  );
  assert.ok(!toasts(a).slice(said).includes("已恢复"));
  origin.storage.failSave = null;
  // Undo never overwrites what is there: a record another tab changed meanwhile is kept as it is.
  a.core.actions.removeProject("x3");
  origin.storage.records.set("x3", {
    ...localProject("x3"),
    title: "renamed-elsewhere",
  });
  a.core.actions.undoRemove("x3");
  await settle();
  assert.equal(origin.storage.records.get("x3")?.title, "renamed-elsewhere");
});

test("RB-02: a tab that closed inside the undo window leaves the deletion to the next start of any tab", async () => {
  const origin = sharedOrigin();
  for (const id of ["x1", "x2"])
    origin.storage.records.set(id, localProject(id));
  const a = harness({ origin });
  await a.core.start();
  a.core.actions.removeProject("x1");
  // The page goes away; the database write it starts never happens.
  origin.storage.stall = true;
  a.core.close();
  assert.deepEqual(
    a.session.value.pendingRemovals,
    [{ id: "x1", expiresAt: 0 }],
    "marked as due, synchronously",
  );
  await settle();
  assert.ok(origin.storage.records.has("x1"));
  origin.storage.stall = false;
  const b = harness({ origin, clock: a.clock });
  await b.core.start();
  assert.deepEqual(origin.storage.deletes, ["x1"]);
  assert.deepEqual(ids(b), ["x2"]);
  assert.deepEqual(b.session.value.pendingRemovals, []);
});

test("RB-07: a stale tab's favourite does not revert a rename, and both tabs end up with both changes", async () => {
  const { a, b, storage } = await twoTabs([
    localProject("x2", { title: "work-x2" }),
  ]);
  assert.equal(
    library(b).projects[0].title,
    "work-x2",
    "tab B has listed the library",
  );
  assert.equal(await a.core.actions.rename("x2", "renamed-in-A"), true);
  assert.equal(storage.records.get("x2")?.title, "renamed-in-A");
  // Only the changed field was written.
  assert.deepEqual(storage.patches.at(-1), {
    id: "x2",
    patch: { title: "renamed-in-A" },
  });
  // Tab B hears about it without doing anything…
  await settle();
  assert.equal(library(b).projects[0].title, "renamed-in-A");
  // …but even a tab that heard nothing cannot undo it: its write carries only its own field.
  const deaf = harness({
    origin: {
      ...b.origin,
      connect: () => ({ post() {}, subscribe: () => () => {} }),
    },
    clock: a.clock,
  });
  storage.records.set("x2", {
    ...(storage.records.get("x2") as Project),
    title: "work-x2",
  });
  await deaf.core.start();
  storage.records.set("x2", {
    ...(storage.records.get("x2") as Project),
    title: "renamed-in-A",
  });
  assert.equal(library(deaf).projects[0].title, "work-x2", "stale on purpose");
  assert.equal(await deaf.core.actions.toggleFavourite("x2"), true);
  assert.deepEqual(
    {
      title: storage.records.get("x2")?.title,
      favorite: storage.records.get("x2")?.favorite,
    },
    { title: "renamed-in-A", favorite: true },
    "v0.3.0 wrote its whole stale record: the rename was gone",
  );
  assert.equal(
    library(deaf).projects[0].title,
    "renamed-in-A",
    "and the answer brought the other tab's change along",
  );
  assert.equal(library(deaf).projects[0].favorite, true);
  // The same holds for the mixer: one fader from each tab, both kept.
  assert.equal(await a.core.actions.openProject("x2"), true);
  assert.equal(await b.core.actions.openProject("x2"), true);
  a.core.actions.setVolume("melody", 0.2);
  a.core.actions.commitMix();
  await settle();
  b.core.actions.setVolume("drums", 0.9);
  b.core.actions.commitMix();
  await settle();
  const volumes = storage.records.get("x2")?.config.volumes;
  assert.equal(volumes?.melody, 0.2);
  assert.equal(volumes?.drums, 0.9);
  assert.deepEqual(
    storage.patches.at(-1)?.patch.volumes,
    { drums: 0.9 },
    "only the fader that moved is sent",
  );
  assert.equal(
    studio(a).project?.config.volumes.drums,
    0.9,
    "each tab hears the other's fader",
  );
  assert.equal(studio(b).project?.config.volumes.melody, 0.2);
  assert.equal(b.player.mixes.at(-1)?.gains.melody, 0.2, "and plays it");
  assert.equal(studio(a).project?.favorite, true);
});

test("RB-07: a work deleted in one tab stays deleted — an edit in another tab does not bring it back", async () => {
  const { a, b, storage } = await twoTabs([
    localProject("x2"),
    localProject("x3", { title: "work-x3" }),
  ]);
  assert.equal(await b.core.actions.openProject("x3"), true);
  assert.equal(a.core.actions.removeProject("x3"), "removed");
  await settle();
  assert.equal(
    studio(b).project?.id,
    "x3",
    "nothing happens to tab B while tab A can still undo",
  );
  a.clock.advance(8000);
  await settle();
  assert.equal(storage.records.has("x3"), false);
  // Tab B was told: the work left its list and its studio, like a delete made there.
  assert.deepEqual(ids(b), ["x2"]);
  assert.equal(studio(b).project, null);
  assert.equal(b.player.unloads, 1);
  assert.ok(toasts(b).includes("《work-x3》已在另一个窗口中删除。"));
  assert.equal(b.session.value.lastProjectId, null);

  // A tab that was not told still cannot resurrect it: a fader, a rename or a favourite finds no record.
  const { a: c, storage: second } = await twoTabs([
    localProject("y1", { title: "work-y1" }),
    localProject("y2"),
  ]);
  assert.equal(await c.core.actions.openProject("y1"), true);
  second.records.delete("y1");
  c.core.actions.setVolume("melody", 0.1);
  c.core.actions.commitMix();
  await settle();
  assert.equal(
    second.records.has("y1"),
    false,
    "v0.3.0 wrote the whole record back",
  );
  assert.equal(studio(c).project, null);
  assert.deepEqual(ids(c), ["y2"]);
  assert.ok(toasts(c).includes("《work-y1》已在另一个窗口中删除。"));
  assert.ok(!toasts(c).some((text) => text.startsWith("混音没有保存")));
  second.records.delete("y2");
  assert.equal(await c.core.actions.rename("y2", "新名字"), false);
  assert.equal(second.records.has("y2"), false);
  assert.deepEqual(ids(c), []);
});

test("RB-07: what storage answers never replaces a newer edit that is still on its way there", async () => {
  const { h, first } = await withWork();
  // storage is slow: the fader's write is still waiting when the title is changed
  h.storage.hold = defer<void>();
  h.core.actions.setVolume("melody", 0.3);
  h.core.actions.commitMix();
  const renaming = h.core.actions.rename(first.id, "新的名字");
  h.core.actions.setVolume("drums", 0.9);
  await settle();
  assert.equal(
    h.storage.records.get(first.id)?.title,
    first.title,
    "nothing is written yet",
  );
  assert.equal(studio(h).project?.title, "新的名字");
  h.storage.hold.resolve();
  h.storage.hold = null;
  assert.equal(await renaming, true);
  h.core.actions.commitMix();
  await settle();
  // The fader's answer carried the title as it was stored then — the old one. It must not win.
  assert.equal(studio(h).project?.title, "新的名字");
  assert.equal(library(h).projects[0].title, "新的名字");
  assert.equal(
    studio(h).project?.config.volumes.drums,
    0.9,
    "nor may the rename's answer move a fader back",
  );
  // the same for the favourite
  h.storage.hold = defer<void>();
  h.core.actions.setVolume("bass", 0.2);
  h.core.actions.commitMix();
  const liking = h.core.actions.toggleFavourite(first.id);
  await settle();
  assert.equal(studio(h).project?.favorite, true);
  h.storage.hold.resolve();
  h.storage.hold = null;
  assert.equal(await liking, true);
  await settle();
  assert.equal(studio(h).project?.favorite, true);
  const stored = h.storage.records.get(first.id);
  assert.deepEqual(
    {
      title: stored?.title,
      favorite: stored?.favorite,
      ...stored?.config.volumes,
    },
    {
      title: "新的名字",
      favorite: true,
      ...first.config.volumes,
      melody: 0.3,
      drums: 0.9,
      bass: 0.2,
    },
  );
  assert.equal(studio(h).saveState, "saved");
});

test("RB-07: tabs share one session without dropping each other's notes", async () => {
  const { a, b, storage } = await twoTabs([
    localProject("x1"),
    localProject("x2"),
  ]);
  a.core.actions.removeProject("x1");
  // Tab B writes the session for its own reasons (typing, a hidden tab): A's note survives.
  b.core.actions.setComposerText("写点什么");
  b.clock.advance(500);
  b.core.flush();
  assert.deepEqual(
    a.session.value.pendingRemovals.map((note) => note.id),
    ["x1"],
  );
  b.core.actions.removeProject("x2");
  assert.deepEqual(
    a.session.value.pendingRemovals.map((note) => note.id).sort(),
    ["x1", "x2"],
  );
  // A undoes its own; B's stays noted until B's window closes.
  a.core.actions.undoRemove("x1");
  await settle();
  assert.deepEqual(
    a.session.value.pendingRemovals.map((note) => note.id),
    ["x2"],
  );
  a.clock.advance(8000);
  await settle();
  assert.deepEqual(storage.deletes, ["x2"]);
  assert.deepEqual(a.session.value.pendingRemovals, []);
  assert.deepEqual(ids(a), ["x1"], "tab A heard about B's delete");
});

test("RB-07: a work made in another tab shows up; channel and storage-event fallback carry the same messages", async () => {
  const { a, b } = await twoTabs([]);
  assert.equal(await a.core.actions.send("夏日海边"), true);
  await settle();
  assert.deepEqual(ids(b), ids(a));
  assert.equal(studio(b).project, null, "listed, not opened");

  // BroadcastChannel when there is one…
  const heard: SyncMessage[] = [];
  const listeners = new Set<(event: { data: unknown }) => void>();
  const sent: unknown[] = [];
  const channel = createTabSync({
    channel: (name) => {
      assert.equal(name, "muse-bgm");
      return {
        postMessage: (message) => void sent.push(message),
        addEventListener: (_type, listener) => void listeners.add(listener),
        removeEventListener: (_type, listener) =>
          void listeners.delete(listener),
      };
    },
  });
  const stop = channel.subscribe((message) => heard.push(message));
  channel.post({ type: "saved", id: "p1" });
  assert.deepEqual(sent, [{ type: "saved", id: "p1" }]);
  for (const listener of listeners)
    listener({ data: { type: "deleted", id: "p2" } });
  for (const listener of listeners)
    listener({ data: { type: "format-c", id: "p2" } });
  for (const listener of listeners) listener({ data: "junk" });
  assert.deepEqual(heard, [{ type: "deleted", id: "p2" }]);
  stop();
  assert.equal(listeners.size, 0);
  // …otherwise a localStorage key and the storage event of the other documents.
  const written: [string, string][] = [];
  let onStorage:
    ((event: { key: string | null; newValue: string | null }) => void) | null =
    null;
  const fallback = createTabSync({
    channel: () => {
      throw new Error("BroadcastChannel is not available");
    },
    storage: () => ({
      setItem: (key, value) => void written.push([key, value]),
    }),
    onStorage: (listener) => {
      onStorage = listener;
      return () => {
        onStorage = null;
      };
    },
  });
  const viaStorage: SyncMessage[] = [];
  const stopFallback = fallback.subscribe((message) =>
    viaStorage.push(message),
  );
  fallback.post({ type: "saved", id: "p1" });
  fallback.post({ type: "saved", id: "p1" });
  assert.equal(written.length, 2);
  assert.equal(written[0][0], SYNC_KEY);
  assert.notEqual(
    written[0][1],
    written[1][1],
    "two equal messages are two changes of the key",
  );
  const deliver = onStorage as
    ((event: { key: string | null; newValue: string | null }) => void) | null;
  deliver?.({ key: SYNC_KEY, newValue: written[0][1] });
  deliver?.({ key: "muse-bgm:session", newValue: written[0][1] });
  deliver?.({ key: SYNC_KEY, newValue: null });
  deliver?.({ key: SYNC_KEY, newValue: "{not json" });
  assert.deepEqual(viaStorage, [{ type: "saved", id: "p1" }]);
  stopFallback();
  assert.equal(onStorage, null);
  assert.equal(parseSyncMessage({ type: "saved", id: "" }), null);
  assert.equal(parseSyncMessage({ type: "saved", id: "x".repeat(121) }), null);
  assert.equal(parseSyncMessage("x".repeat(2000)), null);
  // No channel and no storage: the tab simply works on its own.
  const alone = createTabSync({});
  alone.post({ type: "saved", id: "p" });
  alone.subscribe(() => assert.fail("nobody to hear"))();
});

/* ================================================================== */
/* state                                                                */
/* ================================================================== */

test("CORE-03: what is changed while a job runs belongs to its result — title, faders, inspector edits", async () => {
  const { h, first } = await withWork();
  h.gate.current = defer<void>();
  const running = h.core.actions.send("慢一点，不要鼓");
  await settle();
  assert.equal(studio(h).job?.stage, "rendering");
  // the title field, the faders and the inspector all stay enabled during a job
  assert.equal(await h.core.actions.rename(first.id, "我改的名字"), true);
  h.core.actions.setVolume("melody", 0.2);
  h.core.actions.setVolume("drums", 0.9);
  h.core.actions.commitMix();
  h.core.actions.setDraft("instrument", "guzheng");
  h.core.actions.setDraft("reverb", 0.9);
  h.gate.current.resolve();
  assert.equal(await running, true);
  h.gate.current = null;
  const second = studio(h).project;
  assert.ok(second && second.id !== first.id);
  assert.equal(
    second.title,
    "我改的名字",
    "v0.3.0: the new version took the old title",
  );
  assert.equal(
    second.config.volumes.melody,
    0.2,
    "the fader moved during the job",
  );
  assert.equal(
    second.config.volumes.drums,
    0,
    "but the plan's own change wins on its track: 不要鼓",
  );
  assert.equal(
    h.player.loads.at(-1)?.mix.gains.melody,
    0.2,
    "and that is what plays",
  );
  assert.deepEqual(h.storage.records.get(second.id), second);
  // the earlier version keeps what was done to it as well
  assert.equal(h.storage.records.get(first.id)?.title, "我改的名字");
  assert.equal(h.storage.records.get(first.id)?.config.volumes.melody, 0.2);
  assert.equal(h.storage.records.get(first.id)?.config.volumes.drums, 0.9);
  // the inspector edits are still pending on the new version, not wiped
  assert.equal(studio(h).draft.instrument, "guzheng");
  assert.equal(studio(h).draft.reverb, 0.9);
  assert.equal(
    studio(h).draft.bpm,
    second.config.bpm,
    "everything else follows the new version",
  );
  assert.deepEqual(view(h).changedFields, ["instrument", "reverb"]);
  assert.deepEqual(studio(h).touched, ["instrument", "reverb"]);
  assert.ok(
    toasts(h).some((text) => /还有 2 项没有应用的修改，已保留/.test(text)),
  );

  // 应用调整 uses up the draft it was started with; only edits made after that stay pending.
  h.gate.current = defer<void>();
  const applying = h.core.actions.applyDraft();
  await settle();
  h.core.actions.setDraft("bpm", 150);
  h.gate.current.resolve();
  assert.equal(await applying, true);
  h.gate.current = null;
  const third = studio(h).project;
  assert.equal(third?.config.instrument, "guzheng");
  assert.equal(third?.config.reverb, 0.9);
  assert.notEqual(third?.config.bpm, 150);
  assert.deepEqual(view(h).changedFields, ["bpm"]);

  // Edits pending before 换一版旋律 or a message are not thrown away either (they were not used).
  assert.equal(await h.core.actions.variation(), true);
  assert.deepEqual(view(h).changedFields, ["bpm"]);
  assert.equal(
    studio(h).project?.config.bpm,
    third?.config.bpm,
    "the unapplied draft is not used",
  );
  // Opening a work is a fresh start for the inspector.
  assert.equal(await h.core.actions.openProject(first.id), true);
  assert.deepEqual(view(h).changedFields, []);

  // the pure rules
  const config = first.config;
  assert.deepEqual(
    carriedDraft({ ...draftOf(config), bpm: 150 }, draftOf(config), {
      ...config,
      bpm: 150,
    }),
    {},
    "already what the new version is",
  );
  assert.deepEqual(
    carriedDraft({ ...draftOf(config), bpm: 150 }, draftOf(config), config),
    { bpm: 150 },
  );
  assert.deepEqual(
    rebaseVolumes(
      { melody: 0.8, chords: 0.6, bass: 0.6, drums: 0 },
      { melody: 0.8, chords: 0.6, bass: 0.6, drums: 0.5 },
      { melody: 0.2, chords: 0.6, bass: 0.6, drums: 0.9 },
    ),
    { melody: 0.2, chords: 0.6, bass: 0.6, drums: 0 },
  );
});

test("CORE-03: a cloud result takes the title the work has when it arrives", async () => {
  const { h, bridge } = await desktop({
    records: [cloudWork("paid", { title: "原来的名字" })],
  });
  assert.equal(await h.core.actions.openProject("paid"), true);
  const service = defer<{ audio: ArrayBuffer; mimeType: string }>();
  bridge.generate = () => service.promise;
  const running = h.core.actions.send("慢一点");
  await answer(h, "confirm");
  assert.equal(await h.core.actions.rename("paid", "等的时候改的名字"), true);
  service.resolve({ audio: MP3_BYTES.slice().buffer, mimeType: "audio/mpeg" });
  assert.equal(await running, true);
  assert.equal(studio(h).project?.title, "等的时候改的名字");
  assert.equal(
    h.storage.records.get(studio(h).project?.id ?? "")?.title,
    "等的时候改的名字",
  );
});

test("CORE-05: a chip never erases what is typed, and a cancel gives back exactly the user's own text", async () => {
  const { h } = await withWork();
  const draft = "  把副歌的旋律写得更有记忆点，\n但不要太吵  ";
  h.core.actions.setComposerText(draft);
  h.clock.advance(500);
  assert.equal(
    h.session.value.composerText,
    draft,
    "remembered for the next launch",
  );
  h.gate.current = defer<void>();
  // a chip while a draft is in the composer
  const chip = h.core.actions.pickSuggestion("慢一点");
  await settle();
  assert.equal(studio(h).pendingTurn?.text, "慢一点");
  assert.equal(
    studio(h).composerText,
    draft,
    "v0.3.0 cleared the composer for every message",
  );
  assert.equal(
    h.session.value.composerText,
    draft,
    "and the remembered text with it",
  );
  h.core.actions.cancelJob();
  assert.equal(
    studio(h).composerText,
    draft,
    "v0.3.0 put the chip's text here instead",
  );
  h.gate.current.resolve();
  assert.equal(await chip, false);
  // and when the chip's job fails
  h.renderError.current = new Error("合成器内部错误，请重试。");
  assert.equal(await h.core.actions.pickSuggestion("更有活力"), false);
  assert.equal(studio(h).composerText, draft);
  h.renderError.current = null;
  // and when it succeeds
  h.gate.current = null;
  assert.equal(await h.core.actions.pickSuggestion("慢一点"), true);
  assert.equal(studio(h).composerText, draft);
  // The composer's own text does leave when it is sent — and comes back untouched on cancel.
  h.gate.current = defer<void>();
  const own = h.core.actions.send();
  await settle();
  assert.equal(studio(h).composerText, "");
  h.core.actions.cancelJob();
  assert.equal(
    studio(h).composerText,
    draft,
    "exactly as typed, spaces and line break included",
  );
  h.gate.current.resolve();
  await own;
  // …unless the user has typed something new meanwhile.
  h.gate.current = defer<void>();
  const next = h.core.actions.send();
  await settle();
  h.core.actions.setComposerText("新的想法");
  h.core.actions.cancelJob();
  assert.equal(studio(h).composerText, "新的想法");
  h.gate.current.resolve();
  await next;
  // the pure rule for the cloud path, where a chip joins the text instead of being sent
  assert.equal(appendPhrase("", "慢一点"), "慢一点");
  assert.equal(appendPhrase("再安静一些", "慢一点"), "再安静一些，慢一点");
  assert.equal(appendPhrase("再安静一些，", "慢一点"), "再安静一些，慢一点");
  assert.equal(
    appendPhrase("慢一点，不要鼓", "慢一点"),
    "慢一点，不要鼓",
    "not twice",
  );
  assert.equal(appendPhrase("abc", "  "), "abc");
});

test("CORE-09: a fader move the library has not confirmed survives the page going away", async () => {
  const origin = sharedOrigin();
  const h = harness({ origin });
  await h.core.start();
  assert.equal(await h.core.actions.send("夏日海边的轻快钢琴"), true);
  const first = studio(h).project;
  assert.ok(first);
  // saved normally: nothing is owed
  h.core.actions.setVolume("drums", 0.55);
  h.core.actions.commitMix();
  await settle();
  h.core.flush();
  assert.deepEqual(h.session.value.pendingMixes, []);
  // The key is still held down (no keyup, inside the 400 ms): 0.54 on screen, 0.55 in the library.
  h.core.actions.setVolume("drums", 0.54);
  assert.equal(
    origin.storage.records.get(first.id)?.config.volumes.drums,
    0.55,
  );
  // The page goes away. Database writes started during teardown never complete.
  origin.storage.stall = true;
  h.core.close();
  assert.deepEqual(
    h.session.value.pendingMixes,
    [{ id: first.id, volumes: { drums: 0.54 }, at: h.clock.time }],
    "noted synchronously, only the fader that moved",
  );
  await settle();
  assert.equal(
    origin.storage.records.get(first.id)?.config.volumes.drums,
    0.55,
    "the write did not happen",
  );

  // Next start: the note is applied before the library is read, then forgotten.
  origin.storage.stall = false;
  const working = harness({ origin, clock: h.clock });
  await working.core.start();
  assert.equal(
    origin.storage.records.get(first.id)?.config.volumes.drums,
    0.54,
    "v0.3.0 came back with 0.55",
  );
  assert.equal(studio(working).project?.id, first.id);
  assert.equal(studio(working).project?.config.volumes.drums, 0.54);
  assert.equal(working.player.loads[0].mix.gains.drums, 0.54);
  assert.deepEqual(working.session.value.pendingMixes, []);

  // When the write does complete, the note is taken back.
  working.core.actions.setVolume("bass", 0.33);
  working.core.flush();
  assert.equal(working.session.value.pendingMixes.length, 1);
  await settle();
  assert.equal(origin.storage.records.get(first.id)?.config.volumes.bass, 0.33);
  assert.deepEqual(
    working.session.value.pendingMixes,
    [],
    "confirmed: nothing owed",
  );

  // A note older than the record's last change is dropped, not applied over something newer.
  const stale = sharedOrigin({
    pendingMixes: [
      {
        id: "p",
        volumes: { melody: 0.1 },
        at: Date.parse("2026-10-01T07:00:00.000Z"),
      },
      {
        id: "gone",
        volumes: { melody: 0.1 },
        at: Date.parse("2026-10-01T07:00:00.000Z"),
      },
    ],
  });
  stale.storage.records.set("p", localProject("p"));
  const later = harness({ origin: stale });
  await later.core.start();
  assert.equal(
    stale.storage.records.get("p")?.config.volumes.melody,
    localProject("p").config.volumes.melody,
  );
  assert.equal(
    stale.storage.records.has("gone"),
    false,
    "and a note for a deleted work creates nothing",
  );
  assert.deepEqual(later.session.value.pendingMixes, []);
});

test("UX-10: versions of one piece share the thread; an earlier version shows what came after and the way back", async () => {
  const { h, first } = await withWork();
  assert.equal(await h.core.actions.send("慢一点"), true);
  const second = studio(h).project;
  assert.equal(await h.core.actions.send("换成古筝"), true);
  const third = studio(h).project;
  assert.ok(second && third);
  assert.equal(studio(h).thread.length, 6);
  // open v1 from its tag in the thread
  assert.equal(await h.core.actions.openProject(first.id), true);
  assert.equal(studio(h).project?.id, first.id);
  assert.equal(
    studio(h).thread.length,
    6,
    "v0.3.0 dropped the later conversation: only 2 turns were left",
  );
  const projects = library(h).projects;
  const line = lineage(first, projects);
  assert.deepEqual(
    line.versions.map((item) => item.revision),
    [3, 2, 1],
  );
  assert.equal(line.latest.id, third.id, "the way back to the newest version");
  assert.deepEqual(line.thread, third.chat);
  // every version tag in the thread resolves to its work, so A/B listening is one click each way
  const tags = studio(h).thread.filter((entry) => entry.revision !== undefined);
  assert.deepEqual(
    tags.map((entry) => versionOfTurn(entry, line.versions, first)?.id),
    [first.id, second.id, third.id],
  );
  assert.equal(await h.core.actions.openProject(third.id), true);
  assert.equal(lineage(third, projects).latest.id, third.id);
  // A change made from the earlier version is a new version of the same piece: it gets the next free
  // number (not a second "v2"), continues the shared thread, and says where it started from.
  assert.equal(await h.core.actions.openProject(first.id), true);
  assert.equal(await h.core.actions.send("不要鼓"), true);
  const fourth = studio(h).project;
  assert.equal(fourth?.revision, 4);
  assert.equal(fourth?.parentId, first.id);
  assert.equal(
    fourth?.config.bpm,
    first.config.bpm,
    "made from v1, not from the slower v2",
  );
  assert.equal(studio(h).thread.length, 8);
  assert.equal(studio(h).thread.at(-1)?.revision, 4);
  assert.equal(studio(h).thread.at(-1)?.reasoning?.[0], "在 v1 的基础上修改");
  assert.deepEqual(fourth?.chat, studio(h).thread);
  assert.equal(h.plans.at(-1)?.mode, "refine");
  const all = library(h).projects;
  assert.deepEqual(
    lineage(second, all).versions.map((item) => item.revision),
    [4, 3, 2, 1],
  );
  assert.equal(lineage(second, all).latest.id, fourth?.id);
  assert.equal(
    lineage(second, all).thread.length,
    8,
    "v2 shows the whole conversation of the piece",
  );
  assert.equal(nextRevisionIn(second, all), 5);
  assert.equal(nextRevisionIn(null, all), 1);
  // a different piece is not part of it
  assert.equal(h.core.actions.newPiece(), true);
  assert.equal(await h.core.actions.send("国风古筝"), true);
  const other = studio(h).project;
  assert.equal(other?.revision, 1);
  assert.equal(studio(h).thread.length, 2);
  assert.deepEqual(
    lineageOf(other as Project, library(h).projects).map((item) => item.id),
    [other?.id],
  );
});

test("UX-10: lineage — pure cases (a deleted middle version, an imported copy, a legacy fork, no chat)", () => {
  const u1 = turn("u1", "user");
  const a1 = turn("a1", "agent", 1);
  const u2 = turn("u2", "user");
  const a2 = turn("a2", "agent", 2);
  const u3 = turn("u3", "user");
  const a3 = turn("a3", "agent", 3);
  const v1 = localProject("v1", {
    chat: [u1, a1],
    createdAt: "2026-10-01T08:00:00.000Z",
  });
  const v2 = localProject("v2", {
    revision: 2,
    parentId: "v1",
    chat: [u1, a1, u2, a2],
    createdAt: "2026-10-01T08:01:00.000Z",
  });
  const v3 = localProject("v3", {
    revision: 3,
    parentId: "v2",
    chat: [u1, a1, u2, a2, u3, a3],
    createdAt: "2026-10-01T08:02:00.000Z",
  });
  // v2 was deleted from the library: v1 and v3 are still one piece (they share the conversation)
  const gap = lineage(v1, [v3, v1]);
  assert.deepEqual(
    gap.versions.map((item) => item.id),
    ["v3", "v1"],
  );
  assert.equal(gap.thread.length, 6);
  assert.equal(
    versionOfTurn(a2, gap.versions, v1),
    undefined,
    "the tag of a deleted version opens nothing",
  );
  assert.equal(versionOfTurn(a3, gap.versions, v1)?.id, "v3");
  assert.equal(
    versionOfTurn(u3, gap.versions, v1),
    undefined,
    "user turns have no version",
  );
  // an imported copy of v3 has the same conversation: the loaded work stays "the newest" and "current"
  const copy = { ...v3, id: "copy", createdAt: "2026-10-05T08:00:00.000Z" };
  const withCopy = lineage(v3, [copy, v3, v2, v1]);
  assert.equal(withCopy.latest.id, "v3");
  assert.equal(versionOfTurn(a3, withCopy.versions, v3)?.id, "v3");
  assert.equal(versionOfTurn(a3, withCopy.versions, copy)?.id, "copy");
  // works of v0.3.0 could fork with the same number; a branch that does not continue the loaded work's
  // conversation is never shown in its place
  const fork = localProject("fork", {
    revision: 2,
    parentId: "v1",
    chat: [u1, a1, turn("ux", "user"), turn("ax", "agent", 2)],
    createdAt: "2026-10-01T09:00:00.000Z",
  });
  assert.deepEqual(lineage(v2, [fork, v3, v2, v1]).thread, v3.chat);
  assert.equal(versionOfTurn(a2, [fork, v3, v2, v1], v2)?.id, "v2");
  assert.equal(
    versionOfTurn(turn("ax", "agent", 2), [fork, v3, v2, v1], v2)?.id,
    "fork",
  );
  assert.equal(nextRevisionIn(fork, [fork, v3, v2, v1]), 4);
  // works without any conversation are linked through parentId alone
  const bare1 = localProject("b1");
  const bare2 = localProject("b2", {
    revision: 2,
    parentId: "b1",
    chat: [u1, a1],
  });
  assert.deepEqual(lineage(bare1, [bare2, bare1]).thread, bare2.chat);
  assert.deepEqual(lineage(bare1, [bare1]).thread, []);
  // a work that is not in the list yet (an unsaved result) is its own lineage plus its relatives
  assert.deepEqual(
    lineageOf(v2, [v1]).map((item) => item.id),
    ["v2", "v1"],
  );
});

test("UX-03: a style card or a style chip alone sends the pin and no invented description", async () => {
  // 19 of 22 style cards used to come back different from their own preset, with bogus notes.
  for (const style of STYLES) {
    const choice = styleInspiration(style);
    assert.deepEqual(choice, { text: "", mood: style.id });
    assert.equal(canSendPinsOnly(choice.text, { mood: style.id }), true);
    const request = buildAgentRequest({
      text: choice.text,
      project: null,
      thread: [],
      pins: { mood: style.id },
      provider: "local",
      nextSeed: 7,
    });
    assert.equal(request.text, "");
    assert.deepEqual(request.pins, { mood: style.id });
    const plan = withStylePrompt(
      enforcePins(planWithRules(request), request),
      request,
    );
    const preset = stylePreset(style.id);
    for (const key of Object.keys(preset) as (keyof typeof preset)[])
      assert.deepEqual(
        plan.config[key as keyof typeof plan.config],
        preset[key],
        `${style.id}.${String(key)}`,
      );
    assert.equal(plan.unchanged, false);
    assert.equal(
      plan.config.prompt,
      style.label,
      "the stored description is the style's name, not its blurb",
    );
    assert.ok(
      !plan.reasoning.some((line) => /暂无|不能只修改|没有听出/.test(line)),
      `${style.id}: ${plan.reasoning.join(" / ")}`,
    );
    assert.doesNotMatch(plan.reply, /暂无|不能只修改|没听出/, style.id);
    // UX-04: the line states the tempo the loop is fitted to, with the preset's next to it when they differ
    const fitted = formatBpm(fittedTiming(plan.config).bpm);
    const tempo =
      fitted === String(preset.bpm)
        ? `${preset.bpm} BPM`
        : `${fitted} BPM（设定 ${preset.bpm}）`;
    assert.ok(
      (planPreview("", { mood: style.id })?.line ?? "").startsWith(
        `将创作：${style.label} · ${tempo} · `,
      ),
      `${style.id}: ${planPreview("", { mood: style.id })?.line}`,
    );
  }
  assert.equal(planPreview("", {}), null);
  assert.equal(
    planPreview("   ", { duration: 60 }),
    null,
    "a duration alone is not a request",
  );
  assert.equal(canSendPinsOnly("夏日", { mood: "rock" }), false);
  assert.equal(pinsOnlyText({ mood: "rock" }), `「${styleLabel("rock")}」风格`);

  // through the app: card → composer stays empty → send
  const { h } = await withWork();
  h.core.actions.chooseInspiration(
    styleInspiration(STYLES.find((style) => style.id === "rock") ?? STYLES[0]),
  );
  assert.equal(studio(h).composerText, "", "nothing is written for the user");
  assert.deepEqual(studio(h).pins, { mood: "rock" });
  assert.equal(await h.core.actions.send(), true);
  const project = studio(h).project;
  assert.equal(
    h.plans.at(-1)?.text,
    "",
    "the producer got the pin and no text",
  );
  assert.equal(project?.config.mood, "rock");
  assert.equal(
    project?.config.bpm,
    stylePreset("rock").bpm,
    "v0.3.0: 170 BPM, parsed out of the blurb",
  );
  assert.equal(project?.config.prompt, styleLabel("rock"));
  assert.equal(studio(h).thread[0].text, `「${styleLabel("rock")}」风格`);
  assert.deepEqual(
    h.storage.records.get(project?.id ?? ""),
    project,
    "and it is a valid record",
  );
  // the user's own words still count, on top of the pinned style
  h.core.actions.chooseInspiration(
    styleInspiration(STYLES.find((style) => style.id === "rock") ?? STYLES[0]),
  );
  h.core.actions.setComposerText("公路旅行，90 BPM");
  assert.equal(await h.core.actions.send(), true);
  assert.equal(studio(h).project?.config.mood, "rock");
  assert.equal(studio(h).project?.config.bpm, 90);
  assert.equal(studio(h).project?.config.prompt, "公路旅行，90 BPM");
  // nothing typed and nothing pinned is still nothing to send; with a work loaded, a pin is not a message
  assert.equal(h.core.actions.newPiece(), true);
  assert.equal(await h.core.actions.send(), false);
  assert.match(
    toasts(h).at(-1) ?? "",
    /先描述一下你想要的音乐，或者选一个风格/,
  );
});

/* ================================================================== */
/* CORE-08: raw exception text never reaches the user                   */
/* ================================================================== */

test("CORE-08: an exception wrapped in a Chinese prefix is still not shown", async () => {
  const fallback = "本地作曲引擎出错了，请换个描述或参数再试。";
  // exactly what the engine facade builds from a worker error / crash
  for (const raw of [
    "本地引擎出错：Cannot read properties of undefined (reading 'length')",
    "本地引擎出错：Uncaught TypeError: x.map is not a function",
    "本地引擎出错：ReferenceError: foo is not defined",
    "渲染失败：Unexpected token < in JSON at position 0",
    "Cannot read properties of undefined (reading 'length')",
  ])
    assert.equal(errorText(new Error(raw), fallback), fallback, raw);
  // running out of memory is said as such, whatever wraps it
  for (const raw of [
    "本地引擎出错：Uncaught RangeError: Array buffer allocation failed",
    "本地引擎出错：RangeError: Invalid typed array length: 4294967296",
    "RangeError: Maximum call stack size exceeded",
  ])
    assert.equal(errorText(new Error(raw), fallback), OUT_OF_MEMORY_TEXT, raw);
  // our own messages pass as they are — also with product names, codes and Latin words in them
  for (const own of [
    "合成器内部错误，请重试。",
    "API Key 无效或已过期，请在设置中更新密钥。",
    "ElevenLabs Music API 没有返回音频，请稍后重试。",
    "腾讯云 TokenHub 返回错误（AuthFailure.SignatureFailure）：签名不正确。",
    "内存不足，无法生成这么长的音频",
    "火山引擎 AI 音乐支持 30–120 秒，这次的时长是 15 秒。",
  ])
    assert.equal(errorText(new Error(own), fallback), own);

  // through the app: the toast and the thread
  const h = harness();
  await h.core.start();
  h.renderError.current = new Error(
    "本地引擎出错：Cannot read properties of undefined (reading 'length')",
  );
  assert.equal(await h.core.actions.send("夏日海边的轻快钢琴"), false);
  assert.equal(
    toasts(h).at(-1),
    `生成失败：${fallback}`,
    "v0.3.0 showed the English exception text",
  );
  h.renderError.current = new Error(
    "本地引擎出错：Uncaught RangeError: Array buffer allocation failed",
  );
  assert.equal(await h.core.actions.send("夏日海边的轻快钢琴"), false);
  assert.equal(toasts(h).at(-1), `生成失败：${OUT_OF_MEMORY_TEXT}`);
  h.renderError.current = null;
  assert.equal(await h.core.actions.send("夏日海边的轻快钢琴"), true);
  h.renderError.current = new Error(
    "本地引擎出错：Cannot read properties of undefined (reading 'length')",
  );
  assert.equal(await h.core.actions.send("慢一点"), false);
  assert.equal(studio(h).thread.at(-1)?.text, `这次没有生成成功：${fallback}`);
});

/* ================================================================== */
/* a finished cloud result whose file did not arrive                    */
/* ================================================================== */

const NOT_DOWNLOADED =
  "音乐已生成，但下载失败（已尝试 4 次，网络不稳定或文件服务器暂时不可用）。重新生成会再次计费：请先检查网络，再到服务控制台找回这首音乐。（任务编号 task-0001）";
const DOWNLOAD_CANCELLED =
  "已取消下载。音乐已经生成，重新生成会再次计费：需要时请到服务控制台找回这首音乐。（任务编号 task-0002）";
const NOTHING_WAITING =
  "没有等待重新下载的音乐。如需这首音乐，请到服务控制台查找，或重新生成。";
const MP3_ANSWER = () => ({
  audio: MP3_BYTES.slice().buffer,
  mimeType: "audio/mpeg",
});
const offer = (h: Harness): Toast | undefined =>
  ui(h).toasts.find((toast) => toast.action?.label === "重新下载");
const downloads = (h: Harness) =>
  (h.bridge?.calls ?? []).filter((call) =>
    call.startsWith("retryLastDownload"),
  );

/** Click 重新下载 the way the toast does (run, then the toast closes) and wait for the job. */
async function redownload(h: Harness) {
  const toast = offer(h);
  assert.ok(toast?.action, "重新下载 is on offer");
  toast.action.run();
  h.core.actions.dismissToast(toast.id);
  for (let i = 0; i < 50 && studio(h).job; i++) await settle();
  assert.equal(studio(h).job, null, "the download job has ended");
}

test("MAIN-02: a finished result whose download failed is fetched again, never asked for twice", async () => {
  const { h, bridge } = await desktop();
  h.core.actions.setProvider("tencent");
  bridge.generate = async () => {
    throw new Error(NOT_DOWNLOADED);
  };
  h.core.actions.setComposerText("雨夜咖啡馆");
  assert.equal(await paid(h, () => h.core.actions.send()), false);
  assert.equal(paidCalls(h), 1);
  assert.equal(studio(h).project, null);
  // One notice: what happened (with the task number), and the way out that costs nothing.
  const first = offer(h);
  assert.ok(
    first,
    "v0.3.0 only said 生成失败 and left the paid result on the server",
  );
  assert.equal(
    first.text,
    `${NOT_DOWNLOADED}也可以点「重新下载」再取一次，不会再次计费。`,
  );
  assert.equal(first.kind, "error");
  assert.equal(first.sticky, true);
  assert.deepEqual(
    toasts(h).filter((text) => text.startsWith("生成失败")),
    [],
    "the music WAS made",
  );
  assert.equal(
    studio(h).composerText,
    "雨夜咖啡馆",
    "the description is handed back",
  );
  // The address of the result lives only in this run of the app: closing asks first.
  assert.match(
    h.core.closeRisk() ?? "",
    /还没有下载下来.*重新生成需要再次付费/,
  );
  assert.equal(bridge.risk.at(-1), true);

  // Still no luck: the offer stays, nothing new is submitted.
  bridge.download = async () => {
    throw new Error(NOT_DOWNLOADED);
  };
  await redownload(h);
  assert.deepEqual(downloads(h), ["retryLastDownload:tencent"]);
  assert.equal(paidCalls(h), 1, "a download is not a generation");
  assert.ok(offer(h), "the offer is back");
  assert.equal(studio(h).project, null);
  assert.equal(bridge.risk.at(-1), true);

  // The file arrives: stored first, decoded, loaded — exactly like a fresh result.
  bridge.download = async () => MP3_ANSWER();
  const stages: string[] = [];
  const stop = h.core.subscribe(() => {
    const stage = studio(h).job?.stage;
    if (stage && stages.at(-1) !== stage) stages.push(stage);
  });
  await redownload(h);
  stop();
  assert.deepEqual(stages, ["downloading", "saving", "decoding"]);
  assert.equal(
    paidCalls(h),
    1,
    "v0.3.0: the only way to get the music was a second paid request",
  );
  assert.equal(downloads(h).length, 2);
  const work = studio(h).project;
  assert.ok(work);
  assert.equal(work.provider, "tencent");
  assert.equal(work.revision, 1);
  assert.equal(work.audioBlob?.size, MP3_BYTES.length);
  assert.equal(work.cloud?.prompt.endsWith("纯音乐，无人声，无歌词"), true);
  assert.equal(studio(h).stored, true);
  assert.deepEqual(ids(h), [work.id]);
  assert.deepEqual(
    studio(h).thread.map((turn) => turn.role),
    ["user", "agent"],
  );
  assert.equal(studio(h).thread[0].text, "雨夜咖啡馆");
  assert.equal(
    studio(h).composerText,
    "",
    "the words that were handed back have been answered",
  );
  assert.equal(toasts(h).at(-1), "创作完成，已保存到「我的作品」");
  assert.equal(offer(h), undefined, "nothing is left to fetch");
  assert.equal(h.core.closeRisk(), null);
  assert.equal(bridge.risk.at(-1), false);
});

test("MAIN-02: the offer follows what the main process still holds", async () => {
  const { h, bridge } = await desktop({
    records: [cloudWork("paid")],
    session: { lastProjectId: "paid" },
  });
  const before = studio(h).thread.length;
  bridge.generate = async () => {
    throw new Error(NOT_DOWNLOADED);
  };
  // A refinement: the thread tells what happened in the service's own words.
  assert.equal(await paid(h, () => h.core.actions.send("慢一点")), false);
  assert.equal(studio(h).thread.length, before + 2);
  assert.equal(
    studio(h).thread.at(-1)?.text,
    NOT_DOWNLOADED,
    "not 这次没有生成成功: it was generated",
  );
  assert.equal(studio(h).thread.at(-1)?.error, true);
  assert.ok(offer(h));

  // Closing the notice declines the offer: nothing is at risk any more.
  h.core.actions.dismissToast(offer(h)?.id ?? -1);
  assert.equal(h.core.closeRisk(), null);
  assert.equal(bridge.risk.at(-1), false);

  // Offered again after the next failure; this time the main process has let go of the result.
  assert.equal(await paid(h, () => h.core.actions.send("慢一点")), false);
  assert.ok(offer(h));
  bridge.download = async () => {
    throw new Error(NOTHING_WAITING);
  };
  await redownload(h);
  assert.equal(offer(h), undefined, "nothing to fetch, nothing to offer");
  assert.equal(toasts(h).at(-1), NOTHING_WAITING);
  assert.equal(h.core.closeRisk(), null);

  // A new paid request replaces a waiting result (the main process drops it too).
  assert.equal(await paid(h, () => h.core.actions.send("慢一点")), false);
  assert.ok(offer(h));
  bridge.generate = async () => MP3_ANSWER();
  const sent = h.core.actions.send("再慢一点");
  await settle();
  assert.ok(ui(h).dialog, "the paid question");
  assert.ok(
    offer(h),
    "asking is not sending: the offer stands until a request really goes out",
  );
  await answer(h, "confirm");
  assert.equal(await sent, true);
  assert.equal(offer(h), undefined);
  assert.equal(downloads(h).length, 1);

  // The delivered version continues the conversation it was asked in, with its own number.
  bridge.generate = async () => {
    throw new Error(NOT_DOWNLOADED);
  };
  const base = studio(h).project;
  assert.ok(base);
  assert.equal(await paid(h, () => h.core.actions.send("混响大一点")), false);
  bridge.download = async () => MP3_ANSWER();
  await redownload(h);
  const delivered = studio(h).project;
  assert.ok(delivered);
  assert.equal(delivered.parentId, base.id);
  assert.equal(delivered.revision, base.revision + 1);
  assert.equal(studio(h).thread.at(-2)?.text, "混响大一点");
  assert.equal(studio(h).thread.at(-1)?.revision, delivered.revision);
  assert.equal(
    studio(h).thread.at(-1)?.error,
    undefined,
    "the failure note made way for the answer",
  );
});

test("MAIN-02: stopping the wait after the service finished still leaves the result fetchable", async () => {
  const { h, bridge } = await desktop();
  h.core.actions.setProvider("tencent");
  const gate = defer<{ audio: ArrayBuffer; mimeType: string }>();
  bridge.generate = () => gate.promise;
  const sent = paid(h, () => h.core.actions.send("雨夜咖啡馆"));
  await settle();
  await settle();
  assert.equal(studio(h).job?.stage, "cloud");
  h.core.actions.cancelJob();
  // what the main process answers when the result existed and only the download was cut short
  gate.reject(new Error(DOWNLOAD_CANCELLED));
  assert.equal(await sent, false);
  assert.equal(
    offer(h)?.text,
    `${DOWNLOAD_CANCELLED}也可以点「重新下载」再取一次，不会再次计费。`,
  );
  // Cancelling the download itself costs nothing and keeps the offer.
  const again = defer<{ audio: ArrayBuffer; mimeType: string }>();
  bridge.download = () => again.promise;
  const toast = offer(h);
  toast?.action?.run();
  h.core.actions.dismissToast(toast?.id ?? -1);
  await settle();
  assert.equal(studio(h).job?.stage, "downloading");
  assert.match(studio(h).job?.phase ?? "", /重新下载.*不会再次计费/);
  assert.match(h.core.closeRisk() ?? "", /还没有下载下来/);
  h.core.actions.cancelJob();
  assert.equal(
    bridge.calls.filter((call) => call === "cancelGeneration").length,
    2,
    "the one job of the main process is told to stop",
  );
  assert.equal(toasts(h).at(-1), "已取消下载，没有发送新的生成请求。");
  again.reject(new Error(DOWNLOAD_CANCELLED));
  for (let i = 0; i < 20 && studio(h).job; i++) await settle();
  assert.ok(offer(h), "still on offer");
  assert.equal(paidCalls(h), 1);
  // A failure that is not about a download is not turned into an offer.
  const { h: other, bridge: plain } = await desktop();
  other.core.actions.setProvider("tencent");
  plain.generate = async () => {
    throw new Error("API Key 无效或已过期，请检查所选服务的密钥。");
  };
  assert.equal(
    await paid(other, () => other.core.actions.send("雨夜咖啡馆")),
    false,
  );
  assert.equal(offer(other), undefined);
  assert.equal(
    toasts(other).at(-1),
    "生成失败：API Key 无效或已过期，请检查所选服务的密钥。",
  );
  assert.equal(other.core.closeRisk(), null);
});
