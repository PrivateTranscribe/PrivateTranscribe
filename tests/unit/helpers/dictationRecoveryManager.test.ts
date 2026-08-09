import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const DictationRecoveryManager = require("../../../src/helpers/dictationRecoveryManager");

const createdDirs: string[] = [];

afterEach(() => {
  for (const dir of createdDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("DictationRecoveryManager", () => {
  test("keeps staged audio locally when transcription fails", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "private-transcribe-recovery-test-"));
    createdDirs.push(root);
    const manager = new DictationRecoveryManager({
      baseDir: root,
      idFactory: () => "dictation-1",
      now: () => new Date("2026-08-09T12:00:00.000Z"),
    });

    const staged = manager.stage(Buffer.from("private audio"), {
      mimeType: "audio/webm",
      durationSeconds: 4.25,
    });
    manager.markFailed(staged.id, "Local model stopped unexpectedly");

    const [recovery] = manager.list();
    expect(recovery).toMatchObject({
      id: "dictation-1",
      status: "failed",
      mimeType: "audio/webm",
      durationSeconds: 4.25,
      reason: "Local model stopped unexpectedly",
    });
    expect(fs.readFileSync(manager.getAudioPath(recovery.id)).toString()).toBe("private audio");
  });

  test("marks a staged entry as interrupted after an app restart", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "private-transcribe-recovery-test-"));
    createdDirs.push(root);
    const first = new DictationRecoveryManager({
      baseDir: root,
      idFactory: () => "interrupted-1",
      now: () => new Date("2026-08-09T12:00:00.000Z"),
    });
    first.stage(Buffer.from("audio before crash"));

    const restarted = new DictationRecoveryManager({
      baseDir: root,
      now: () => new Date("2026-08-09T12:05:00.000Z"),
    });
    restarted.recoverInterrupted();

    expect(restarted.list()[0]).toMatchObject({
      id: "interrupted-1",
      status: "interrupted",
      reason: "PrivateTranscribe closed before this dictation completed",
    });
  });

  test("clears all local recovery audio when retention is disabled", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "private-transcribe-recovery-test-"));
    createdDirs.push(root);
    let id = 0;
    const manager = new DictationRecoveryManager({
      baseDir: root,
      idFactory: () => `private-${++id}`,
    });
    manager.stage(Buffer.from("first"));
    manager.stage(Buffer.from("second"));

    expect(manager.clear()).toEqual({ success: true, cleared: 2 });
    expect(manager.list()).toEqual([]);
  });

  test("rejects tampered metadata that points at another local file", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "private-transcribe-recovery-test-"));
    createdDirs.push(root);
    const manager = new DictationRecoveryManager({
      baseDir: root,
      idFactory: () => "dictation-safe",
    });
    manager.stage(Buffer.from("private audio"));
    fs.writeFileSync(path.join(root, "unrelated.webm"), "unrelated");
    const metadataPath = path.join(root, "dictation-safe.json");
    const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
    fs.writeFileSync(
      metadataPath,
      JSON.stringify({ ...metadata, audioFile: "unrelated.webm" }),
      "utf8"
    );

    expect(() => manager.getAudioPath("dictation-safe")).toThrow("Invalid recovery metadata");
    expect(manager.list()).toEqual([]);
  });

  test("never prunes a pending recording that is still being processed", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "private-transcribe-recovery-test-"));
    createdDirs.push(root);
    let id = 0;
    const manager = new DictationRecoveryManager({
      baseDir: root,
      idFactory: () => `pending-${++id}`,
      maxEntries: 10,
    });

    for (let index = 0; index < 11; index += 1) {
      manager.stage(Buffer.from(`chunk-${index}`));
    }

    expect(manager.list()).toHaveLength(11);
    expect(manager.list().every((entry: { status: string }) => entry.status === "pending")).toBe(
      true
    );
  });

  test("prunes finalized recoveries back to the configured retention bound", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "private-transcribe-recovery-test-"));
    createdDirs.push(root);
    let id = 0;
    const manager = new DictationRecoveryManager({
      baseDir: root,
      idFactory: () => `finalized-${++id}`,
      maxEntries: 10,
    });
    const entries = Array.from({ length: 11 }, (_, index) =>
      manager.stage(Buffer.from(`chunk-${index}`))
    );

    for (const entry of entries) {
      manager.markFailed(entry.id, "transcription failed");
    }

    expect(manager.list()).toHaveLength(10);
    expect(manager.list().every((entry: { status: string }) => entry.status === "failed")).toBe(
      true
    );
  });

  test("rejects a recovery root that is a symbolic link or junction", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "private-transcribe-recovery-test-"));
    createdDirs.push(root);
    const linkedRoot = path.join(root, "linked-vault");
    const fsModule = {
      ...fs,
      lstatSync: (target: fs.PathLike) => {
        if (path.resolve(String(target)) === path.resolve(linkedRoot)) {
          return {
            isDirectory: () => true,
            isFile: () => false,
            isSymbolicLink: () => true,
          };
        }
        return fs.lstatSync(target);
      },
    };
    const manager = new DictationRecoveryManager({ baseDir: linkedRoot, fsModule });

    expect(() => manager.stage(Buffer.from("private audio"))).toThrow(
      "Recovery directory must not be a symbolic link or junction"
    );
  });
});
