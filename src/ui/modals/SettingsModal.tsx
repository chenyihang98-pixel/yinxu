/**
 * 设置: AI 音乐服务 (cloud providers), 制作人大模型 (the producer's LLM) and
 * 关于. Secrets are write-only: they are never read back or shown again. The
 * web build explains where these features live instead of showing forms.
 */
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import {
  ArrowUpRight,
  Bot,
  Cloud,
  ExternalLink,
  HardDrive,
  Info,
  KeyRound,
  Lock,
  Monitor,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  TriangleAlert,
} from "lucide-react";
import { LLM_PRESETS, llmPreset } from "../../agent/llm-presets";
import { INSTRUMENT_LIST, KEYS, STYLES } from "../../music/catalog";
import { CLOUD_PROVIDERS } from "../../providers";
import type { CloudProviderInfo } from "../../providers";
import {
  MODEL_NAME_SHAPES,
  keyShapeWarning,
  modelNameHint,
} from "../../state/content";
import { useApp } from "../../state/context";
import { formatBytes } from "../../state/format";
import { joinText } from "../../state/logic";
import type {
  ActionResult,
  SettingsTab,
  SettingsView,
  UiMode,
} from "../../state/types";
import type { CloudProvider, ProviderStatus } from "../../types";
import { rovingIndex } from "../logic/focus";
import { LogoMark } from "../primitives/Art";
import { Button, LinkButton, classes } from "../primitives/Button";
import { Badge, Field, Select, useFieldId } from "../primitives/Controls";
import { Modal } from "../primitives/Modal";

const TABS: { id: SettingsTab; label: string; icon: ReactNode }[] = [
  {
    id: "general",
    label: "常规",
    icon: <SlidersHorizontal size={15} aria-hidden />,
  },
  { id: "music", label: "AI 音乐服务", icon: <Cloud size={15} aria-hidden /> },
  { id: "llm", label: "制作人大模型", icon: <Bot size={15} aria-hidden /> },
  { id: "about", label: "关于", icon: <Info size={15} aria-hidden /> },
];

function statusOf(status: ProviderStatus): {
  text: string;
  tone: "ok" | "warn" | "neutral";
} {
  if (status.damaged)
    return { text: "凭据无法读取 · 请重新保存", tone: "warn" };
  if (status.configured) return { text: "凭据已保存", tone: "ok" };
  return { text: "尚未配置", tone: "neutral" };
}

function DesktopOnly(props: { what: string; children: ReactNode }) {
  const { platform } = useApp();
  return (
    <div className="desktop-only" data-testid="desktop-only">
      <span className="desktop-only-art" aria-hidden>
        <Monitor size={24} />
      </span>
      <h3>{props.what}在桌面版中提供</h3>
      <p>{props.children}</p>
      <p className="muted">
        网页版的本地作曲功能完整可用，不联网，也不需要任何密钥。
      </p>
      <a
        className="btn btn-primary"
        href={platform.downloadUrl}
        target="_top"
        rel="noopener"
        data-testid="desktop-download"
      >
        桌面版可用 · 下载 Windows 版
        <ArrowUpRight size={15} aria-hidden />
      </a>
    </div>
  );
}

function FormError(props: { message: string }) {
  if (!props.message) return null;
  return (
    <p className="notice notice-danger" role="alert">
      <TriangleAlert size={16} aria-hidden />
      <span>{props.message}</span>
    </p>
  );
}

/* ---------------- 常规 ---------------- */

const MODES: { id: UiMode; label: string; text: string }[] = [
  {
    id: "simple",
    label: "简单模式（推荐）",
    text: "点一个场景就出音乐，不用懂任何音乐知识。",
  },
  {
    id: "pro",
    label: "专业模式",
    text: "完整的创作工具：用对话细细地改、逐项调整声音、单独调整每种乐器的音量、更多下载格式。",
  },
];

function GeneralTab() {
  const { ui, actions } = useApp();
  return (
    <div className="settings-pane" data-testid="settings-general">
      <div
        className="mode-choice"
        role="radiogroup"
        aria-labelledby="mode-choice-title"
      >
        <h3 id="mode-choice-title">界面模式</h3>
        {MODES.map((mode) => (
          <button
            key={mode.id}
            type="button"
            role="radio"
            className="mode-option"
            data-testid={`mode-${mode.id}`}
            aria-checked={ui.mode === mode.id}
            onClick={() => actions.setMode(mode.id)}
          >
            <span className="mode-dot" aria-hidden />
            <span className="mode-text">
              <strong>{mode.label}</strong>
              <span>{mode.text}</span>
            </span>
          </button>
        ))}
        <p className="muted">
          两种模式用的是同一批音乐：切换不会丢掉任何一首，正在听的这首也还在。
        </p>
      </div>
    </div>
  );
}

