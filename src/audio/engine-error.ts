/**
 * What a failed local render is rejected with.
 *
 * `message` is for the user: Simplified Chinese, and never the text of an
 * exception. `code` is for programs. `detail` keeps the original exception
 * text for logs and tests; it must not be shown.
 *
 * A cancelled render is not a failure: it rejects with an AbortError, as ever.
 */

export type EngineErrorCode =
  /** an exception inside the composer or the synthesizer */
  | "engine-failed"
  /** the render worker died in the middle of a job */
  | "engine-crashed"
  /** a buffer could not be allocated: the piece is too long for the memory at hand */
  | "out-of-memory";

export const ENGINE_ERROR_TEXT: Record<EngineErrorCode, string> = {
  "engine-failed":
    "本地作曲引擎出错，请重试；如果反复出现，请导出工程文件并反馈。",
  "engine-crashed":
    "本地作曲引擎意外中断，请重试；如果反复出现，请导出工程文件并反馈。",
  "out-of-memory":
    "内存不足，无法生成这么长的音乐。请缩短时长或关闭其他页面后重试。",
};

export class EngineError extends Error {
  readonly code: EngineErrorCode;
  /** the original exception text ("TypeError: …"); for logs and tests, never for the user */
  readonly detail: string;

  constructor(code: EngineErrorCode, detail = "") {
    // (a code this build does not know — a message from elsewhere — is a plain failure)
    const known = Object.prototype.hasOwnProperty.call(ENGINE_ERROR_TEXT, code)
      ? code
      : "engine-failed";
    super(ENGINE_ERROR_TEXT[known]);
    this.name = "EngineError";
    this.code = known;
    this.detail = typeof detail === "string" ? detail : "";
  }
}

/** What runtimes say when memory runs out (V8, SpiderMonkey, JavaScriptCore; thrown or as a worker's last word). */
const OUT_OF_MEMORY =
  /allocation failed|out of memory|invalid (?:typed )?array(?: buffer)? length|array buffer allocation|allocation size overflow/i;

/** The original text of whatever was thrown, on one line. */
function detailOf(error: unknown): string {
  if (error instanceof Error) {
    const name = error.name || "Error";
    return error.message ? `${name}: ${error.message}` : name;
  }
  if (typeof error === "string") return error;
  try {
    return String(error);
  } catch {
    return "unknown error";
  }
}

/**
 * Code and detail for something thrown inside the engine. `fallback` is the
 * code of a failure that is not about memory.
 */
export function describeFailure(
  error: unknown,
  fallback: Exclude<EngineErrorCode, "out-of-memory"> = "engine-failed",
): { code: EngineErrorCode; detail: string } {
  const detail = detailOf(error).replace(/\s+/g, " ").slice(0, 500);
  return {
    code: OUT_OF_MEMORY.test(detail) ? "out-of-memory" : fallback,
    detail,
  };
}

export function isAbortError(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

/** The rejection for anything thrown inside the engine: aborts and EngineErrors pass, the rest is wrapped. */
export function engineFailure(
  error: unknown,
  fallback: Exclude<EngineErrorCode, "out-of-memory"> = "engine-failed",
): unknown {
  if (error instanceof EngineError || isAbortError(error)) return error;
  const { code, detail } = describeFailure(error, fallback);
  return new EngineError(code, detail);
}
