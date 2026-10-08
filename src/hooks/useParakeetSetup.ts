/**
 * useParakeetSetup.ts
 *
 * The one place that decides whether Parakeet suits this PC and runs the
 * download, speed test and keep-or-fall-back flow. Setup, the Dictation page
 * picker and the one-time offer card all read the same module-level state, so
 * a download started in one shows its progress and result in the others.
 */

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useModelDownload } from "./useModelDownload";
import {
  PARAKEET_MODEL_ID,
  evaluateParakeetFit,
  formatSpeedTestResult,
  speedTestKeepsParakeet,
  type ParakeetFit,
  type SpeedTestOutcome,
} from "../utils/parakeetLanguages";
import type { HardwareRecommendations, LocalTranscriptionProvider } from "../types/electron";

export const PARAKEET_OFFER_DISMISSED_KEY = "parakeetOfferDismissed";
export const PARAKEET_SPEED_TEST_KEY = "parakeetSpeedTest";
export const PARAKEET_FALLBACK_LINE = "Your PC is better suited to Whisper.";

export type SpeedTestStatus = "idle" | "running" | "passed" | "failed";

export interface EngineChange {
  localTranscriptionProvider: LocalTranscriptionProvider;
  whisperModel?: string;
}

interface SharedState {
  recommendations: HardwareRecommendations | null;
  detectionDone: boolean;
  modelDownloaded: boolean | null;
  speedTest: SpeedTestStatus;
  lastResult: SpeedTestOutcome | null;
  fellBackToWhisper: boolean;
  /** Set once the user picks an engine by hand, so setup stops choosing for them. */
  engineChosenByUser: boolean;
}

function readStoredResult(): SpeedTestOutcome | null {
  try {
    const raw = localStorage.getItem(PARAKEET_SPEED_TEST_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as SpeedTestOutcome) : null;
  } catch {
    return null;
  }
}

let state: SharedState = {
  recommendations: null,
  detectionDone: false,
  modelDownloaded: null,
  speedTest: "idle",
  lastResult: readStoredResult(),
  fellBackToWhisper: false,
  engineChosenByUser: false,
};
const listeners = new Set<() => void>();

