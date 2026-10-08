// Run by tests/voices-core.test.ts in a child process with
// --experimental-test-module-mocks: replaces the bass group by an empty one
// and expects importing the voice bank to throw, naming the missing ids.
import test, { mock } from "node:test";
import assert from "node:assert/strict";

test("an incomplete voice bank throws at import time", async () => {
  mock.module("../../src/audio/voices/group-bass.ts", {
    namedExports: { BASS_VOICES: {}, BASS_CONTRACT: {} },
  });
  await assert.rejects(
    () => import("../../src/audio/voices/index.ts"),
    /voice bank is incomplete — missing: \[subBass, fingerBass, synthBass, uprightBass, chipBass, bass808\]/,
  );
});
