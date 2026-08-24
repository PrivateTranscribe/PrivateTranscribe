/**
 * Repro tests for docs/TRANSCRIBE_AUDIT.md — the UI-surface findings from
 * driving the real Transcribe page.
 *
 * These read the shipped source rather than rendering it, matching the other
 * component tests in this directory (the vitest environment is "node"). Each
 * one pins an affordance the page does not have; `it.fails` marks a CONFIRMED
 * bug that is not fixed, so the suite stays green while the gap stays
 * documented. When one starts failing, the gap is closed — drop the `.fails`,
 * not the assertion.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (...segments: string[]) =>
  fs.readFileSync(path.join(process.cwd(), ...segments), "utf8");

const transcribePage = () => read("src", "components", "pages", "TranscribePage.tsx");
const preload = () => read("preload.js");
const ipcHandlers = () => read("src", "helpers", "ipcHandlers.js");

/** The JSX branch the page renders while a file is being transcribed. */
function processingBranch(source: string): string {
  const start = source.indexOf('{status === "processing" ? (');
  const end = source.indexOf(') : status === "error" ? (', start);
  if (start < 0 || end < 0) throw new Error("Could not locate the processing branch");
  return source.slice(start, end);
}

/** The JSX branch the page renders after a transcription fails. */
function errorBranch(source: string): string {
  const start = source.indexOf(') : status === "error" ? (');
  const end = source.indexOf(') : status === "success" ? (', start);
  if (start < 0 || end < 0) throw new Error("Could not locate the error branch");
  return source.slice(start, end);
}

describe("F1 — a running file transcription cannot be stopped", () => {
  /**
   * Observed by driving the page: once a file is dropped the dropzone turns
   * cursor-wait, every click handler returns early on status === "processing",
   * and the only thing that moves is an elapsed-time counter. There is no stop
   * control, and no IPC channel behind one either — the pipeline threads no
   * AbortSignal from the renderer to whisper-server.
   *
   * Force-quitting the app is the only exit, and it costs the whole transcript.
   * (Measured separately: a force-quit at chunk 11 of 33 left zero orphaned
   * whisper-server processes and zero temp files, so quitting is at least
   * clean — see F12.)
   *
   * Blocking question for the fix: cancellation has to reach an in-flight
   * http.request inside a chunk loop in the main process, which means a
   * request-scoped id, a cancel channel, and an abort check between chunks.
   * That is a feature, not a patch.
   */
  it("confirms the processing view offers nothing but a spinner and a clock", () => {
    const branch = processingBranch(transcribePage());

    expect(branch).toContain("Transcribing…");
    expect(branch).toContain("elapsedLabel");
    expect(branch).not.toContain("<Button");
  });

  it.fails("exposes a cancel control while a file is transcribing", () => {
    const branch = processingBranch(transcribePage());

    expect(branch).toMatch(/Cancel|Stop/);
  });

  it.fails("exposes an IPC channel that can cancel a running file transcription", () => {
    expect(preload()).toMatch(/cancelFileTranscription|cancel-file-transcription/);
    expect(ipcHandlers()).toMatch(/cancel-file-transcription/);
  });
});

describe("F7 — the missing-model error offers the wrong way out", () => {
  /**
   * Observed by driving the real pipeline against an empty home directory:
   *
   *   Whisper model "base" not downloaded. Please download it from Settings.
   *
   * That message reaches the page unchanged and is shown under a heading of
   * "Transcription failed", with a single button: "Try another file". Another
   * file cannot help — no file will transcribe until the model is on disk. The
   * page's own Settings panel has Language, Noise reduction and Speaker
   * labels, and no model picker, so following the message's advice inside this
   * page leads nowhere either.
   */
  it("confirms the only offered recovery is to pick a different file", () => {
    const branch = errorBranch(transcribePage());

    expect(branch).toContain("Transcription failed");
    expect(branch).toContain("Try another file");
  });

  it.fails("offers a way to get the missing model when that is what failed", () => {
    const branch = errorBranch(transcribePage());

    expect(branch).toMatch(/model/i);
  });
});

describe("F8 — speaker labels that find nothing still claim one speaker", () => {
  /**
   * Observed on the committed 3-speaker fixture with speaker labels on and the
   * tinydiarize model actually loaded (whisper-server's own startup line
   * confirmed `tdrz = 1`, and 29 realtime segment lines were captured): zero
   * [SPEAKER_TURN] markers came back, so the transcript carried one speaker,
   * "Speaker 1", for a 17-utterance interview between three people.
   *
   * The pipeline does report `speakerDetectionActive: true` alongside
   * `speakerCount: 1`, so the two cases ARE distinguishable — the page just
   * never looks. It reads speakerCount, and renders a confident "1 speaker"
   * badge over audio that has three.
   *
   * Blocking question for the fix: whether tinydiarize finds no turns in this
   * fixture specifically (it is TTS-generated, and synthetic voices may not
   * cue the model) or in general is the subject of the transcribe-speaker-turns
   * gate. What the page should show when detection runs and finds nothing is a
   * product decision either way.
   */
  it("confirms the page reads speakerCount and ignores speakerDetectionActive", () => {
    const source = transcribePage();

    expect(source).toContain("setSpeakerCount(Number(result?.speakerCount) || 0)");
    expect(source).not.toContain("speakerDetectionActive");
  });

  it.fails("warns when speaker detection ran but produced no speaker turns", () => {
    expect(transcribePage()).toContain("speakerDetectionActive");
  });
});
