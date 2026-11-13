import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import NarratorQuestionRows from "../../../src/components/NarratorQuestionRows";
import type { NarratorRows } from "../../../src/hooks/useNarratorRows";
import type { NarratorLanguage, NarratorVoiceQuestion } from "../../../src/utils/narratorTypes";

/**
 * The voice-question card in the dictation overlay, one render per phase:
 * the words a gamer reads at a glance, the key that answers, and that
 * nothing in it can take a click or the keyboard.
 */

const decode = (html: string) =>
  html
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&");

/** Visible text only, tags dropped, whitespace folded. */
const text = (html: string) =>
  decode(html.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();

function question(patch: Partial<NarratorVoiceQuestion> = {}): NarratorVoiceQuestion {
  const now = Date.now();
  return {
    id: "q1",
    chat: "Export fix",
    question: "Merge the export fix now?",
    choices: ["Merge it", "Not now"],
    language: "en",
    phase: "speaking",
    windowEndsAt: null,
    picked: null,
    confirmEndsAt: null,
    missed: 0,
    ended: null,
    result: null,
    startedAt: now,
    endedAt: null,
    ...patch,
  };
}

function render(
  q: NarratorVoiceQuestion | null,
  { language = "en", waiting = 0 }: { language?: NarratorLanguage; waiting?: number } = {}
) {
  const rows: NarratorRows = { question: q, leaving: false, waiting, visible: true };
  return renderToStaticMarkup(
    React.createElement(NarratorQuestionRows, { rows, language, level: null })
  );
}

beforeEach(() => {
  vi.stubGlobal("localStorage", window.localStorage);
  window.localStorage.setItem("dictationKey", "F20");
  window.localStorage.setItem("activationMode", "tapHold");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("narrator voice question card", () => {
  it("says who asks, what, the choices, and which key answers while it speaks", () => {
    const html = render(question());
    expect(text(html)).toContain("Export fix asks");
    expect(text(html)).toContain("Merge the export fix now?");
    expect(text(html)).toContain("Hold F20 to answer");
    expect(html).toMatch(/<kbd[^>]*>F20<\/kbd>/);
    expect(html.match(/data-testid="narrator-question-choice"/g)).toHaveLength(2);
    expect(html).toContain('data-phase="speaking"');
    expect(html).not.toContain("narrator-question-timer");
  });

  it("drains the answer window with its seconds left", () => {
    const html = render(question({ phase: "open", windowEndsAt: Date.now() + 15_000 }));
    expect(html).toContain('data-testid="narrator-question-timer"');
    expect(html).toContain('aria-valuemax="15"');
    expect(html).toContain('data-seconds="15"');
    expect(text(html)).toContain("Hold F20 to answer");
  });

  it("asks to try again after an answer matched no choice", () => {
    const html = render(question({ phase: "open", missed: 1, windowEndsAt: Date.now() + 9_000 }));
    expect(text(html)).toContain("Export fix try again");
  });

  it("says Press in tap mode, where a press starts and stops", () => {
    window.localStorage.setItem("activationMode", "tap");
    expect(text(render(question()))).toContain("Press F20 to answer");
    expect(text(render(question({ phase: "recording" })))).toContain("Press F20 to stop");
  });

  it("shows the answer being heard as level bars, without a countdown", () => {
    const html = render(question({ phase: "recording" }));
    expect(text(html)).toContain("Export fix listening");
    expect(html).toContain('data-testid="narrator-question-level"');
    expect(html).not.toContain("narrator-question-timer");
    expect(text(html)).not.toContain("to stop");
  });

  it("says when it is checking and when it did not catch the answer", () => {
    expect(text(render(question({ phase: "hearing" })))).toContain("Export fix checking");
    expect(text(render(question({ phase: "not-caught", missed: 1 })))).toContain(
      "didn't catch that"
    );
  });

  it("lights the heard choice and counts down the 3 seconds to cancel", () => {
    const html = render(
      question({ phase: "confirming", picked: "Merge it", confirmEndsAt: Date.now() + 3_000 })
    );
    expect(text(html)).toContain("Export fix sending");
    expect(text(html)).toContain("Press F20 to cancel");
    expect(html).toMatch(/data-picked="true"[^>]*>Merge it</);
    expect(html).not.toMatch(/data-picked="true"[^>]*>Not now</);
    expect(html).toContain('aria-valuemax="3"');
  });

  it("ends with what happened, and says an unanswered question waits in the chat", () => {
    const sent = render(question({ phase: "done", result: "answered", picked: "Merge it" }));
    expect(text(sent)).toContain("Export fix sent");
    expect(sent).toMatch(/data-picked="true"[^>]*>Merge it</);
    expect(sent).not.toContain("narrator-question-hint");

    expect(text(render(question({ phase: "done", result: "cancelled" })))).toContain(
      "Export fix cancelled"
    );

    const none = text(render(question({ phase: "done", result: "no_answer" })));
    expect(none).toContain("Export fix no answer");
    expect(none).toContain("It waits in the chat");

    expect(text(render(question({ phase: "done", result: "no_match", missed: 2 })))).toContain(
      "no choice matched"
    );
  });

  it("speaks Danish when Speak in is Danish, and keeps the chat's own words", () => {
    const asking = text(render(question(), { language: "da" }));
    expect(asking).toContain("Export fix spørger");
    expect(asking).toContain("Hold F20 for at svare");
    expect(asking).toContain("Merge the export fix now?");

    const none = text(render(question({ phase: "done", result: "no_answer" }), { language: "da" }));
    expect(none).toContain("intet svar");
    expect(none).toContain("Den venter i chatten");
  });

  it("collapses to a quiet count of waiting chats", () => {
    expect(text(render(null, { waiting: 1 }))).toBe("1 chat waiting");
    expect(text(render(null, { waiting: 3 }))).toBe("3 chats waiting");
    expect(text(render(null, { waiting: 2, language: "da" }))).toBe("2 chats venter");
  });

  it("never takes a click or the keyboard", () => {
    for (const html of [
      render(question()),
      render(
        question({ phase: "confirming", picked: "Merge it", confirmEndsAt: Date.now() + 3_000 })
      ),
      render(null, { waiting: 2 }),
    ]) {
      expect(html).not.toMatch(/<(button|a|input|select|textarea)\b/);
      expect(html).not.toContain("tabindex");
      const rows = html.match(/data-testid="narrator-(question|waiting)"[^>]*>/g) || [];
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) expect(row).toContain("pointer-events:none");
    }
  });
});
