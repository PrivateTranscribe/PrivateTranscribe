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
  /** The waiting count is fading out. */
  waitingLeaving: boolean;
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

/** How long the waiting count shows once a chat starts waiting, before it fades. */
export const WAITING_SHOWN_MS = 5000;

/** What the waiting count remembers between draws. */
export interface WaitingNotice {
  /** The count last seen, so a rise is noticed. */
  count: number;
  /** A chat started waiting while a question covered the count: it shows once the row is free. */
  pending: boolean;
  /** How many times the count has come up, ever; each time gets its own WAITING_SHOWN_MS. */
  shows: number;
}

export const NO_WAITING_NOTICE: WaitingNotice = { count: 0, pending: false, shows: 0 };

/**
 * The notice after one look at the count. A rise brings the count up anew; a
 * fall changes the number and adds no time; `covered` (a question is on
 * screen) holds a rise back until the question is gone. Returns `prev` itself
 * when nothing changed.
 */
export function nextWaitingNotice(
  prev: WaitingNotice,
  count: number,
  covered: boolean
): WaitingNotice {
  // The showings keep counting up: a wait after every chat was answered is a new showing.
  if (count <= 0) {
    return prev.count === 0 && !prev.pending
      ? prev
      : { count: 0, pending: false, shows: prev.shows };
  }
  const pending = prev.pending || count > prev.count;
  if (pending && !covered) return { count, pending: false, shows: prev.shows + 1 };
  if (count === prev.count && pending === prev.pending) return prev;
  return { count, pending, shows: prev.shows };
}

function useWaitingStage(count: number, covered: boolean): QuestionStage {
  // Taken in while drawing, the first draw included, so a count that is
  // already there comes up with it and a count that is gone leaves at once.
  const [notice, setNotice] = useState(() => nextWaitingNotice(NO_WAITING_NOTICE, count, covered));
  const current = nextWaitingNotice(notice, count, covered);
  if (current !== notice) setNotice(current);

  /** How far the fade of one showing has come; a new showing starts live again. */
  const [fade, setFade] = useState<{ shows: number; stage: QuestionStage }>({
    shows: 0,
    stage: "live",
  });
  const { shows } = current;
  useEffect(() => {
    if (!shows) return undefined;
    const timers = [
      setTimeout(() => setFade({ shows, stage: "leaving" }), WAITING_SHOWN_MS),
      setTimeout(() => setFade({ shows, stage: "gone" }), WAITING_SHOWN_MS + LEAVE_MS),
    ];
    return () => timers.forEach(clearTimeout);
  }, [shows]);

  if (covered || count <= 0 || !shows || current.pending) return "gone";
  return fade.shows === shows ? fade.stage : "live";
}

export function useNarratorRows(view: NarratorOverlayView | null): NarratorRows {
  const question = view?.question ?? null;
  const stage = useQuestionStage(question);
  const shown = question !== null && stage !== "gone";
  // While a question is on screen its row says everything. A chat that starts
  // waiting shows a quiet count for a few seconds, then it fades: nothing stays
  // parked over a game. Only in gaming mode: at the PC the chats show their own waits.
  const count = view?.gaming ? Math.max(0, view.waiting || 0) : 0;
  const waitingStageNow = useWaitingStage(count, shown);
  const waiting = waitingStageNow === "gone" ? 0 : count;
  return {
    question: shown ? question : null,
    leaving: stage === "leaving",
    waiting,
    waitingLeaving: waitingStageNow === "leaving",
    visible: shown || waiting > 0,
  };
}