/* ---------------- AI 音乐服务 ---------------- */

function ProviderForm(props: { info: CloudProviderInfo }) {
  const { info } = props;
  const { settings, studio, actions } = useApp();
  const status = settings.providers[info.id];
  const [fields, setFields] = useState<Record<string, string>>({});
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const ids = useFieldId(`provider-${info.id}`);
  const value = (name: string, fallback = "") => fields[name] ?? fallback;
  const set = (name: string, next: string) => {
    setSaved(false);
    setFields((current) => ({ ...current, [name]: next }));
  };
  const model = value("model", status.model ?? info.models[0]?.id ?? "");
  const workspaceId = value("workspaceId", status.workspaceId ?? "");
  const billingMode = value("billingMode", status.billingMode ?? "postpaid");
  const ready =
    info.credentials === "accessKey"
      ? !!value("accessKeyId").trim() && !!value("secretAccessKey").trim()
      : !!value("apiKey").trim() &&
        (info.id !== "aliyun" || !!workspaceId.trim());
  const locked = working || studio.busy;
  const run = async (task: () => Promise<ActionResult>, done: boolean) => {
    setWorking(true);
    setError("");
    setSaved(false);
    const result = await task();
    setWorking(false);
    if (result.ok) {
      setFields({});
      setSaved(done);
    } else setError(result.message);
  };
  const secret = (name: string, label: string, placeholder: string) => (
    <Field label={label} htmlFor={`${ids}-${name}`}>
      <input
        id={`${ids}-${name}`}
        className="input"
        type="password"
        autoComplete="off"
        spellCheck={false}
        data-testid={`provider-${info.id}-${name}`}
        value={value(name)}
        placeholder={placeholder}
        disabled={locked}
        onChange={(event) => set(name, event.target.value)}
      />
    </Field>
  );
  const kept = status.configured && !status.damaged;
  return (
    <fieldset
      className="provider-form"
      data-testid={`provider-${info.id}`}
      aria-label={info.name}
    >
      <div className="provider-facts">
        <p>{info.requirement}</p>
        <p className="muted">{info.durationNote}</p>
      </div>
      {status.damaged && (
        <p className="notice notice-warn">
          <TriangleAlert size={16} aria-hidden />
          <span>
            已保存的凭据无法读取（可能是换了 Windows
            账户或系统）。请重新保存，或移除它。
          </span>
        </p>
      )}
      <div className="form-grid">
        {info.credentials === "accessKey" ? (
          <>
            {secret(
              "accessKeyId",
              "Access Key ID",
              kept
                ? "已加密保存 · 替换时重新填写"
                : "填写火山引擎 Access Key ID",
            )}
            {secret(
              "secretAccessKey",
              "Secret Access Key",
              kept
                ? "已加密保存 · 替换时重新填写"
                : "填写火山引擎 Secret Access Key",
            )}
            <Field label="计费方式" htmlFor={`${ids}-billing`}>
              <Select
                block
                id={`${ids}-billing`}
                data-testid={`provider-${info.id}-billingMode`}
                value={billingMode}
                disabled={locked}
                onChange={(event) => set("billingMode", event.target.value)}
              >
                <option value="postpaid">按调用量后付费</option>
                <option value="prepaid">按套餐预付费</option>
              </Select>
            </Field>
          </>
        ) : (
          <>
            {secret(
              "apiKey",
              "API Key",
              kept
                ? "已加密保存 · 替换时重新填写密钥"
                : joinText("粘贴", info.name, "的 API Key"),
            )}
            {info.id === "aliyun" && (
              <Field
                label="Workspace ID · 北京地域"
                htmlFor={`${ids}-workspace`}
              >
                <input
                  id={`${ids}-workspace`}
                  className="input"
                  autoComplete="off"
                  spellCheck={false}
                  data-testid={`provider-${info.id}-workspaceId`}
                  value={workspaceId}
                  placeholder="业务空间详情中的 ID，非名称或 URL"
                  disabled={locked}
                  onChange={(event) => set("workspaceId", event.target.value)}
                />
              </Field>
            )}
            {info.models.length > 0 && (
              <Field label="音乐模型" htmlFor={`${ids}-model`}>
                <Select
                  block
                  id={`${ids}-model`}
                  data-testid={`provider-${info.id}-model`}
                  value={model}
                  disabled={locked}
                  onChange={(event) => set("model", event.target.value)}
                >
                  {info.models.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
          </>
        )}
      </div>
      <FormError message={error} />
      {saved && (
        <p className="form-saved" role="status">
          <ShieldCheck size={15} aria-hidden />
          已保存。保存不会向服务商发起请求，也不会计费。
        </p>
      )}
      <div className="form-actions">
        <Button
          variant="primary"
          data-testid={`provider-${info.id}-save`}
          busy={working}
          disabled={!ready || locked}
          onClick={() =>
            void run(
              () =>
                actions.saveProvider(info.id, {
                  ...fields,
                  model,
                  workspaceId,
                  billingMode,
                }),
              true,
            )
          }
        >
          {kept ? "替换凭据" : "保存凭据"}
        </Button>
        {(status.configured || status.damaged) && (
          <Button
            variant="danger"
            data-testid={`provider-${info.id}-remove`}
            disabled={locked}
            onClick={() =>
              void run(() => actions.removeProvider(info.id), false)
            }
          >
            移除凭据
          </Button>
        )}
        <span className="grow" />
        <LinkButton
          data-testid={`provider-${info.id}-docs`}
          onClick={() => actions.openLink(info.docs)}
        >
          开通与接口说明
          <ExternalLink size={13} aria-hidden />
        </LinkButton>
        <LinkButton
          data-testid={`provider-${info.id}-console`}
          onClick={() => actions.openLink(info.console)}
        >
          服务商控制台
          <ExternalLink size={13} aria-hidden />
        </LinkButton>
      </div>
    </fieldset>
  );
}

/** The service to show first: asked for, in use, broken, set up, or the first. */
function firstProvider(
  settings: SettingsView,
  hint: CloudProvider | null,
  inUse: string,
): CloudProvider {
  const ids = CLOUD_PROVIDERS.map((info) => info.id);
  return (
    hint ??
    ids.find((id) => id === inUse) ??
    ids.find((id) => settings.providers[id]?.damaged) ??
    ids.find((id) => settings.providers[id]?.configured) ??
    ids[0]
  );
}

function MusicTab() {
  const { settings, studio, ui } = useApp();
  const [chosen, setChosen] = useState<CloudProvider>(() =>
    firstProvider(settings, ui.settingsProvider, studio.provider),
  );
  // A refusal ("先配置阿里云") while the modal is open moves to that service.
  useEffect(() => {
    if (ui.settingsProvider) setChosen(ui.settingsProvider);
  }, [ui.settingsProvider]);
  if (settings.status === "unavailable")
    return (
      <DesktopOnly what="云端生成">
        接入腾讯云、火山引擎、阿里云或 ElevenLabs
        的音乐模型需要在本机加密保存密钥，并由桌面应用直接连接服务商。
      </DesktopOnly>
    );
  const info =
    CLOUD_PROVIDERS.find((item) => item.id === chosen) ?? CLOUD_PROVIDERS[0];
  return (
    <div className="settings-pane">
      <p className="notice notice-accent">
        <KeyRound size={16} aria-hidden />
        <span>
          密钥只保存在这台电脑上，由 Windows
          加密，保存后不会回显；保存不会发起计费请求。选择云端生成时，你的描述会发送给所选服务商并按其价格计费，输出是混合音轨。
        </span>
      </p>
      {settings.status === "error" && settings.error && (
        <FormError message={settings.error} />
      )}
      <div className="provider-tiles" role="group" aria-label="选择服务商">
        {CLOUD_PROVIDERS.map((item) => {
          const status = statusOf(settings.providers[item.id]);
          return (
            <button
              key={item.id}
              type="button"
              className="provider-tile"
              data-testid={`provider-${item.id}-tab`}
              aria-pressed={item.id === info.id}
              onClick={() => setChosen(item.id)}
            >
              <strong>{item.name}</strong>
              <span className="provider-tile-text">{item.description}</span>
              <Badge tone={status.tone} testId={`provider-${item.id}-status`}>
                {status.text}
              </Badge>
            </button>
          );
        })}
      </div>
      <ProviderForm key={info.id} info={info} />
    </div>
  );
}

/* ---------------- 制作人大模型 ---------------- */

function LlmTab() {
  const { settings, studio, actions } = useApp();
  const { llm } = settings;
  const [presetId, setPresetId] = useState(llm.preset ?? LLM_PRESETS[0].id);
  const preset = llmPreset(presetId);
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(llm.model ?? "");
  const [baseUrl, setBaseUrl] = useState(llm.baseUrl ?? "");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const ids = useFieldId("llm");
  // The main process stores a normalised address and model (localhost →
  // 127.0.0.1, no trailing slash): after a save the form shows what is stored.
  useEffect(() => {
    if (!llm.configured || llm.preset !== presetId) return;
    if (llm.baseUrl) setBaseUrl(llm.baseUrl);
    if (llm.model) setModel(llm.model);
    // presetId is not a dependency: choosing a preset must not refill the fields
  }, [llm.configured, llm.preset, llm.baseUrl, llm.model]);
  if (settings.status === "unavailable")
    return (
      <DesktopOnly what="制作人大模型">
        接入你自己的大模型（Claude、DeepSeek、通义千问、本机 Ollama
        等）后，制作人能听懂更自由的说法。密钥需要在本机加密保存，并由桌面应用直接连接服务商。
      </DesktopOnly>
    );
  const choose = (id: string) => {
    const next = llmPreset(id);
    setPresetId(next.id);
    setModel(next.models[0] ?? "");
    setBaseUrl(next.baseUrl ?? "");
    setApiKey("");
    setError("");
  };
  const needsKey = preset.kind !== "ollama";
  const editableUrl = preset.id === "custom" || preset.kind === "ollama";
  const chosenModel = model || preset.models[0] || "";
  const url = baseUrl || preset.baseUrl || "";
  // What is still missing, by its label on the form: said next to the save
  // button, so a disabled button always comes with its reason.
  const missing = [
    ...(chosenModel.trim() ? [] : ["模型"]),
    ...(!needsKey || apiKey.trim() ? [] : ["API Key"]),
    ...(preset.kind !== "openai" || url.trim() ? [] : ["接口地址"]),
  ];
  const ready = missing.length === 0;
  const locked = working || studio.busy;
  const rekey = llm.configured && llm.preset === preset.id;
  const reason = studio.busy
    ? "正在生成或打开作品，完成后才能保存设置。"
    : !ready
      ? `还需要填写：${missing.join("、")}${
          rekey && missing.includes("API Key")
            ? "（密钥不会回显，修改设置时要重新填写）"
            : ""
        }`
      : "";
  const shape = MODEL_NAME_SHAPES[preset.id];
  const keyWarning = needsKey ? keyShapeWarning(preset.id, apiKey) : "";
  const run = async (task: () => Promise<ActionResult>) => {
    setWorking(true);
    setError("");
    const result = await task();
    setWorking(false);
    if (result.ok) setApiKey("");
    else setError(result.message);
  };
  const current = llm.damaged
    ? { tone: "warn" as const, text: "设置无法读取，请重新保存" }
    : llm.configured
      ? {
          tone: "ok" as const,
          text: `已配置 · ${llmPreset(llm.preset).label} · ${llm.model ?? ""}`,
        }
      : { tone: "neutral" as const, text: "尚未配置，制作人使用离线规则" };
  return (
    <div className="settings-pane" data-testid="llm-form">
      <p className="notice notice-accent">
        <KeyRound size={16} aria-hidden />
        <span data-testid="llm-notice">
          {preset.kind === "ollama"
            ? "本机 Ollama：你的描述文字只发给这台电脑上的 Ollama，不经过网络，也不需要密钥。"
            : "你的描述文字会发送给所选服务商；密钥由 Windows 加密保存，不会回显。"}
          模型不可用时，制作人会改用离线规则；选了云端生成时会先问你。
        </span>
      </p>
      <p className="llm-status" data-testid="llm-status">
        <span className="muted">当前状态</span>
        <Badge tone={current.tone}>{current.text}</Badge>
      </p>
      <div className="form-grid">
        <Field label="服务商" htmlFor={`${ids}-preset`}>
          <Select
            block
            id={`${ids}-preset`}
            data-testid="llm-preset"
            value={preset.id}
            disabled={locked}
            onChange={(event) => choose(event.target.value)}
          >
            {LLM_PRESETS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="模型"
          htmlFor={`${ids}-model`}
          hint={
            preset.models.length > 0 ? undefined : (
              <span data-testid="llm-model-hint">{modelNameHint(preset)}</span>
            )
          }
        >
          {preset.models.length > 0 ? (
            <Select
              block
              id={`${ids}-model`}
              data-testid="llm-model"
              value={chosenModel}
              disabled={locked}
              onChange={(event) => setModel(event.target.value)}
            >
              {preset.models.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </Select>
          ) : (
            <input
              id={`${ids}-model`}
              className="input"
              autoComplete="off"
              spellCheck={false}
              data-testid="llm-model"
              aria-required="true"
              value={model}
              // An example of the format, worded as one: not a value.
              placeholder={shape ? `形如 ${shape}` : "模型名称"}
              disabled={locked}
              onChange={(event) => setModel(event.target.value)}
            />
          )}
        </Field>
        {needsKey && (
          <Field
            label="API Key"
            htmlFor={`${ids}-key`}
            className="form-wide"
            aside={
              preset.keyUrl && (
                <LinkButton
                  className="field-aside"
                  data-testid="llm-key-link"
                  onClick={() => actions.openLink(preset.keyUrl ?? "")}
                >
                  获取 API Key
                  <ExternalLink size={13} aria-hidden />
                </LinkButton>
              )
            }
          >
            <input
              id={`${ids}-key`}
              className="input"
              type="password"
              autoComplete="off"
              spellCheck={false}
              data-testid="llm-key"
              aria-required="true"
              value={apiKey}
              placeholder={
                rekey ? "已加密保存 · 修改设置时需要重新填写" : preset.keyHint
              }
              disabled={locked}
              aria-describedby={keyWarning ? `${ids}-key-warning` : undefined}
              onChange={(event) => setApiKey(event.target.value)}
            />
            {keyWarning && (
              <p
                className="field-hint field-warning"
                id={`${ids}-key-warning`}
                data-testid="llm-key-warning"
              >
                {keyWarning}
              </p>
            )}
          </Field>
        )}
        {preset.kind !== "anthropic" && (
          <Field
            label="接口地址"
            htmlFor={`${ids}-url`}
            className="form-wide"
            hint={
              editableUrl
                ? undefined
                : "由所选服务商决定，不能在这里修改；要用别的地址，请把服务商换成「自定义 OpenAI 兼容接口」。"
            }
          >
            <span
              className="input-wrap"
              data-locked={!editableUrl || undefined}
            >
              <input
                id={`${ids}-url`}
                className="input"
                autoComplete="off"
                spellCheck={false}
                data-testid="llm-base-url"
                value={url}
                placeholder="形如 https://example.com/v1"
                readOnly={!editableUrl}
                disabled={locked}
                onChange={(event) => setBaseUrl(event.target.value)}
              />
              {!editableUrl && <Lock size={13} aria-hidden />}
            </span>
          </Field>
        )}
      </div>
      {preset.note && <p className="field-hint">{preset.note}</p>}
      <FormError message={error} />
      <div className="form-actions">
        <Button
          variant="primary"
          data-testid="llm-save"
          busy={working}
          aria-describedby={reason ? `${ids}-reason` : undefined}
          disabled={!ready || locked}
          onClick={() =>
            void run(() =>
              actions.saveLlm({
                kind: preset.kind,
                preset: preset.id,
                apiKey: needsKey ? apiKey.trim() : "",
                model: chosenModel.trim(),
                ...(preset.kind !== "anthropic" && url.trim()
                  ? { baseUrl: url.trim() }
                  : {}),
              }),
            )
          }
        >
          保存并启用
        </Button>
        {(llm.configured || llm.damaged) && (
          <Button
            variant="danger"
            data-testid="llm-remove"
            disabled={locked}
            onClick={() => void run(() => actions.removeLlm())}
          >
            移除
          </Button>
        )}
        {reason && (
          <p
            id={`${ids}-reason`}
            className="form-reason"
            data-testid="llm-save-reason"
          >
            {reason}
          </p>
        )}
      </div>
    </div>
  );
}

/* ---------------- 关于 ---------------- */

function AboutTab() {
  const { settings, library, platform, ui, actions } = useApp();
  const storage = library.storage;
  // 简单模式 reads the same facts without the words of the trade
  const simple = ui.mode === "simple";
  return (
    <div className="settings-pane about" data-testid="about">
      <div className="about-head">
        <LogoMark size={44} />
        <div>
          <p className="about-name">
            音序 <em>Muse</em>
          </p>
          <p className="muted" data-testid="about-version">
            v{settings.version || platform.version} ·{" "}
            {platform.isDesktop ? "Windows 桌面版" : "网页版"}
          </p>
        </div>
      </div>
      <dl className="facts">
        <div>
          <dt>{simple ? "怎么做音乐" : "本地作曲引擎"}</dt>
          <dd>
            {simple
              ? `在${platform.isDesktop ? "这台电脑" : "这个浏览器"}上作曲：${STYLES.length} 种风格、${INSTRUMENT_LIST.length} 种主奏乐器；48 kHz 立体声。`
              : `${STYLES.length} 种风格、${INSTRUMENT_LIST.length} 种主奏乐器、${KEYS.length} 个调；48 kHz 立体声，四条分轨。`}
          </dd>
        </div>
        <div>
          <dt>{simple ? "不用联网" : "离线"}</dt>
          <dd>
            {simple
              ? "不需要账号、显卡或下载模型；同样的设置总是得到同样的音乐。"
              : "本地作曲不联网，不需要账号、显卡或下载模型；同样的参数和种子总是得到同样的音乐。"}
          </dd>
        </div>
        <div>
          <dt>{simple ? "理解你的话" : "制作人"}</dt>
          <dd>
            {simple ? "默认用内置的方式。" : "默认使用内置的离线规则。"}
            {platform.isDesktop
              ? simple
                ? "可以在「制作人大模型」里接入你自己的大模型。"
                : "可以在「制作人大模型」里接入你自己的模型。"
              : "桌面版可以接入你自己的大模型。"}
          </dd>
        </div>
        {platform.isDesktop ? (
          <div data-testid="data-path">
            <dt>数据位置</dt>
            <dd className="about-path">
              {settings.dataPath || "应用用户目录"}
            </dd>
          </div>
        ) : (
          <div data-testid="storage-info">
            <dt>{simple ? "音乐存放" : "作品存放"}</dt>
            <dd>
              只保存在这个浏览器的本地存储里，清除网站数据会丢失。
              {storage && (
                <>
                  {" "}
                  已用 {formatBytes(storage.usage)}
                  {storage.quota ? ` / ${formatBytes(storage.quota)}` : ""}
                  {storage.persisted ? "，已申请持久保存" : ""}。
                </>
              )}
            </dd>
          </div>
        )}
      </dl>
      <div className="form-actions">
        {platform.isWeb && (
          <a
            className="btn btn-primary"
            href={platform.downloadUrl}
            target="_top"
            rel="noopener"
            data-testid="about-download"
          >
            <HardDrive size={15} aria-hidden />
            下载 Windows 桌面版
          </a>
        )}
        <Button onClick={() => actions.openModal("help")}>
          {simple ? "怎么用" : "使用指南"}
        </Button>
      </div>
    </div>
  );
}

export function SettingsModal() {
  const { ui, actions } = useApp();
  const tab = ui.settingsTab;
  const list = useRef<HTMLDivElement>(null);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = TABS.findIndex((item) => item.id === tab);
    const next = rovingIndex(event.key, current, TABS.length);
    if (next === null) return;
    event.preventDefault();
    actions.openModal("settings", TABS[next].id);
    list.current
      ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
      [next]?.focus();
  };
  return (
    <Modal
      size="lg"
      title="设置"
      icon={<Settings size={18} />}
      testId="settings-modal"
      onClose={actions.closeModal}
      toolbar={
        <div
          ref={list}
          className="tabs"
          role="tablist"
          aria-label="设置分类"
          onKeyDown={onKeyDown}
        >
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              id={`settings-tab-${item.id}`}
              className={classes("tab")}
              data-testid={`settings-tab-${item.id}`}
              aria-selected={tab === item.id}
              aria-controls="settings-panel"
              tabIndex={tab === item.id ? 0 : -1}
              onClick={() => actions.openModal("settings", item.id)}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </div>
      }
    >
      <div
        id="settings-panel"
        role="tabpanel"
        aria-labelledby={`settings-tab-${tab}`}
      >
        {tab === "general" && <GeneralTab />}
        {tab === "music" && <MusicTab />}
        {tab === "llm" && <LlmTab />}
        {tab === "about" && <AboutTab />}
      </div>
    </Modal>
  );
}
