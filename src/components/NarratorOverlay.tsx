import { useCallback, useEffect, useRef, useState } from "react";
import { NarratorPlayer } from "../helpers/narratorPlayer";
import { useConverseVoice } from "../hooks/useConverseVoice";
import { DEFAULT_KOKORO_VOICE_ID, VOICE_STORAGE_KEY } from "../models/kokoroVoices";
import {
  EXPERIMENTAL_FEATURES_KEY,
  areExperimentalFeaturesEnabled,
} from "../utils/experimentalFeatures";
import type { NarratorState } from "../utils/narratorTypes";

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
 * hears "hvad er nyt?" without a key.
 *
 * Listening only ever runs with local transcription and no cloud fallback.
 * Every sound in the room is transcribed to find a command, and that audio
 * must not go to a cloud provider.
 */
export default function NarratorOverlay({ isRecording }: { isRecording: boolean }) {
  const [state, setState] = useState<NarratorState | null>(null);
  const [playing, setPlaying] = useState(false);
  const [localOnly, setLocalOnly] = useState(isLocalOnlyTranscription);
  const recordingRef = useRef(isRecording);
  const playerRef = useRef<NarratorPlayer | null>(null);

  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.narratorSetGate) return undefined;
    const player = new NarratorPlayer({
      holdWhile: () => recordingRef.current,
      onPlayingChange: setPlaying,
    });
    playerRef.current = player;

    const offState = api.onNarratorState?.((_event, next) => setState(next));
    const offPlay = api.onNarratorPlay?.((_event, message) => player.handle(message));
    const offStop = api.onNarratorStopPlayback?.(() => player.stop());

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
      player.stop();
      playerRef.current = null;
    };
  }, []);

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
    muted: isRecording || (playing && !bargeIn),
    endOfTurnMs: COMMAND_END_OF_TURN_MS,
    maxSpeechMs: COMMAND_MAX_SPEECH_MS,
    // A command is matched as it was heard; AI cleanup can be a cloud model.
    skipCleanup: true,
    onUtterance,
    onSpeechStart,
  });

  return null;
}
