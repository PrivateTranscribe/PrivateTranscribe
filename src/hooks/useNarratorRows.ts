import { useEffect, useState } from "react";
import type {
  NarratorLanguage,
  NarratorQuestionResult,
  NarratorVoiceQuestion,
} from "../utils/narratorTypes";

/**
 * What the narrator shows in the dictation overlay's column, worked out apart
 * from how it is drawn (NarratorQuestionRows.tsx): App.jsx asks, so the
 * dictation button opens under a row and rests as the line again once the
 * last one has faded.
 */

/** The part of the narrator's state the overlay draws. */
export interface NarratorOverlayView {
  question: NarratorVoiceQuestion | null;
  /** Chats that wait on the user. */
  waiting: number;
  gaming: boolean;
  /** "Speak in": the language of the overlay's own words. */
  language: NarratorLanguage;
}

/** What the narrator puts in the overlay column right now. */
export interface NarratorRows {
  /** The question row, while it is on screen. */
  question: NarratorVoiceQuestion | null;
  /** The question row is fading out. */
  leaving: boolean;
  /** The quiet count of chats waiting, or 0 for none shown. */
  waiting: number;
  visible: boolean;
}

/** The answer's loudness while it records, 0-1, read without re-rendering the overlay. */
export interface LevelSource {
  subscribe(listener: () => void): () => void;
  get(): number;
}

export interface LevelStore extends LevelSource {
  set(value: number): void;
}

/** One level, written by the answer recorder and read by the bars. */
export function createLevelStore(): LevelStore {
  let value = 0;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next) {
      if (next === value) return;
      value = next;
      listeners.forEach((listener) => listener());
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** How long a finished question stays before it fades, by how it ended. */
export const DONE_SHOWN_MS: Record<Exclude<NarratorQuestionResult, "not_active">, number> = {
  answered: 2500,
  cancelled: 2000,
  no_answer: 3200,
  no_match: 3200,
};

/** The fade itself. */
export const LEAVE_MS = 200;

export type QuestionStage = "live" | "leaving" | "gone";

/** When a finished question's row starts to fade (epoch ms), or 0 while it is not finished. */
export function fadeAt(question: NarratorVoiceQuestion | null): number {
  if (question?.phase !== "done" || !question.result || question.result === "not_active") return 0;
  return (question.endedAt ?? question.startedAt) + DONE_SHOWN_MS[question.result];
}

/** Where a question's row is at `now`: on screen, fading out, or gone. */
export function questionStage(question: NarratorVoiceQuestion | null, now: number): QuestionStage {
  // A question that was never said has nothing to show.
  if (!question || question.result === "not_active") return "gone";
  const fade = fadeAt(question);
  if (!fade) return "live";
  if (now >= fade + LEAVE_MS) return "gone";
  return now >= fade ? "leaving" : "live";
}

function useQuestionStage(question: NarratorVoiceQuestion | null): QuestionStage {
  const [now, setNow] = useState(() => Date.now());
  const fade = fadeAt(question);
  useEffect(() => {
    if (!fade) return undefined;
    // Each step sets at least its own time: a timer that fires a moment early
    // must not leave a faded row standing.
    const timers = [fade, fade + LEAVE_MS].map((at) =>
      setTimeout(() => setNow(Math.max(Date.now(), at)), Math.max(0, at - Date.now()))
    );
    return () => timers.forEach(clearTimeout);
  }, [fade]);
  return questionStage(question, now);
}

export function useNarratorRows(view: NarratorOverlayView | null): NarratorRows {
  const question = view?.question ?? null;
  const stage = useQuestionStage(question);
  const shown = question !== null && stage !== "gone";
  // While a question is on screen its row says everything; after it, a quiet
  // count stays. Only in gaming mode: at the PC the chats show their own waits.
  const waiting = view?.gaming && !shown ? Math.max(0, view.waiting || 0) : 0;
  return {
    question: shown ? question : null,
    leaving: stage === "leaving",
    waiting,
    visible: shown || waiting > 0,
  };
}
