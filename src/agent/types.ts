/**
 * Producer-agent contract. A "brain" turns one user message (plus the current
 * piece) into an AgentPlan. Two brains exist:
 *  - rules: offline lexicon/intent parser (always available, also on the web)
 *  - llm:   the user's own large language model, called from the desktop main
 *           process (never from the renderer; the renderer has connect-src 'none')
 */
import type { MusicConfig, Provider } from "../types";

export type BrainKind = "rules" | "llm";

export interface AgentTurn {
  id: string;
  role: "user" | "agent";
  text: string;
  /** ISO timestamp */
  at: string;
  /** agent turns: what was understood / changed */
  reasoning?: string[];
  brain?: BrainKind;
  /** agent turns: revision number of the work this turn produced */
  revision?: number;
  /** agent turns that report a failure */
  error?: boolean;
}

export interface AgentRequest {
  /** the user's message (≤ 1500 chars) */
  text: string;
  /** "new": start a piece from a description; "refine": adjust the current piece */
  mode: "new" | "refine";
  /** current audible configuration when refining, else the draft parameters */
  current: MusicConfig;
  /** target engine; cloud providers also need `cloudPrompt` */
  provider: Provider;
  history: AgentTurn[];
  /** title of the current work; kept as-is when refining */
  title?: string;
  /**
   * A fresh seed supplied by the caller. The brain uses it when mode is "new"
   * or when the user asks for a different melody; otherwise `current.seed` is
   * kept so a refinement keeps the same musical material.
   */
  nextSeed: number;
  /**
   * Choices the user made explicitly in the UI for this message (a style chip,
   * a duration, the loop switch…). Pinned values always win over what the
   * brain infers from the text; a pinned style also replaces style detection.
   */
  pins?: Partial<
    Pick<
      MusicConfig,
      "mood" | "instrument" | "key" | "bpm" | "duration" | "loop"
    >
  >;
}

export interface AgentPlan {
  /** complete, sanitised next configuration */
  config: MusicConfig;
  title: string;
  /** one or two friendly sentences for the chat thread */
  reply: string;
  reasoning: string[];
  tags: string[];
  /** true when nothing audible would change (the request was not understood) */
  unchanged: boolean;
  /** prompt for a cloud music model; always present when provider !== "local" */
  cloudPrompt?: string;
  brain: BrainKind;
  /** llm brain: the model id that answered */
  model?: string;
  /** set when the LLM failed and the offline rules produced this plan instead */
  fallbackReason?: string;
}

/* ---------- desktop LLM bridge (window.museDesktop) ---------- */

/**
 * anthropic: Claude via the official SDK.
 * openai:    any OpenAI-compatible chat/completions endpoint over public HTTPS.
 * ollama:    a model served by Ollama on this computer (loopback only, no key).
 */
export type LlmKind = "anthropic" | "openai" | "ollama";

/** Non-secret status returned by getSettings(); the key itself is never returned. */
export interface LlmStatus {
  configured: boolean;
  /** stored but unreadable: ask the user to save the settings again */
  damaged?: boolean;
  kind?: LlmKind;
  /** preset id from LLM_PRESETS, or "custom" */
  preset?: string;
  model?: string;
  /** only for kind "openai" */
  baseUrl?: string;
}

export interface LlmSettingsInput {
  kind: LlmKind;
  preset: string;
  apiKey: string;
  model: string;
  /**
   * kind "openai": required, public https://… endpoint (http is refused).
   * kind "ollama": optional, http on this computer only (127.0.0.1 / localhost).
   */
  baseUrl?: string;
}

/** What the renderer sends to the main process. Sizes are enforced on both sides. */
export interface AgentPlanInput {
  mode: "new" | "refine";
  request: string;
  provider: Provider;
  history: { role: "user" | "agent"; text: string }[];
  /** the current configuration without the free-text prompt */
  current: {
    style: string;
    instrument: string;
    key: string;
    bpm: number;
    duration: number;
    energy: number;
    complexity: number;
    reverb: number;
    loop: boolean;
    volumes: Record<"melody" | "chords" | "bass" | "drums", number>;
    /** refine mode: the arrangement in use, so the model keeps what it is not asked to change */
    arrangement?: RawAgentPlan["arrangement"];
  };
}

export type LayerChoice = boolean | "auto";

/**
 * The JSON object the model must produce (schema built in
 * electron/agent/plan-schema.cjs from the shared catalog). The main process
 * validates types and enums; the renderer clamps every number again before use.
 */
export interface RawAgentPlan {
  reply: string;
  title: string;
  style: string;
  instrument: string;
  key: string;
  bpm: number;
  duration: number;
  energy: number;
  complexity: number;
  reverb: number;
  loop: boolean;
  /** true when the user asked for a different melody / another take */
  newMelody: boolean;
  volumes: { melody: number; chords: number; bass: number; drums: number };
  arrangement: {
    /** roman numerals, one per bar, cycled; [] = let the composer choose */
    progression: string[];
    /** [] = let the composer choose */
    form: { type: string; bars: number; energy: number }[];
    drums: string;
    bass: string;
    /** 0..0.66; -1 = style default */
    swing: number;
    /** "auto" = let the style decide (the default); true / false force the layer on / off */
    layers: {
      pad: LayerChoice;
      arp: LayerChoice;
      counter: LayerChoice;
      perc: LayerChoice;
    };
    melody: {
      /** 0..1; -1 = style default */
      density: number;
      register: "low" | "mid" | "high" | "auto";
      motion: "stepwise" | "leaps" | "arpeggio" | "auto";
    };
  };
  reasoning: string[];
  /** description for a text-to-music model: genre, mood, instruments, tempo, "instrumental, no vocals" */
  cloudPrompt: string;
}

export interface AgentPlanOutput {
  plan: RawAgentPlan;
  /** model id that answered, for display */
  model: string;
}
