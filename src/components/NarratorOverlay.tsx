import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NarratorAnswerRecorder } from "../helpers/narratorAnswerRecorder";
import { NarratorPlayer } from "../helpers/narratorPlayer";
import { useConverseVoice } from "../hooks/useConverseVoice";
import { DEFAULT_KOKORO_VOICE_ID, VOICE_STORAGE_KEY } from "../models/kokoroVoices";
import {
  EXPERIMENTAL_FEATURES_KEY,
  areExperimentalFeaturesEnabled,
} from "../utils/experimentalFeatures";
import type { NarratorState } from "../utils/narratorTypes";
import type { LevelStore, NarratorOverlayView } from "../hooks/useNarratorRows";

/** A command is a short sentence; a quick pause ends it. */
const COMMAND_END_OF_TURN_MS = 700;
/**
 * Longer speech is talk in the room, not a command of a few words, and is
 * dropped without being transcribed.
 */
const COMMAND_MAX_SPEECH_MS = 6000;

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Local transcription with the cloud fallback off: the only setup allowed to hear the room. */
function isLocalOnlyTranscription(): boolean {
  return readStorage("useLocalWhisper") === "true" && readStorage("allowOpenAIFallback") !== "true";
}

/** English speech uses the voice picked for Read Aloud. */
function readAloudVoice(): string {
  return readStorage(VOICE_STORAGE_KEY) || DEFAULT_KOKORO_VOICE_ID;
}

/**
 * The narrator's half that lives in the always-open overlay window. It renders
 * nothing. It plays what the main process sends, tells main whether the
 * Experimental switch is on and which Read Aloud voice is picked, stops
 * speech when a dictation starts, and, when the user turned listening on,
 * hears "hvad er nyt?" without a key. It also records a voice answer when
 * main asks, separately from dictation, so an answer is never pasted.
 *
 * Listening and answers only ever run with local transcription and no cloud
 * fallback. What the microphone hears there must not go to a cloud provider.
 *
 * What the overlay draws of a voice question comes out through `onView`, and
 * the level of an answer being recorded through `level`; App.jsx draws both
 * in its column (NarratorQuestionRows.tsx).
 */
export default function NarratorOverlay({
  isRecording,
  onView,
  level,
}: {
  isRecording: boolean;
  onView?: (view: NarratorOverlayView | null) => void;
  level?: LevelStore;
}) {
  const [state, setState] = useState<NarratorState | null>(null);
  const [playing, setPlaying] = useState(false);
  const [localOnly, setLocalOnly] = useState(isLocalOnlyTranscription);
  const recordingRef = useRef(isRecording);
  const playerRef = useRef<NarratorPlayer | null>(null);
  const recorderRef = useRef<NarratorAnswerRecorder | null>(null);
  const levelRef = useRef(level);
  useEffect(() => {
    levelRef.current = level;
  }, [level]);

  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.narratorSetGate) return undefined;
    const player = new NarratorPlayer({
      holdWhile: () => recordingRef.current,
      onPlayingChange: setPlaying,
    });
    playerRef.current = player;
    const recorder = new NarratorAnswerRecorder({
      isLocalOnly: isLocalOnlyTranscription,
      onLevel: (value: number) => levelRef.current?.set(value),
    });
    recorderRef.current = recorder;

    const offState = api.onNarratorState?.((_event, next) => setState(next));
    const offPlay = api.onNarratorPlay?.((_event, message) => player.handle(message));
    const offStop = api.onNarratorStopPlayback?.(() => player.stop());
    const offAnswer = api.onNarratorAnswer?.((_event, message) => recorder.handle(message));

    void api
      .narratorSetGate(areExperimentalFeaturesEnabled())
      .then(setState)
      .catch(() => {});

    // The control panel shares this window's storage, so its switches arrive here as events.
    const onStorage = (event: StorageEvent) => {
      if (event.key === EXPERIMENTAL_FEATURES_KEY) {
        void api.narratorSetGate(areExperimentalFeaturesEnabled()).catch(() => {});
      }
      if (event.key === "useLocalWhisper" || event.key === "allowOpenAIFallback") {
        setLocalOnly(isLocalOnlyTranscription());
      }
      if (event.key === VOICE_STORAGE_KEY) {
        void api.narratorUpdateSettings?.({ voiceEn: readAloudVoice() }).catch(() => {});
      }
    };
    window.addEventListener("storage", onStorage);

    return () => {
      window.removeEventListener("storage", onStorage);
      offState?.();
      offPlay?.();
      offStop?.();
      offAnswer?.();
      recorder.dispose();
      recorderRef.current = null;
      player.stop();
      playerRef.current = null;
    };
  }, []);

  // A question being said may get a spoken answer: the engine starts loading now.
  const speakingQuestionId = state?.question?.phase === "speaking" ? state.question.id : null;
  useEffect(() => {
    if (speakingQuestionId) recorderRef.current?.prepare();
  }, [speakingQuestionId]);

  // Voice answers need local-only transcription; main opens no answer window without it.
  useEffect(() => {
    void window.electronAPI?.narratorSetLocalOnly?.(localOnly)?.catch?.(() => {});
  }, [localOnly]);

  // A voice picked on the Read Aloud page before this window opened.
  const voiceEn = state?.settings.voiceEn;
  useEffect(() => {
    if (voiceEn && voiceEn !== readAloudVoice()) {
      void window.electronAPI?.narratorUpdateSettings?.({ voiceEn: readAloudVoice() });
    }
  }, [voiceEn]);

  // The dictation hotkey is the barge-in key: starting a dictation silences the narrator.
  useEffect(() => {
    recordingRef.current = isRecording;
    if (isRecording && playerRef.current?.playing) {
      playerRef.current.stop();
      void window.electronAPI?.narratorStop?.();
    }
  }, [isRecording]);

  const running = Boolean(state?.running);

  // Main broadcasts the whole state on every change; the overlay only redraws
  // when the part it shows changed. The waiting count is part of Answer by
  // voice: with it off, the overlay looks exactly as it did before.
  const viewKey =
    running && state
      ? JSON.stringify({
          question: state.question ?? null,
          waiting: state.settings.answerByVoice === true ? (state.waiting ?? 0) : 0,
          gaming: state.settings.gaming === true,
          language: state.settings.language === "da" ? "da" : "en",
        })
      : "";
  const view = useMemo<NarratorOverlayView | null>(
    () => (viewKey ? (JSON.parse(viewKey) as NarratorOverlayView) : null),
    [viewKey]
  );
  useEffect(() => {
    onView?.(view);
  }, [onView, view]);
  // Gaming mode never listens: talk on a voice call must not become a command.
  const listen = Boolean(state?.settings.listen) && localOnly && !state?.settings.gaming;
  const bargeIn = state?.settings.bargeIn === true;

  const onUtterance = useCallback((text: string) => {
    void window.electronAPI?.narratorUtterance?.(text);
  }, []);

  const onSpeechStart = useCallback(() => {
    if (!bargeIn || !playerRef.current?.playing) return;
    playerRef.current.stop();
    void window.electronAPI?.narratorStop?.();
  }, [bargeIn]);

  useConverseVoice({
    enabled: listen,
    active: running,
    // An answer being recorded is not a command.
    muted: isRecording || Boolean(state?.answering) || (playing && !bargeIn),
    endOfTurnMs: COMMAND_END_OF_TURN_MS,
    maxSpeechMs: COMMAND_MAX_SPEECH_MS,
    // A command is matched as it was heard; AI cleanup can be a cloud model.
    skipCleanup: true,
    onUtterance,
    onSpeechStart,
  });

  return null;
}
