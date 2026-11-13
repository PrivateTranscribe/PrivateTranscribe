import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  DONE_SHOWN_MS,
  LEAVE_MS,
  createLevelStore,
  fadeAt,
  questionStage,
  useNarratorRows,
  type NarratorOverlayView,
  type NarratorRows,
} from "../../../src/hooks/useNarratorRows";
import type { NarratorVoiceQuestion } from "../../../src/utils/narratorTypes";

/** A fixed moment in the past, so "long ago" is long ago on any clock. */
const START = 1_700_000_000_000;

function question(patch: Partial<NarratorVoiceQuestion> = {}): NarratorVoiceQuestion {
  return {
    id: "q1",
    chat: "Export fix",
    question: "Merge it now?",
    choices: ["Merge", "Wait"],
    language: "en",
    phase: "open",
    windowEndsAt: START + 15_000,
    picked: null,
    confirmEndsAt: null,
    missed: 0,
    ended: null,
    result: null,
    startedAt: START,
    endedAt: null,
    ...patch,
  };
}

/** The hook as App.jsx calls it, rendered once. */
function rowsFor(view: NarratorOverlayView | null): NarratorRows {
  let rows: NarratorRows | null = null;
  function Probe() {
    rows = useNarratorRows(view);
    return null;
  }
  renderToStaticMarkup(React.createElement(Probe));
  return rows as unknown as NarratorRows;
}

const view = (patch: Partial<NarratorOverlayView> = {}): NarratorOverlayView => ({
  question: null,
  waiting: 0,
  gaming: true,
  language: "en",
  ...patch,
});

describe("narrator overlay rows", () => {
  it("keeps a question on screen in every phase until it is done", () => {
    for (const phase of [
      "speaking",
      "not-caught",
      "open",
      "recording",
      "hearing",
      "reading",
      "confirming",
      "closing",
    ] as const) {
      expect(questionStage(question({ phase }), START + 10 * 60_000)).toBe("live");
    }
  });

  it("shows a finished question for its own time, fades it, then lets it go", () => {
    const sent = question({
      phase: "done",
      result: "answered",
      picked: "Merge",
      endedAt: START + 20_000,
    });
    const fade = fadeAt(sent);
    expect(fade).toBe(START + 20_000 + DONE_SHOWN_MS.answered);
    expect(questionStage(sent, START + 20_000)).toBe("live");
    expect(questionStage(sent, fade - 1)).toBe("live");
    expect(questionStage(sent, fade)).toBe("leaving");
    expect(questionStage(sent, fade + LEAVE_MS - 1)).toBe("leaving");
    expect(questionStage(sent, fade + LEAVE_MS)).toBe("gone");
  });

  it("leaves an unanswered question up longer than a sent one", () => {
    const at = (result: NarratorVoiceQuestion["result"]) =>
      fadeAt(question({ phase: "done", result, endedAt: START }));
    expect(at("no_answer")).toBeGreaterThan(at("answered"));
    expect(at("no_match")).toBeGreaterThan(at("answered"));
  });

  it("times a finished question from its start when the end is missing", () => {
    expect(fadeAt(question({ phase: "done", result: "cancelled", endedAt: null }))).toBe(
      START + DONE_SHOWN_MS.cancelled
    );
  });

  it("never shows a question that was not said", () => {
    expect(questionStage(question({ phase: "done", result: "not_active" }), START)).toBe("gone");
    expect(questionStage(question({ phase: "speaking", result: "not_active" }), START)).toBe(
      "gone"
    );
    expect(questionStage(null, START)).toBe("gone");
  });

  it("puts a live question in the column, and the waiting count only once it is gone", () => {
    const live = rowsFor(view({ question: question(), waiting: 2 }));
    expect(live.question?.id).toBe("q1");
    expect(live.waiting).toBe(0);
    expect(live.visible).toBe(true);

    const longAgo = question({ phase: "done", result: "no_answer", endedAt: START });
    const after = rowsFor(view({ question: longAgo, waiting: 2 }));
    expect(after.question).toBeNull();
    expect(after.waiting).toBe(2);
    expect(after.visible).toBe(true);
  });

  it("keeps a just-finished question up when the column is first drawn", () => {
    vi.useFakeTimers();
    vi.setSystemTime(START + 21_000);
    try {
      const sent = question({ phase: "done", result: "answered", endedAt: START + 20_000 });
      expect(rowsFor(view({ question: sent })).question?.id).toBe("q1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the waiting count only in gaming mode", () => {
    expect(rowsFor(view({ gaming: false, waiting: 3 })).visible).toBe(false);
    expect(rowsFor(view({ gaming: true, waiting: 3 })).waiting).toBe(3);
    expect(rowsFor(view({ gaming: true, waiting: 0 })).visible).toBe(false);
    expect(rowsFor(null).visible).toBe(false);
  });

  it("tells the bars about a level change once, and stops after unsubscribe", () => {
    const store = createLevelStore();
    const listener = vi.fn();
    const off = store.subscribe(listener);
    store.set(0.4);
    store.set(0.4);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.get()).toBe(0.4);
    off();
    store.set(0.1);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
