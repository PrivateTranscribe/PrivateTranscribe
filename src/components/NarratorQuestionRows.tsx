// React in scope: the unit tests render this with the classic JSX transform.
import React, { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { LEAVE_MS, type LevelSource, type NarratorRows } from "../hooks/useNarratorRows";
import { formatHotkeyLabel } from "../utils/hotkeys";
import type { NarratorLanguage, NarratorVoiceQuestion } from "../utils/narratorTypes";
import { VOICE_BAR_HEIGHTS, voiceBarScale } from "../utils/voiceBars";
import {
  OVERLAY_STATUS_DETAIL_CLASS,
  OVERLAY_STATUS_TEXT_CLASS,
  OVERLAY_SURFACE_CLASS,
  liveDotStyle,
  overlayRowStyle,
} from "./overlaySurface";

/**
 * The narrator's voice questions in the dictation overlay, as rows of its one
 * column (App.jsx), next to the dictation button that answers them:
 *
 *   speaking    the chat, its question and its choices; "Hold F20 to answer"
 *   open        the same, with the window's time draining as a hairline
 *   recording   "listening", with the answer's level as bars
 *   reading     the choice heard, lit; "Press F20 to cancel", 3 s draining
 *   done        sent, cancelled, or "it waits in the chat", then it fades
 *   waiting     a quiet "1 chat waiting" capsule until the chat is answered
 *
 * Every row is click-through and never takes focus: a game keeps the mouse
 * and the keyboard. Questions only come in gaming mode, and the waiting
 * capsule shows only there: at the PC the chats show their own questions.
 * The overlay's own words follow "Speak in"; the question and its choices
 * are the chat's, word for word. Which rows show, and when a finished one
 * fades, is worked out in hooks/useNarratorRows.ts.
 */

type Hint = [before: string, key: string, after: string];

const COPY = {
  en: {
    asks: "asks",
    tryAgain: "try again",
    listening: "listening",
    checking: "checking",
    notCaught: "didn't catch that",
    sending: "sending",
    sent: "sent",
    cancelled: "cancelled",
    noAnswer: "no answer",
    noMatch: "no choice matched",
    inChat: "It waits in the chat",
    answer: (key: string, tap: boolean): Hint => [tap ? "Press" : "Hold", key, "to answer"],
    stop: (key: string): Hint => ["Press", key, "to stop"],
    cancel: (key: string): Hint => ["Press", key, "to cancel"],
    waiting: (count: number) => (count === 1 ? "1 chat waiting" : `${count} chats waiting`),
    windowLeft: "Time left to answer",
    sendIn: "Time left to cancel",
  },
  da: {
    asks: "spørger",
    tryAgain: "prøv igen",
    listening: "lytter",
    checking: "tjekker",
    notCaught: "det fangede jeg ikke",
    sending: "sender",
    sent: "sendt",
    cancelled: "annulleret",
    noAnswer: "intet svar",
    noMatch: "passede ikke på et valg",
    inChat: "Den venter i chatten",
    answer: (key: string, tap: boolean): Hint => [tap ? "Tryk" : "Hold", key, "for at svare"],
    stop: (key: string): Hint => ["Tryk", key, "for at stoppe"],
    cancel: (key: string): Hint => ["Tryk", key, "for at annullere"],
    waiting: (count: number) => (count === 1 ? "1 chat venter" : `${count} chats venter`),
    windowLeft: "Tid tilbage til at svare",
    sendIn: "Tid tilbage til at annullere",
  },
} as const;

const WINDOW_TOTAL_MS = 15_000;
const CONFIRM_TOTAL_MS = 3_000;

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** The dictation key's label and whether it starts and stops with taps. */
function readKey() {
  return {
    label: formatHotkeyLabel(readStorage("dictationKey")),
    tap: readStorage("activationMode") === "tap",
  };
}

function useDictationKey() {
  const [key, setKey] = useState(readKey);
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === "dictationKey" || event.key === "activationMode") setKey(readKey());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  return key;
}

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

function reducedMotionQuery(): MediaQueryList | null {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(REDUCED_MOTION)
    : null;
}

