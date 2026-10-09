/**
 * Giving sample memory back without waiting for a garbage collection.
 *
 * A render worker that has finished its job sits idle: nothing allocates, so
 * no collection runs, and every buffer the job left behind — garbage or not —
 * stays resident until the next render. Buffers of a megabyte and more are
 * therefore released by hand the moment they are no longer needed.
 */

export type SampleArray = Float32Array | Float64Array | Int32Array;

/**
 * Detach `array` and free its memory immediately (ArrayBuffer.transfer, where
 * the runtime has it; otherwise the collector gets to it in its own time).
 * The array must not be used afterwards: it has length 0.
 */
export function freeBuffer(array: SampleArray | null | undefined): void {
  if (!array) return;
  const buffer = array.buffer as ArrayBuffer & {
    transfer?: (length?: number) => ArrayBuffer;
  };
  try {
    if (typeof buffer.transfer === "function" && buffer.byteLength > 0)
      buffer.transfer(0);
  } catch {
    // a buffer that cannot be detached is simply left to the collector
  }
}

/**
 * Bytes of sample memory held at one time: what is held now and the most that
 * was ever held together. Counting is by hand (add when a buffer is made,
 * drop when it is freed) because no runtime reports it portably.
 */
export class MemoryLedger {
  /** bytes held right now */
  held = 0;
  /** the most `held` plus the `extra` of a sample() has been */
  peak = 0;

  add(bytes: number): void {
    this.held += bytes;
    if (this.held > this.peak) this.peak = this.held;
  }

  drop(bytes: number): void {
    this.held -= bytes;
  }

  /** Note a moment at which `extra` bytes are held elsewhere on top of this ledger's own. */
  sample(extra: number): void {
    if (this.held + extra > this.peak) this.peak = this.held + extra;
  }
}
