/**
 * 声音微调: a draft of the nine parameters. Nothing here is heard until
 * 应用调整 turns the draft into a new version (same seed, same melodic
 * material); 换一版旋律 keeps the settings and changes the seed.
 */
import { memo, useEffect, useId, useState } from "react";
import type { ReactNode } from "react";
import {
  ChevronDown,
  Dices,
  ListMusic,
  RotateCcw,
  SlidersHorizontal,
  WandSparkles,
} from "lucide-react";
import { keyLabel } from "../../agent/cloudPrompt";
import {
  INSTRUMENT_LIST,
  KEYS,
  LIMITS,
  STYLES,
  parseKey,
} from "../../music/catalog";
import type { InstrumentId, StyleId } from "../../music/catalog";
import { percent } from "../../state/format";
import { DURATION_CHOICES } from "../../state/plan";
import type { AppActions, Draft, DraftField } from "../../state/types";
import { useRenderCount } from "../hooks/useRenderCount";
import { Button, LinkButton, classes } from "../primitives/Button";
import { Segmented, Select, Slider } from "../primitives/Controls";

const TONICS = [...new Set(KEYS.map((key) => parseKey(key).name))];

/** The catalog key for a tonic and mode; enharmonic spelling when needed. */
function keyFor(tonic: string, minor: boolean): string | undefined {
  const wanted = `${tonic} ${minor ? "minor" : "major"}`;
  const pitch = parseKey(wanted).tonic;
  return (
    KEYS.find((item) => item === wanted) ??
    KEYS.find((item) => {
      const parsed = parseKey(item);
      return parsed.tonic === pitch && parsed.minor === minor;
    })
  );
}

/**
 * The tempo as a number you can type. Half-typed values ("9" on the way to
 * "96") stay in the field; the draft only takes values inside the range, and
 * leaving the field snaps to the nearest valid tempo.
 */
function BpmNumber(props: { value: number; onValue(value: number): void }) {
  const { value, onValue } = props;
  const [low, high] = LIMITS.bpm;
  const [text, setText] = useState(String(value));
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setText(String(value));
  }, [value, editing]);
  return (
    <input
      className="input insp-number"
      type="number"
      inputMode="numeric"
      data-testid="inspector-bpm-number"
      aria-label="速度（BPM）"
      min={low}
      max={high}
      value={text}
      onFocus={() => setEditing(true)}
      onChange={(event) => {
        setText(event.target.value);
        const next = Math.round(Number(event.target.value));
        if (event.target.value.trim() && next >= low && next <= high)
          onValue(next);
      }}
      onBlur={() => {
        setEditing(false);
        const typed = Math.round(Number(text));
        if (!text.trim() || !Number.isFinite(typed)) return;
        const next = Math.max(low, Math.min(high, typed));
        if (next !== value) onValue(next);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
      }}
    />
  );
}

function Row(props: {
  field: DraftField;
  label: string;
  /** current value, shown at the right of the label */
  value?: ReactNode;
  changed: boolean;
  controlId?: string;
  onReset(field: DraftField): void;
  children: ReactNode;
}) {
  const { field, label, changed } = props;
  return (
    <div className="insp-row" data-changed={changed || undefined}>
      <div className="insp-label">
        {props.controlId ? (
          <label htmlFor={props.controlId}>{label}</label>
        ) : (
          <span>{label}</span>
        )}
        {changed && (
          <>
            <span
              className="changed-dot"
              data-testid={`changed-${field}`}
              data-tip="已修改，尚未应用"
              role="img"
              aria-label="已修改"
            />
            <LinkButton
              className="insp-reset"
              data-testid={`reset-${field}`}
              aria-label={`还原${label}`}
              onClick={() => props.onReset(field)}
            >
              还原
            </LinkButton>
          </>
        )}
        {props.value !== undefined && (
          <output className="insp-value tabular">{props.value}</output>
        )}
      </div>
      {props.children}
    </div>
  );
}

export interface InspectorProps {
  draft: Draft;
  changedFields: readonly DraftField[];
  canApply: boolean;
  busy: boolean;
  /** the committed work was made by the v0.2 engine */
  legacy: boolean;
  /** the committed work is a cloud mix */
  cloud: boolean;
  notes: readonly string[];
  /** the panel is a collapsible card (below 1100 px) */
  collapsible: boolean;
  open: boolean;
  onToggle(): void;
  actions: AppActions;
}

