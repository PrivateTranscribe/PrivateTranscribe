/**
 * Repro tests for docs/TRANSCRIBE_AUDIT.md — the pipeline-layer findings from
 * driving the real file-transcription feature (WhisperManager.transcribeFileV2
 * plus formatTranscript, which together are the body of the "transcribe-file-v2"
 * IPC handler).
 *
 * Tests marked `it.fails` document a CONFIRMED bug that is NOT fixed: they
 * assert the behaviour a user should get, and pass for as long as the app does
 * not deliver it. When one of them starts failing, the bug is fixed and the
 * `.fails` should be dropped — not the assertion.
 *
 * Each finding id below matches a row in the audit's summary table.
 */
import { tmpdir } from "os";
import { describe, expect, it, vi } from "vitest";
import http from "http";
import WhisperServerManager from "../../../src/helpers/whisperServer";
import { formatTranscript } from "../../../src/helpers/transcriptFormatter";
import { resolveTranscriptionLanguage } from "../../../src/utils/languageCompat";
import { buildLanguageMismatchNotice } from "../../../src/utils/languageMismatch";
import { LANGUAGE_OPTIONS } from "../../../src/utils/languages";

vi.mock("electron", () => ({
  app: { getPath: () => tmpdir(), isReady: () => false },
}));

const WhisperManager = require("../../../src/helpers/whisper");

/** A silent 16 kHz mono PCM16 WAV of the requested length, header included. */
function makeWav(seconds: number): Buffer {
  const sampleRate = 16000;
  const channels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const pcmBytes = Math.floor((byteRate * seconds) / blockAlign) * blockAlign;

  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcmBytes, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcmBytes, 40);

  return Buffer.concat([header, Buffer.alloc(pcmBytes)]);
}

/** Parse an SRT string into cue start/end seconds, in file order. */
function parseSrtCues(srt: string): { index: number; start: number; end: number }[] {
  return srt
    .split(/\n\n/)
    .map((block) => {
      const lines = block.split("\n");
      const match = (lines[1] || "").match(
        /(\d+):(\d+):(\d+),(\d+) --> (\d+):(\d+):(\d+),(\d+)/
      );
      if (!match) return null;
      const toSeconds = (h: string, m: string, s: string, ms: string) =>
        Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;
      return {
        index: Number(lines[0]),
        start: toSeconds(match[1], match[2], match[3], match[4]),
        end: toSeconds(match[5], match[6], match[7], match[8]),
      };
    })
    .filter((cue): cue is { index: number; start: number; end: number } => cue !== null);
}

describe("F2 — default Transcribe output keeps one timestamp per segment (FIXED)", () => {
  /**
   * The Transcribe page sends outputFormat "timestamped" whenever speaker
   * labels are off, and the IPC handler pairs it with includeSpeakers:false.
   * Turns are merged by speaker, and with labels off every segment carries the
   * same placeholder speaker — so before the fix the whole file folded into one
   * turn and came back as a single line stamped [00:00:00].
   *
   * Observed before the fix on the real 32:04 fixture: 657 segments, 5193
   * words, ONE line.
   */
  it("stamps every segment instead of collapsing the file into one line", () => {
    const verboseJson = {
      segments: [
        { start: 0, end: 4, text: "First sentence here." },
        { start: 4, end: 9, text: "Second sentence here." },
        { start: 9, end: 15, text: "Third sentence here." },
      ],
    };

    const result = formatTranscript(verboseJson, "timestamped", { includeSpeakers: false });
    const lines = result.text.split("\n");

    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("[00:00:00] First sentence here.");
    expect(lines[1]).toBe("[00:00:04] Second sentence here.");
    expect(lines[2]).toBe("[00:00:09] Third sentence here.");
  });

  it("still merges by speaker when speaker labels are on", () => {
    const verboseJson = {
      segments: [
        { start: 0, end: 1.5, text: "Hello there" },
        { start: 1.5, end: 3, text: "[SPEAKER_TURN] Hi back" },
        { start: 3, end: 4, text: "How are you?" },
      ],
    };

    const result = formatTranscript(verboseJson, "timestamped", { includeSpeakers: true });

    expect(result.text).toContain("[00:00:00] Speaker 1: Hello there");
    expect(result.text).toContain("[00:00:01] Speaker 2: Hi back How are you?");
  });
});

