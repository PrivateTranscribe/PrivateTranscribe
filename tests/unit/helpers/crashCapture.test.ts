import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { collectPreviousCrashes, MAX_RETAINED_DUMPS } = require("../../../src/helpers/crashCapture");

/**
 * The 2026-08-30 crash left a Windows bucket ID and nothing else — the minidump
 * went to WER's temp directory and was purged before anyone looked. These cover
 * the part that has to keep working for the next one to be diagnosable: dumps
 * are found and reported, and the folder does not grow without bound.
 */

const made: string[] = [];

function makeDumpDir(count: number, prefix = "crash") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pt-crash-"));
  made.push(root);
  const reports = path.join(root, "reports");
  fs.mkdirSync(reports, { recursive: true });

  for (let i = 0; i < count; i += 1) {
    const file = path.join(reports, `${prefix}-${i}.dmp`);
    fs.writeFileSync(file, `dump ${i}`);
    // Oldest first, so "newest kept" is unambiguous.
    const when = new Date(Date.now() - (count - i) * 60_000);
    fs.utimesSync(file, when, when);
  }
  return root;
}

afterEach(() => {
  for (const dir of made.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("crash dump collection", () => {
  it("reports nothing when the app has never crashed", () => {
    const root = makeDumpDir(0);
    const result = collectPreviousCrashes({ directory: path.join(root, "reports") });
    expect(result.dumps).toEqual([]);
    expect(result.pruned).toBe(0);
  });

  it("reports the dumps a previous session left behind, newest first", () => {
    const root = makeDumpDir(3);
    const result = collectPreviousCrashes({ directory: path.join(root, "reports") });

    expect(result.dumps).toHaveLength(3);
    expect(result.dumps[0].name).toBe("crash-2.dmp");
    expect(result.dumps[2].name).toBe("crash-0.dmp");
    expect(result.dumps[0].bytes).toBeGreaterThan(0);
  });

  it("prunes the backlog so minidumps cannot fill the disk", () => {
    const root = makeDumpDir(MAX_RETAINED_DUMPS + 4);
    const reports = path.join(root, "reports");

    const result = collectPreviousCrashes({ directory: reports });

    expect(result.pruned).toBe(4);
    expect(result.dumps).toHaveLength(MAX_RETAINED_DUMPS);
    expect(fs.readdirSync(reports)).toHaveLength(MAX_RETAINED_DUMPS);
    // The ones kept are the newest, which are the ones worth reading.
    expect(result.dumps[0].name).toBe(`crash-${MAX_RETAINED_DUMPS + 3}.dmp`);
  });

  it("ignores files that are not dumps", () => {
    const root = makeDumpDir(1);
    const reports = path.join(root, "reports");
    fs.writeFileSync(path.join(reports, "settings.dat"), "not a dump");
    fs.writeFileSync(path.join(reports, "notes.txt"), "also not a dump");

    const result = collectPreviousCrashes({ directory: reports });
    expect(result.dumps.map((d: { name: string }) => d.name)).toEqual(["crash-0.dmp"]);
  });

  it("survives a directory that does not exist", () => {
    const result = collectPreviousCrashes({ directory: path.join(os.tmpdir(), "pt-nope-12345") });
    expect(result.dumps).toEqual([]);
    expect(result.pruned).toBe(0);
  });
});