export const Inspector = memo(function Inspector(props: InspectorProps) {
  useRenderCount("Inspector");
  const { draft, changedFields, busy, actions, collapsible, open } = props;
  const ids = useId();
  const id = (name: string) => `${ids}-${name}`;
  const changed = (field: DraftField) => changedFields.includes(field);
  const reset = (field: DraftField) => actions.resetDraft(field);
  const key = parseKey(draft.key);
  const setKey = (tonic: string, minor: boolean) => {
    const match = keyFor(tonic, minor);
    if (match) actions.setDraft("key", match);
  };
  const count = changedFields.length;
  const durations = [...new Set<number>([...DURATION_CHOICES, draft.duration])].sort(
    (a, b) => a - b,
  );

  const amount = (
    field: "energy" | "complexity" | "reverb",
    label: string,
    low: string,
    high: string,
  ) => (
    <Row
      field={field}
      label={label}
      value={percent(draft[field])}
      changed={changed(field)}
      controlId={id(field)}
      onReset={reset}
    >
      <Slider
        id={id(field)}
        data-testid={`inspector-${field}`}
        value={Math.round(draft[field] * 100)}
        valueText={percent(draft[field])}
        onValue={(value) => actions.setDraft(field, value / 100)}
      />
      <div className="insp-scale" aria-hidden>
        <span>{low}</span>
        <span>{high}</span>
      </div>
    </Row>
  );

  const body = (
    <div className="insp-body" id={id("body")}>
      {props.legacy && (
        <p className="notice notice-warn" data-testid="legacy-note">
          <WandSparkles size={16} aria-hidden />
          <span>
            这首作品由旧版引擎生成。应用调整或换一版旋律会用新版引擎生成新版本，原作品保留。
          </span>
        </p>
      )}
      {props.cloud && (
        <p className="notice" data-testid="cloud-note">
          <WandSparkles size={16} aria-hidden />
          <span>
            这是云端生成的作品。应用调整会按新的参数向当前选择的引擎重新生成，云端引擎可能计费。
          </span>
        </p>
      )}

      <Row
        field="mood"
        label="风格"
        changed={changed("mood")}
        controlId={id("mood")}
        onReset={reset}
      >
        <Select
          block
          id={id("mood")}
          data-testid="inspector-mood"
          value={draft.mood}
          onChange={(event) =>
            actions.setDraft("mood", event.target.value as StyleId)
          }
        >
          {STYLES.map((style) => (
            <option key={style.id} value={style.id}>
              {style.label}
            </option>
          ))}
        </Select>
      </Row>

      <Row
        field="bpm"
        label="速度"
        changed={changed("bpm")}
        controlId={id("bpm")}
        onReset={reset}
      >
        <div className="insp-bpm">
          <Slider
            id={id("bpm")}
            data-testid="inspector-bpm"
            min={LIMITS.bpm[0]}
            max={LIMITS.bpm[1]}
            value={draft.bpm}
            valueText={`${draft.bpm} BPM`}
            onValue={(value) => actions.setDraft("bpm", value)}
          />
          <BpmNumber
            value={draft.bpm}
            onValue={(value) => actions.setDraft("bpm", value)}
          />
          <span className="insp-unit" aria-hidden>
            BPM
          </span>
        </div>
      </Row>

      <Row
        field="instrument"
        label="主奏乐器"
        changed={changed("instrument")}
        controlId={id("instrument")}
        onReset={reset}
      >
        <Select
          block
          id={id("instrument")}
          data-testid="inspector-instrument"
          value={draft.instrument}
          onChange={(event) =>
            actions.setDraft("instrument", event.target.value as InstrumentId)
          }
        >
          {INSTRUMENT_LIST.map((instrument) => (
            <option key={instrument.id} value={instrument.id}>
              {instrument.label}
            </option>
          ))}
        </Select>
      </Row>

      <Row
        field="key"
        label="调性"
        value={keyLabel(draft.key)}
        changed={changed("key")}
        controlId={id("key")}
        onReset={reset}
      >
        <div className="insp-key">
          <Select
            id={id("key")}
            data-testid="inspector-key"
            aria-label="主音"
            value={key.name}
            onChange={(event) => setKey(event.target.value, key.minor)}
          >
            {TONICS.map((tonic) => (
              <option key={tonic} value={tonic}>
                {tonic}
              </option>
            ))}
          </Select>
          <Segmented
            block
            label="大小调"
            testId="inspector-key-mode"
            value={key.minor ? "minor" : "major"}
            options={[
              { value: "major", label: "大调", testId: "inspector-key-major" },
              { value: "minor", label: "小调", testId: "inspector-key-minor" },
            ]}
            onChange={(mode) => setKey(key.name, mode === "minor")}
          />
        </div>
      </Row>

      {amount("energy", "情绪能量", "舒缓", "激昂")}
      {amount("complexity", "旋律丰富度", "简洁", "华丽")}
      {amount("reverb", "空间混响", "贴近", "空旷")}

      <Row
        field="duration"
        label="时长"
        changed={changed("duration")}
        controlId={id("duration")}
        onReset={reset}
      >
        <Select
          block
          id={id("duration")}
          data-testid="inspector-duration"
          value={draft.duration}
          onChange={(event) =>
            actions.setDraft("duration", Number(event.target.value))
          }
        >
          {durations.map((seconds) => (
            <option key={seconds} value={seconds}>
              {seconds} 秒
            </option>
          ))}
        </Select>
      </Row>

      <Row field="loop" label="结构" changed={changed("loop")} onReset={reset}>
        <Segmented
          block
          label="结构"
          testId="inspector-loop"
          value={draft.loop ? "loop" : "ending"}
          options={[
            { value: "loop", label: "循环片段", testId: "inspector-loop-loop" },
            {
              value: "ending",
              label: "完整结尾",
              testId: "inspector-loop-ending",
            },
          ]}
          onChange={(value) => actions.setDraft("loop", value === "loop")}
        />
      </Row>

      <div className="insp-actions">
        <Button
          variant="primary"
          block
          data-testid="apply-draft"
          icon={<WandSparkles size={15} aria-hidden />}
          disabled={!props.canApply || busy}
          onClick={() => void actions.applyDraft()}
        >
          {count === 0 && props.canApply
            ? "用新版引擎重做"
            : `应用调整（${count} 项）`}
        </Button>
        <div className="insp-actions-row">
          <Button
            block
            data-testid="new-melody"
            icon={<Dices size={15} aria-hidden />}
            data-tip="保持这些设置，换一组新的旋律"
            disabled={busy}
            onClick={() => void actions.variation()}
          >
            换一版旋律
          </Button>
          <Button
            variant="ghost"
            data-testid="reset-draft"
            icon={<RotateCcw size={14} aria-hidden />}
            disabled={count === 0}
            onClick={() => actions.resetDraft()}
          >
            全部还原
          </Button>
        </div>
        <p className="insp-hint">
          应用调整保留旋律素材并生成新版本，之前的版本仍在作品库中。
        </p>
      </div>

      {props.notes.length > 0 && (
        <section className="insp-notes" aria-labelledby={id("notes")}>
          <h3 id={id("notes")}>
            <ListMusic size={15} aria-hidden />
            编曲思路
          </h3>
          <ul data-testid="arrangement-notes">
            {props.notes.map((note, index) => (
              <li key={index}>{note}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );

  return (
    <aside
      className={classes("inspector", collapsible && "card inspector-card")}
      aria-labelledby={id("title")}
      data-testid="inspector"
      data-open={open}
    >
      <div className="insp-head">
        {collapsible ? (
          <h2 id={id("title")} className="insp-title">
            <button
              type="button"
              className="insp-toggle"
              data-testid="inspector-toggle"
              aria-expanded={open}
              aria-controls={id("body")}
              onClick={props.onToggle}
            >
              <SlidersHorizontal size={16} aria-hidden />
              <span>声音微调</span>
              {count > 0 && (
                <span className="badge badge-accent">{count} 项待应用</span>
              )}
              <span className="grow" />
              <ChevronDown className="insp-chevron" size={18} aria-hidden />
            </button>
          </h2>
        ) : (
          <>
            <h2 id={id("title")} className="insp-title">
              <SlidersHorizontal size={16} aria-hidden />
              声音微调
            </h2>
            {count > 0 && (
              <span className="badge badge-accent">{count} 项待应用</span>
            )}
          </>
        )}
      </div>
      {(!collapsible || open) && body}
    </aside>
  );
});