function useReducedMotion() {
  const [reduced, setReduced] = useState(() => reducedMotionQuery()?.matches ?? false);
  useEffect(() => {
    const media = reducedMotionQuery();
    if (!media) return undefined;
    const onChange = () => setReduced(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

function KeyHint({ hint }: { hint: Hint }) {
  return (
    <span
      data-testid="narrator-question-hint"
      className="flex shrink-0 items-center gap-1 whitespace-nowrap text-[12px] leading-none text-white/60"
    >
      {/* The spaces are for a screen reader; the flex gap lays the words out. */}
      {`${hint[0]} `}
      <kbd className="rounded-[5px] border border-white/15 bg-white/10 px-1.5 py-[3px] font-sans text-[11px] font-semibold leading-none text-white/90">
        {hint[1]}
      </kbd>
      {` ${hint[2]}`}
    </span>
  );
}

const noLevel: LevelSource = { subscribe: () => () => {}, get: () => 0 };

/** The answer's level as the dictation button's bars, small, in the mint that means a live microphone. */
function LevelBars({ level }: { level: LevelSource | null }) {
  const source = level || noLevel;
  const value = useSyncExternalStore(source.subscribe, source.get, source.get);
  return (
    <span
      data-testid="narrator-question-level"
      aria-hidden
      className="flex shrink-0 items-center gap-[2px]"
    >
      {VOICE_BAR_HEIGHTS.map((height, index) => (
        <span
          key={index}
          style={{
            width: 2,
            height: height * 0.5,
            borderRadius: 1,
            backgroundColor: "var(--color-primary)",
            transform: `scaleY(${voiceBarScale(index, value)})`,
            transition: "transform 60ms cubic-bezier(0.25, 0.46, 0.45, 0.94)",
          }}
        />
      ))}
    </span>
  );
}

/**
 * The time a window has left, as the overlay shows progress everywhere: a
 * hairline, here draining at a constant rate, and the seconds beside it.
 */
function Countdown({
  endsAt,
  totalMs,
  label,
  reducedMotion,
}: {
  endsAt: number;
  totalMs: number;
  label: string;
  reducedMotion: boolean;
}) {
  const barRef = useRef<HTMLSpanElement>(null);
  const left = () => Math.max(0, endsAt - Date.now());
  const [remaining, setRemaining] = useState(left);
  useEffect(() => {
    const timer = setInterval(() => setRemaining(left()), 250);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar || reducedMotion) return;
    const ms = left();
    // One transition from the share left now to nothing, at the window's own pace.
    bar.style.transition = "none";
    bar.style.transform = `scaleX(${Math.min(1, ms / totalMs)})`;
    void bar.getBoundingClientRect();
    bar.style.transition = `transform ${ms}ms linear`;
    bar.style.transform = "scaleX(0)";
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endsAt, totalMs, reducedMotion]);
  const seconds = Math.ceil(remaining / 1000);
  return (
    <div className="flex items-center gap-2.5">
      <span
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={Math.round(totalMs / 1000)}
        aria-valuenow={seconds}
        data-testid="narrator-question-timer"
        data-seconds={seconds}
        className="relative block h-[2px] flex-1 overflow-hidden rounded-full bg-white/15"
      >
        <span
          ref={barRef}
          className="absolute inset-0 origin-left rounded-full bg-primary/85"
          style={
            reducedMotion ? { transform: `scaleX(${Math.min(1, remaining / totalMs)})` } : undefined
          }
        />
      </span>
      <span className="w-4 shrink-0 text-right text-[11px] leading-none tabular-nums text-white/50">
        {seconds}
      </span>
    </div>
  );
}

function QuestionRow({
  question,
  language,
  level,
  leaving,
  reducedMotion,
}: {
  question: NarratorVoiceQuestion;
  language: NarratorLanguage;
  level: LevelSource | null;
  leaving: boolean;
  reducedMotion: boolean;
}) {
  const copy = COPY[language] || COPY.en;
  const key = useDictationKey();
  const { phase, picked, result } = question;
  const ended = phase === "done" ? result : phase === "closing" ? question.ended : null;
  const lit =
    phase === "reading" ||
    phase === "confirming" ||
    (phase === "done" && result === "answered") ||
    (phase === "closing" && question.ended === "picked");

  let word: string = copy.asks;
  let dot = liveDotStyle({ live: false, pulse: false });
  let right: React.ReactNode = null;
  let countdown: { endsAt: number; totalMs: number; label: string } | null = null;

  if (phase === "speaking") {
    dot = liveDotStyle({ live: true, pulse: false });
    right = <KeyHint hint={copy.answer(key.label, key.tap)} />;
  } else if (phase === "open") {
    word = question.missed > 0 ? copy.tryAgain : copy.asks;
    right = <KeyHint hint={copy.answer(key.label, key.tap)} />;
    if (question.windowEndsAt) {
      countdown = {
        endsAt: question.windowEndsAt,
        totalMs: WINDOW_TOTAL_MS,
        label: copy.windowLeft,
      };
    }
  } else if (phase === "recording") {
    word = copy.listening;
    dot = liveDotStyle({ live: true, pulse: false });
    right = (
      <span className="flex items-center gap-2.5">
        <LevelBars level={level} />
        {key.tap && <KeyHint hint={copy.stop(key.label)} />}
      </span>
    );
  } else if (phase === "hearing") {
    word = copy.checking;
    dot = liveDotStyle({ live: false, pulse: true });
  } else if (phase === "not-caught") {
    word = copy.notCaught;
    dot = liveDotStyle({ live: false, pulse: false, warn: true });
  } else if (phase === "reading" || phase === "confirming") {
    word = copy.sending;
    dot = liveDotStyle({ live: phase === "reading", pulse: false });
    right = <KeyHint hint={copy.cancel(key.label)} />;
    if (phase === "confirming" && question.confirmEndsAt) {
      countdown = { endsAt: question.confirmEndsAt, totalMs: CONFIRM_TOTAL_MS, label: copy.sendIn };
    }
  } else if (ended === "answered" || ended === "picked") {
    word = copy.sent;
  } else if (ended === "cancelled") {
    word = copy.cancelled;
  } else if (ended) {
    const unmatched = ended === "no_match" || question.missed > 0;
    word = unmatched ? copy.noMatch : copy.noAnswer;
    dot = liveDotStyle({ live: false, pulse: false, warn: true });
    right = (
      <span className="shrink-0 whitespace-nowrap text-[12px] leading-none text-white/60">
        {copy.inChat}
      </span>
    );
  }

  const settled = phase === "done" || phase === "closing";
  const chipClass = (choice: string) => {
    if (lit && choice === picked) return "bg-white text-background";
    if (picked || settled) return "bg-white/5 text-white/40";
    return "bg-white/10 text-white/85";
  };

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="narrator-question"
      data-phase={phase}
      data-result={result || undefined}
      className={`flex flex-col gap-2.5 px-3.5 pb-3 pt-2.5 ${OVERLAY_SURFACE_CLASS}`}
      style={{
        ...overlayRowStyle({ interactive: false }),
        ...(reducedMotion ? { animation: "overlay-fade-in 180ms ease-out" } : {}),
        opacity: leaving ? 0 : 1,
        transform: leaving && !reducedMotion ? "translateY(4px)" : undefined,
        transition: `opacity ${LEAVE_MS}ms ease, transform ${LEAVE_MS}ms ease`,
      }}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span style={dot} aria-hidden />
        <span className={`${OVERLAY_STATUS_TEXT_CLASS} min-w-0 truncate`}>{question.chat}</span>
        <span className={`${OVERLAY_STATUS_DETAIL_CLASS} -ml-1 shrink-0 whitespace-nowrap`}>
          {word}
        </span>
        <span className="ml-auto flex shrink-0 items-center pl-2">{right}</span>
      </div>
      <p
        className="line-clamp-3 text-[14px] font-medium leading-[1.35] text-white/95"
        style={{ textWrap: "balance" }}
      >
        {question.question}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {question.choices.map((choice) => (
          <span
            key={choice}
            data-testid="narrator-question-choice"
            data-picked={lit && choice === picked ? "true" : undefined}
            className={`max-w-full truncate rounded-full px-2.5 py-[5px] text-[12px] font-medium leading-none transition-colors duration-150 ${chipClass(choice)}`}
          >
            {choice}
          </span>
        ))}
      </div>
      {countdown && (
        <Countdown key={countdown.endsAt} {...countdown} reducedMotion={reducedMotion} />
      )}
    </div>
  );
}

export default function NarratorQuestionRows({
  rows,
  language,
  level,
}: {
  rows: NarratorRows;
  language: NarratorLanguage;
  level: LevelSource | null;
}) {
  const reducedMotion = useReducedMotion();
  const copy = COPY[language] || COPY.en;
  // Reduced motion keeps the arrival but drops the rise: a plain fade.
  const entrance = reducedMotion ? { animation: "overlay-fade-in 180ms ease-out" } : {};

  return (
    <>
      {rows.waiting > 0 && (
        <div
          data-testid="narrator-waiting"
          data-count={rows.waiting}
          role="status"
          className={`flex items-center gap-2 px-3.5 ${OVERLAY_SURFACE_CLASS}`}
          style={{ ...overlayRowStyle({ interactive: false, status: true }), ...entrance }}
        >
          <span style={liveDotStyle({ live: false, pulse: false })} aria-hidden />
          <span className={`${OVERLAY_STATUS_TEXT_CLASS} whitespace-nowrap`}>
            {copy.waiting(rows.waiting)}
          </span>
        </div>
      )}
      {rows.question && (
        <QuestionRow
          key={rows.question.id}
          question={rows.question}
          language={language}
          level={level}
          leaving={rows.leaving}
          reducedMotion={reducedMotion}
        />
      )}
    </>
  );
}