describe("F4 — a dead whisper-server is not handed the next request (FIXED)", () => {
  /**
   * Observed: an invalid language code killed whisper-server, and because the
   * child process "close" handler is asynchronous, `ready` was still true when
   * the NEXT, entirely valid transcription arrived. That request skipped the
   * restart path and died with ECONNREFUSED too — one bad request cost the user
   * two transcriptions. Only the third attempt restarted the server.
   */
  it("clears ready when the local server refuses the connection", async () => {
    const server = http.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Failed to start test server");
    const port = address.port;
    await new Promise<void>((resolve) => server.close(() => resolve()));

    const manager: any = new WhisperServerManager();
    manager.port = port;
    manager.ready = true;

    await expect(
      manager._postInference(Buffer.from("not really a wav"), { durationSeconds: 1 })
    ).rejects.toThrow(/whisper-server request failed/);

    expect(manager.ready).toBe(false);
  });
});

describe("F1 — an in-flight decode can be cancelled (FIXED)", () => {
  /**
   * Before the fix nothing threaded an AbortSignal from the renderer to the
   * http.request inside the decode loop, so a running transcription could only
   * be escaped by force-quitting the app.
   *
   * The property that matters beyond "it stops": the warm server is SHARED with
   * dictation, so a cancel must not mark it dead. Our own abort surfaces as
   * ECONNRESET, which is exactly the code the F4 fix treats as "the server is
   * gone" — so the abort has to be recognised as ours before that check runs.
   */
  it("rejects as cancelled and leaves the warm server usable", async () => {
    // Accepts the connection and never answers, the way a long decode looks.
    const server = http.createServer(() => {});
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Failed to start test server");

    const manager: any = new WhisperServerManager();
    manager.port = address.port;
    manager.ready = true;

    const controller = new AbortController();
    const pending = manager._postInference(makeWav(1), {
      language: "en",
      durationSeconds: 600,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);

    await expect(pending).rejects.toMatchObject({ cancelled: true });
    // Not ECONNRESET-shaped collateral: the next dictation reuses this server.
    expect(manager.ready).toBe(true);

    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("does not even send a request when the signal is already aborted", async () => {
    const manager: any = new WhisperServerManager();
    manager.port = 1;
    manager.ready = true;

    await expect(
      manager._postInference(makeWav(1), {
        durationSeconds: 1,
        signal: AbortSignal.abort(),
      })
    ).rejects.toMatchObject({ cancelled: true });
    expect(manager.getRecentInferenceRequests()).toHaveLength(0);
  });
});

describe("F3 — an unknown language code no longer reaches whisper-server (FIXED)", () => {
  /**
   * Observed before the fix: posting language="zz" to the real whisper-server
   * killed the process — ECONNRESET on that request, ECONNREFUSED on the retry.
   * getModelSupportedLanguages("whisper") returned null, meaning "no
   * restriction", so isLanguageSupported accepted ANY string and
   * resolveTranscriptionLanguage passed it straight through. The Transcribe
   * page reads its language from localStorage ("fileTranscriptionLanguage"),
   * so a stale or hand-edited value was enough to take the engine down.
   *
   * The blocking question was which set to validate against: the app's picker
   * lists 58 languages, whisper.cpp accepts ~99, and refusing the 41 in between
   * would break languages the engine really handles. Answered by validating
   * against whisper's own set (src/utils/whisperLanguageCodes.ts, pinned to the
   * main process's table) — it refuses nothing that can be decoded.
   */
  it("falls back to auto-detect instead of forwarding an unknown code", () => {
    expect(resolveTranscriptionLanguage("zz", "whisper", "base")).toBeNull();
  });

  it("still forwards codes the picker really offers", () => {
    expect(resolveTranscriptionLanguage("da", "whisper", "base")).toBe("da");
    expect(resolveTranscriptionLanguage("auto", "whisper", "base")).toBeNull();
  });

  it("still forwards the languages whisper has but the picker does not", () => {
    // Refusing these would have been the easy fix and the wrong one.
    expect(resolveTranscriptionLanguage("yue", "whisper", "base")).toBe("yue");
    expect(resolveTranscriptionLanguage("haw", "whisper", "base")).toBe("haw");
    expect(LANGUAGE_OPTIONS.some((option) => option.value === "yue")).toBe(false);
  });

  /**
   * The wire is the boundary that matters: whisper-server does not answer an
   * unknown code with an error, it dies on the request. So the check has to sit
   * in front of the POST, not only in the renderer helper above.
   */
  it("refuses an unknown code at the request boundary, without sending it", async () => {
    const manager: any = new WhisperServerManager();
    manager.port = 1; // never contacted — the guard rejects first
    manager.ready = true;

    await expect(
      manager._postInference(Buffer.from("not really a wav"), {
        language: "zz",
        durationSeconds: 1,
      })
    ).rejects.toThrow(/not a language this transcription engine knows/i);

    // Nothing was sent, so nothing was recorded, and the server is untouched.
    expect(manager.getRecentInferenceRequests()).toHaveLength(0);
    expect(manager.ready).toBe(true);
  });

  it("accepts a language whisper knows at the same boundary", async () => {
    const manager: any = new WhisperServerManager();
    manager.port = 1;
    manager.ready = true;

    // Rejects on the connection, not on validation — proof the guard let it by.
    await expect(
      manager._postInference(Buffer.from("not really a wav"), {
        language: "da",
        durationSeconds: 1,
      })
    ).rejects.toThrow(/whisper-server request failed/);
    expect(manager.getRecentInferenceRequests()).toHaveLength(1);
  });
});

describe("F6 — nothing moves the progress bar below 20 minutes", () => {
  /**
   * Chunking, and therefore every intermediate progress event, only starts
   * above WHISPER_LONG_AUDIO_THRESHOLD_SECONDS (20 minutes). Below it the run
   * is a single chunk, so onProgress emits transcribing 0% and then 100% with
   * nothing in between — and the page only renders its progress bar while
   * percentage > 0. A 19-minute file therefore shows a spinner and an elapsed
   * counter for the entire run.
   *
   * Blocking question for the fix: intermediate progress needs either a
   * smaller chunk size (which changes decode context, and so accuracy) or
   * progress read from whisper-server's realtime stdout. That is a design
   * choice, not a patch.
   */
  it.fails("splits a 19-minute file into more than one progress step", () => {
    const manager: any = new WhisperServerManager();
    const chunks = manager._splitWavIntoTranscriptionChunks(makeWav(19 * 60));

    expect(chunks.length).toBeGreaterThan(1);
  });

  it("does split a file over the 20-minute threshold", () => {
    const manager: any = new WhisperServerManager();
    const chunks = manager._splitWavIntoTranscriptionChunks(makeWav(21 * 60));

    expect(chunks.length).toBeGreaterThan(1);
  });
});

describe("F9 — chunk boundaries leave overlapping SRT cues", () => {
  /**
   * whisper.cpp's last segment in a chunk can end past the chunk's nominal
   * length. Each chunk's segments are offset by the chunk's start and then
   * concatenated, so that overrun lands on top of the next chunk's first
   * segment.
   *
   * Observed on the real 32:04 fixture: 657 cues, 13 overlapping, 5 of zero or
   * negative length, and 2 that ran backwards — at 1260.559s -> 1260.000s and
   * 1560.039s -> 1560.000s, both exactly on 60-second chunk boundaries. The
   * shape below is that measurement.
   */
  const chunkBoundaryOverrun = {
    segments: [
      { start: 1255.0, end: 1260.559, text: "trailing words of the earlier chunk" },
      { start: 1260.559, end: 1260.559, text: "good." },
      { start: 1260.0, end: 1264.2, text: "slow and my professor talks fast." },
    ],
  };

  it.fails("emits SRT cues that never run backwards", () => {
    const cues = parseSrtCues(
      formatTranscript(chunkBoundaryOverrun, "srt", { includeSpeakers: false }).text
    );

    const backwards = cues.filter((cue, i) => i > 0 && cue.start < cues[i - 1].start);
    expect(backwards).toEqual([]);
  });

  it.fails("emits SRT cues that never overlap the previous cue", () => {
    const cues = parseSrtCues(
      formatTranscript(chunkBoundaryOverrun, "srt", { includeSpeakers: false }).text
    );

    const overlapping = cues.filter((cue, i) => i > 0 && cue.start < cues[i - 1].end);
    expect(overlapping).toEqual([]);
  });
});

describe("F5 — a forced wrong language is surfaced, not swallowed (FIXED)", () => {
  /**
   * Driving the real pipeline on the English control fixture:
   *
   *   language=en  -> COVERAGE 0.9790
   *   language=da  -> COVERAGE 0.0699, fluent Danish that says nothing the
   *                   speaker said
   *   language=ja  -> COVERAGE 0.0000
   *
   * All three came back success:true, and the page showed a green
   * "Transcription complete" toast over the gibberish.
   *
   * The evidence to catch this is in the very same response the app already
   * parses: whisper-server returned detected_language "english" with
   * detected_language_probability 0.9965 on ALL THREE runs, including the ones
   * where the caller forced Danish and Japanese. parseWhisperResult narrows
   * the payload to {success, text} and transcribeViaServer only carries a
   * detected language when the caller did NOT pin one, so the mismatch is
   * discarded every time.
   *
   * The blocking question was what the user should SEE. Answered by
   * surfacing rather than overriding: the result carries the server's own
   * verdict, and the page shows a notice with a one-click re-run when a FORCED
   * language disagrees with a detection at 0.9 or better. The user's explicit
   * choice still stands until they press the button, and auto-detect runs are
   * untouched. The existing `detectedLanguage` field keeps its contract ("we
   * worked this out ourselves"); this travels separately.
   */
  /** A real whisper-server verbose_json response to language=da on English audio. */
  const forcedDanishOnEnglishAudio = {
    task: "transcribe",
    language: "danish",
    duration: 46.825,
    text: "Jeg har været med at blive min lecture.",
    segments: [{ start: 0, end: 4.27, text: "Jeg har været med at blive min lecture." }],
    detected_language: "english",
    detected_language_probability: 0.9964860081672668,
  };

  it("confirms the mismatch evidence arrives in the response the app parses", () => {
    expect(forcedDanishOnEnglishAudio.language).toBe("danish");
    expect(forcedDanishOnEnglishAudio.detected_language).toBe("english");
    expect(forcedDanishOnEnglishAudio.detected_language_probability).toBeGreaterThan(0.99);
  });

  it("keeps the detected language when narrowing the server response", () => {
    const manager: any = new WhisperManager();
    const parsed = manager.parseWhisperResult(forcedDanishOnEnglishAudio);

    // parseWhisperResult was the step that threw the evidence away: it returned
    // {success, text} and nothing else, so no caller above it could tell that
    // whisper was 99.6% sure the audio was not the language it was told to use.
    expect(parsed.success).toBe(true);
    expect(parsed).toHaveProperty("detectedLanguage", "english");
    expect(parsed.detectedLanguageProbability).toBeGreaterThan(0.99);
  });

  it("turns that evidence into a notice on the measured fixture", () => {
    const manager: any = new WhisperManager();
    const parsed = manager.parseWhisperResult(forcedDanishOnEnglishAudio);

    // The shape the renderer receives, built the way transcribeViaServer builds
    // it: the server's verdict normalised to a code, paired with what the
    // caller forced.
    const notice = buildLanguageMismatchNotice(
      {
        detected: "en",
        detectedName: parsed.detectedLanguage,
        probability: parsed.detectedLanguageProbability,
        requested: "da",
        mismatch: true,
      },
      "da"
    );

    expect(notice).not.toBeNull();
    expect(notice?.detectedLabel).toBe("English");
    expect(notice?.forcedLabel).toBe("Danish");
    expect(notice?.probabilityPercent).toBe("99.6");
  });

  it("stays quiet on an auto-detect run, however sure the engine was", () => {
    // Nothing was forced, so there is no disagreement to report — the detection
    // IS the answer.
    expect(
      buildLanguageMismatchNotice({ detected: "en", probability: 0.9965, requested: null }, "auto")
    ).toBeNull();
  });

  it("stays quiet when the engine is not sure", () => {
    expect(
      buildLanguageMismatchNotice(
        { detected: "en", probability: 0.62, requested: "da", mismatch: true },
        "da"
      )
    ).toBeNull();
  });
});
