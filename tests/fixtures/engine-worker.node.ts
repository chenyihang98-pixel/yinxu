// Started by tests/engine.test.ts as a node:worker_threads worker: serves the
// engine's render-worker protocol on the parent port, so the facade can be
// tested across a real thread boundary (structured clone, transfer, terminate).
import { parentPort } from "node:worker_threads";
import { attachWorker } from "../../src/audio/worker";
import { TRACKS } from "../../src/music/score";
import type { WorkerScope } from "../../src/audio/worker";

const port = parentPort;
if (!port) throw new Error("engine-worker.node.ts must run as a worker thread");

const scope: WorkerScope = {
  postMessage: (message, transfer) => {
    port.postMessage(message, (transfer ?? []) as ArrayBuffer[]);
    // tell the test whether the stems really left this thread (a transferred buffer is detached here)
    if (message.type === "done")
      port.postMessage({
        type: "probe",
        transferred: transfer?.length ?? 0,
        detached: TRACKS.every((track) =>
          message.audio.stems[track].every(
            (channel) => channel.byteLength === 0,
          ),
        ),
      });
  },
  get onmessage(): WorkerScope["onmessage"] {
    return null;
  },
  set onmessage(handler) {
    if (handler) port.on("message", (data) => handler({ data }));
  },
};
attachWorker(scope);
