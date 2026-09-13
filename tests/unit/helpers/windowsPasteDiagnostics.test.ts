import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

const { WindowsPasteDiagnostics } = require("../../../src/helpers/windowsPasteDiagnostics");
const directories: string[] = [];
async function setup() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pt-paste-log-"));
  directories.push(directory);
  return { directory, log: new WindowsPasteDiagnostics(() => directory) };
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))
  );
});

describe("local Windows paste diagnostics", () => {
  test("persists only allowed metadata, never raw text or errors", async () => {
    const { directory, log } = await setup();
    await log.record({
      outcome: "timeout",
      stage: "dispatched",
      dispatched: true,
      elapsedMs: 2500,
      text: "PRIVATE",
      stderr: "PRIVATE",
      processName: "PRIVATE",
      evidence: "PRIVATE",
      heldModifierCount: 99,
      targetChanged: true,
    });
    const raw = await fs.readFile(path.join(directory, "windows-paste.jsonl"), "utf8");
    expect(raw).not.toContain("PRIVATE");
    expect(JSON.parse(raw)).toEqual({
      time: expect.any(String),
      outcome: "timeout",
      stage: "dispatched",
      elapsedMs: 2500,
      exitCode: null,
      dispatched: true,
      evidence: "none",
      isTerminal: null,
      targetChanged: true,
      heldModifierCount: 8,
    });
  });

  test("rotates the log and retains only one previous file", async () => {
    const { directory, log } = await setup();
    const file = path.join(directory, "windows-paste.jsonl");
    await fs.writeFile(file + ".previous", "old");
    await fs.writeFile(file, "x".repeat(64 * 1024));
    await log.record({ outcome: "confirmed" });
    expect((await fs.stat(file)).size).toBeLessThan(1024);
    expect((await fs.stat(file + ".previous")).size).toBe(64 * 1024);
    expect(await fs.readdir(directory)).toHaveLength(2);
  });

  test("directory failures do not escape or poison subsequent writes", async () => {
    const { directory } = await setup();
    let unavailable = true;
    const log = new WindowsPasteDiagnostics(() => {
      if (unavailable) throw new Error("unavailable");
      return directory;
    });
    await expect(log.record({ outcome: "timeout" })).resolves.toBeUndefined();
    unavailable = false;
    await log.record({ outcome: "confirmed" });
    expect(
      JSON.parse(await fs.readFile(path.join(directory, "windows-paste.jsonl"), "utf8")).outcome
    ).toBe("confirmed");
  });

  test("bounds queued writes and serializes records", async () => {
    const { directory, log } = await setup();
    for (let i = 0; i < 100; i++) log.record({ outcome: "confirmed" });
    await log.pending;
    const lines = (await fs.readFile(path.join(directory, "windows-paste.jsonl"), "utf8"))
      .trim()
      .split("\n");
    expect(lines).toHaveLength(32);
    expect(lines.every((line) => JSON.parse(line).outcome === "confirmed")).toBe(true);
    expect(log.queued).toBe(0);
  });
});