function update(patch: Partial<SharedState>) {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getSnapshot = () => state;

let detectionPromise: Promise<void> | null = null;
function ensureDetection(): Promise<void> {
  if (!detectionPromise) {
    detectionPromise = (async () => {
      try {
        const result = await window.electronAPI?.detectHardware?.();
        update({ recommendations: result?.detection?.recommendations ?? null });
      } catch {
        update({ recommendations: null });
      } finally {
        update({ detectionDone: true });
      }
    })();
  }
  return detectionPromise;
}

async function refreshModelStatus(): Promise<boolean> {
  try {
    const status = await window.electronAPI?.checkParakeetModelStatus?.(PARAKEET_MODEL_ID);
    const downloaded = Boolean(status?.downloaded);
    update({ modelDownloaded: downloaded });
    return downloaded;
  } catch {
    update({ modelDownloaded: false });
    return false;
  }
}

function storeResult(result: SpeedTestOutcome | null) {
  update({ lastResult: result });
  try {
    if (result) localStorage.setItem(PARAKEET_SPEED_TEST_KEY, JSON.stringify(result));
    else localStorage.removeItem(PARAKEET_SPEED_TEST_KEY);
  } catch {
    // The result is still shown for this session.
  }
}

function fallbackWhisperModel(): string {
  // The detector's own pick for this PC, and its failure default when unsure.
  return state.recommendations?.whisperModel || "base";
}

/** Speed test, then keep Parakeet or delete it and go back to Whisper. */
async function runSpeedTestFlow(applyEngine: (change: EngineChange) => void): Promise<void> {
  if (state.speedTest === "running") return;
  update({ speedTest: "running", fellBackToWhisper: false });

  let result: SpeedTestOutcome | null = null;
  try {
    result = (await window.electronAPI?.parakeetSpeedTest?.(PARAKEET_MODEL_ID)) ?? null;
  } catch {
    result = null;
  }

  if (speedTestKeepsParakeet(result)) {
    storeResult({
      success: true,
      decodeMs: result?.decodeMs,
      audioSec: result?.audioSec,
      passed: true,
    });
    update({ speedTest: "passed" });
    return;
  }

  // A test that could not run counts as a fail: Whisper is known to work here.
  storeResult({
    success: Boolean(result?.success),
    decodeMs: result?.decodeMs,
    audioSec: result?.audioSec,
    passed: false,
  });
  try {
    await window.electronAPI?.deleteParakeetModel?.(PARAKEET_MODEL_ID);
  } catch {
    // A model left on disk is harmless; the engine is switched either way.
  }
  await refreshModelStatus();

  const whisperModel = fallbackWhisperModel();
  // Written directly as well, so the switch holds even if the page that started
  // the test has been closed and its settings setter is gone.
  try {
    localStorage.setItem("localTranscriptionProvider", "whisper");
    localStorage.setItem("whisperModel", whisperModel);
  } catch {
    // applyEngine below still updates the settings.
  }
  applyEngine({ localTranscriptionProvider: "whisper", whisperModel });
  update({ speedTest: "failed", fellBackToWhisper: true });
}

interface UseParakeetSetupOptions {
  spokenLanguages: readonly string[];
  localTranscriptionProvider: LocalTranscriptionProvider;
  applyEngine: (change: EngineChange) => void;
}

export function useParakeetSetup({
  spokenLanguages,
  localTranscriptionProvider,
  applyEngine,
}: UseParakeetSetupOptions) {
  const shared = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const applyEngineRef = useRef(applyEngine);
  useEffect(() => {
    applyEngineRef.current = applyEngine;
  }, [applyEngine]);
  const apply = useCallback((change: EngineChange) => applyEngineRef.current(change), []);

  const {
    downloadingModel,
    downloadProgress,
    isInstalling,
    isCancelling,
    failedModel,
    downloadModel,
    deleteModel,
    cancelDownload,
    retryDownload,
  } = useModelDownload({ modelType: "parakeet" });

  useEffect(() => {
    void ensureDetection();
    void refreshModelStatus();
  }, []);

  // Empty spoken set: navigator.language (the UI locale) stands in, see languagesToCheck.
  const uiLocale = typeof navigator !== "undefined" ? navigator.language : "";
  const fit: ParakeetFit | null = useMemo(
    () =>
      shared.detectionDone
        ? evaluateParakeetFit(shared.recommendations, spokenLanguages, uiLocale)
        : null,
    [shared.detectionDone, shared.recommendations, spokenLanguages, uiLocale]
  );

  const afterDownload = useCallback(async () => {
    const downloaded = await refreshModelStatus();
    if (downloaded) await runSpeedTestFlow(apply);
  }, [apply]);

  const downloadParakeet = useCallback(() => {
    void downloadModel(PARAKEET_MODEL_ID, () => void afterDownload());
  }, [downloadModel, afterDownload]);

  /** Switch to Parakeet; test it when it is already on disk and has no passing result. */
  const selectParakeet = useCallback(
    async ({ byUser = true }: { byUser?: boolean } = {}) => {
      if (byUser) update({ engineChosenByUser: true });
      update({ fellBackToWhisper: false });
      apply({ localTranscriptionProvider: "nvidia" });
      const downloaded = await refreshModelStatus();
      if (downloaded && !speedTestKeepsParakeet(state.lastResult)) {
        await runSpeedTestFlow(apply);
      }
      return downloaded;
    },
    [apply]
  );

  const selectWhisper = useCallback(
    ({ byUser = true }: { byUser?: boolean } = {}) => {
      if (byUser) update({ engineChosenByUser: true });
      apply({ localTranscriptionProvider: "whisper" });
    },
    [apply]
  );

  /** The offer card's button: switch, download, then the speed test. */
  const tryParakeet = useCallback(async () => {
    const downloaded = await selectParakeet();
    if (!downloaded) downloadParakeet();
  }, [selectParakeet, downloadParakeet]);

  const deleteParakeet = useCallback(async () => {
    await deleteModel(PARAKEET_MODEL_ID, () => void refreshModelStatus());
  }, [deleteModel]);

  const isDownloading = downloadingModel === PARAKEET_MODEL_ID;
  const hasPassed = speedTestKeepsParakeet(shared.lastResult);
  const usingParakeet = localTranscriptionProvider === "nvidia";

  return {
    fit,
    detectionDone: shared.detectionDone,
    recommendations: shared.recommendations,
    modelDownloaded: shared.modelDownloaded,
    isDownloading,
    downloadProgress,
    isInstalling,
    isCancelling,
    downloadFailed: failedModel === PARAKEET_MODEL_ID,
    retryDownload,
    cancelDownload,
    speedTest: shared.speedTest,
    lastResult: shared.lastResult,
    lastResultText: formatSpeedTestResult(shared.lastResult),
    fellBackToWhisper: shared.fellBackToWhisper,
    engineChosenByUser: shared.engineChosenByUser,
    /** Parakeet is in use, on disk and has passed the speed test on this PC. */
    ready:
      usingParakeet &&
      shared.modelDownloaded === true &&
      hasPassed &&
      shared.speedTest !== "running" &&
      !isDownloading,
    selectParakeet,
    selectWhisper,
    downloadParakeet,
    tryParakeet,
    deleteParakeet,
  };
}

export type ParakeetSetup = ReturnType<typeof useParakeetSetup>;
