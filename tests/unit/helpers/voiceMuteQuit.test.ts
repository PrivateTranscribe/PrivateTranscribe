import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Quitting, updating or restarting mid-dictation must let go of the call's
 * mute key through the muter. The helper would let go on its own when its
 * stdin closes, but the held-key marker is only deleted by a release the muter
 * sees, so without this the next start sent a key-up nobody needed.
 *
 * main.js cannot be loaded in a unit test, so this reads its quit handler.
 */
describe("quitting the app", () => {
  it("releases the voice-call mute with the other child processes", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "..", "..", "main.js"), "utf8");
    const start = source.indexOf('app.on("before-quit", (event) => {');
    expect(start).toBeGreaterThan(-1);
    const handler = source.slice(start, source.indexOf("Promise.allSettled(stopAll)", start));
    const stopAll = handler.slice(handler.indexOf("const stopAll = ["));

    expect(stopAll).toContain("voiceMuter.release()");
  });
});
