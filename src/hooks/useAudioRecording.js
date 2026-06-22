import React, { useState, useEffect, useRef, useCallback } from "react";
import AudioManager from "../helpers/audioManager";
import { getDictionaryRepairTerms, parseDictionaryEntryModes } from "../utils/dictionaryEntryModes";

export const useAudioRecording = (toast, options = {}) => {
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [longSession, setLongSession] = useState({ active: false });
  const [transcript, setTranscript] = useState("");
  const audioManagerRef = useRef(null);
  const toastRef = useRef(toast);
  const onToggleRef = useRef(options.onToggle);

  useEffect(() => {
    toastRef.current = toast;
  }, [toast]);

  useEffect(() => {
    onToggleRef.current = options.onToggle;
  }, [options.onToggle]);

  useEffect(() => {
    const manager = new AudioManager();
    // Wire Pro entitlement check so correction hints are gated
    manager._checkProEntitlement = () => {
      try {
        // Dynamic import avoids circular dependency with TS hooks
        const { getEffectiveEntitlement } = require("../hooks/useProStatus");
        return getEffectiveEntitlement() === "pro";
      } catch {
        return false;
      }
    };
    audioManagerRef.current = manager;
    let disposed = false;
    const correctionIntervalIds = new Set();
    const HYBRID_HOLD_THRESHOLD_MS = 150;
    let hybridKeyDownAt = 0;
    let hybridStartedFromIdle = false;
    let hybridWasRecordingOnKeyDown = false;

    const clearCorrectionInterval = (intervalId) => {
      clearInterval(intervalId);
      correctionIntervalIds.delete(intervalId);
    };

    // ── Audio ducking helpers ────────────────────────────────────────────────
    // Read settings directly from localStorage so this plain-JS hook doesn't
    // need to import the TypeScript useSettings hook.
    let isDucked = false;

    const duckAudio = () => {
      const mode = localStorage.getItem("musicDuckingMode") || "off";
      if (mode === "off") return;
      const duckLevel = parseFloat(localStorage.getItem("musicDuckLevel") || "0.2");
      window.electronAPI?.duckSystemAudio?.({ mode, duckLevel });
      isDucked = true;
    };

    const restoreAudio = () => {
      if (!isDucked) return;
      window.electronAPI?.restoreSystemAudio?.();
      isDucked = false;
    };

    // ── Media pause helpers ──────────────────────────────────────────────────
    // Pause playing media (Spotify, browser video, etc.) when recording starts
    // so it doesn't bleed into the transcription. The main process tracks
    // whether media was actually paused, so resumeMedia() is a safe no-op if
    // nothing was playing.
    let mediaPauseRequested = false;

    const pauseMedia = () => {
      const pauseSetting = localStorage.getItem("pauseMediaOnRecord");
      if (pauseSetting !== "true" && pauseSetting !== "1" && pauseSetting !== "on") {
        return;
      }
      window.electronAPI?.mediaPause?.();
      mediaPauseRequested = true;
    };

    const resumeMedia = () => {
      if (!mediaPauseRequested) return;
      mediaPauseRequested = false;
      window.electronAPI?.mediaResume?.();
    };

    // ── Audio feedback helper ─────────────────────────────────────────────────
    const playFeedback = (sound) => {
      const enabled = localStorage.getItem("audioFeedback") === "true";
      if (!enabled) return;
      import("../utils/audioFeedback").then((m) => m[sound]()).catch(() => {});
    };

    manager.setCallbacks({
      onStateChange: ({ isRecording, isProcessing, longSession }) => {
        if (disposed) {
          return;
        }
        setIsRecording(isRecording);
        setIsProcessing(isProcessing);
        setLongSession(longSession || { active: false });
      },
      onError: (error) => {
        if (disposed) {
          return;
        }
        toastRef.current?.({
          title: error.title,
          description: error.description,
          variant: "destructive",
        });

        // Error notification (system-level)
        const showErrorNotif = localStorage.getItem("errorNotifications") === "true";
        if (showErrorNotif && window.electronAPI?.showNotification) {
          window.electronAPI.showNotification(
            "Transcription Error",
            error.description || error.title || "Transcription failed"
          );
        }

        // Show control panel on error
        const openPanel = localStorage.getItem("showPanelOnError") === "true";
        if (openPanel && window.electronAPI?.openControlPanel) {
          window.electronAPI.openControlPanel();
        }

        // Notify main process that dictation ended (even on error).
        // When overlay is disabled, this triggers the window to be destroyed.
        window.electronAPI?.notifyDictationCompleted?.().catch(() => {});
      },
      onTranscriptionComplete: async (result, commitContext = {}) => {
        // Always restore audio when transcription finishes (safety net)
        restoreAudio();
        resumeMedia();

        const canCommit = () =>
          !disposed && (typeof commitContext.isCurrent !== "function" || commitContext.isCurrent());

        if (!canCommit() || !result.success) {
          return;
        }

        const rawText = result.text || "";
        if (!rawText.trim()) {
          return;
        }

        let text = rawText;

        // Privacy-first variable/file snapping (local only):
        // - Uses user dictionary + correction memory to snap phrases to exact identifiers.
        try {
          const enableSnapping =
            (localStorage.getItem("enableVariableSnapping") || "true") === "true";
          if (enableSnapping) {
            const { snapTranscript } = await import("../utils/tokenSnapper");
            const dictionaryWords = (() => {
              try {
                const stored = localStorage.getItem("customDictionary");
                const parsed = stored ? JSON.parse(stored) : [];
                return Array.isArray(parsed) ? parsed : [];
              } catch {
                return [];
              }
            })();
            const snapWords = getDictionaryRepairTerms(
              dictionaryWords,
              parseDictionaryEntryModes(localStorage.getItem("dictionaryEntryModes"))
            );
            const corrections = await window.electronAPI?.getCorrectionMemory?.(200);
            text = snapTranscript({ transcript: rawText, dictionaryWords: snapWords, corrections });
          }
        } catch {
          // Non-fatal: snapping is best-effort.
        }

        if (!canCommit()) {
          return;
        }

        setTranscript(text);

        // ── Action Engine ──────────────────────────────────────────────────────
        // Check whether the final transcript triggers any user-configured action.
        // When one or more actions match, execute them and suppress the default
        // paste/copy behaviour - the utterance was a voice command, not dictation
        // content.  If the IPC call is unavailable or throws, fall through to the
        // normal paste path so that dictation is never silently blocked.
        let actionHandled = false;
        try {
          const aeEnabled = localStorage.getItem("actionEngineEnabled") !== "false";
          if (aeEnabled && window.electronAPI?.actionEngineMatch) {
            const matchResult = await window.electronAPI.actionEngineMatch(text);
            if (!canCommit()) {
              return;
            }
            if (
              matchResult?.success &&
              Array.isArray(matchResult.matches) &&
              matchResult.matches.length > 0
            ) {
              actionHandled = true;
              for (const { action } of matchResult.matches) {
                if (!canCommit()) {
                  return;
                }
                const execResult = await window.electronAPI?.actionEngineExecute?.(action.id, {
                  triggeredBy: "transcript",
                  triggerText: text,
                });
                if (!canCommit()) {
                  return;
                }
                if (execResult && !execResult.success) {
                  toastRef.current?.({
                    title: `Action failed: ${action.name}`,
                    description: execResult.error || "Unknown error.",
                    variant: "destructive",
                    duration: 4000,
                  });
                }
              }
              const names = matchResult.matches.map(({ action }) => action.name).join(", ");
              if (!canCommit()) {
                return;
              }
              toastRef.current?.({
                title: "Action triggered",
                description: names,
                variant: "default",
                duration: 2000,
              });
            }
          }
        } catch {
          // Non-fatal: action engine errors must never block dictation.
        }
        // ── End Action Engine ──────────────────────────────────────────────────

        // Respect behavior settings
        const shouldPaste = (localStorage.getItem("autoPaste") ?? "true") !== "false";
        const shouldCopy = (localStorage.getItem("copyToClipboard") ?? "true") !== "false";

        if (!actionHandled) {
          if (!canCommit()) {
            return;
          }
          if (shouldPaste) {
            await manager.safePaste(text);
            if (!canCommit()) {
              return;
            }
            // If "copy to clipboard" is also on, re-write the transcription after paste
            // (safePaste restores the original clipboard; this ensures the text stays in it)
            if (shouldCopy && window.electronAPI?.writeClipboard) {
              await window.electronAPI.writeClipboard(text);
            }
          } else if (shouldCopy && window.electronAPI?.writeClipboard) {
            await window.electronAPI.writeClipboard(text);
          }
        }

        // Success confirmation notification (skipped for action triggers - those
        // show their own "Action triggered" toast above)
        const showSuccess = localStorage.getItem("successConfirmation") === "true";
        if (!canCommit()) {
          return;
        }
        if (showSuccess && !actionHandled) {
          toastRef.current?.({
            title: "Transcription complete",
            description: text.length > 80 ? text.slice(0, 80) + "…" : text,
            variant: "default",
            duration: 2000,
          });
        }

        // Correction memory: only surface the learn action after the user has actually
        // copied a changed version, not after every transcription.
        try {
          const enableLearning =
            (localStorage.getItem("enableCorrectionLearning") || "false") === "true";
          if (
            enableLearning &&
            window.electronAPI?.readClipboard &&
            window.electronAPI?.confirmCorrection
          ) {
            const { inferCorrectionPairs } = await import("../utils/tokenSnapper");
            const insertedText = text;
            const startedAt = Date.now();
            const timeoutMs = 30000;
            let lastClipboard = await window.electronAPI.readClipboard();
            let prompted = false;

            const intervalId = setInterval(async () => {
              if (!canCommit()) {
                clearCorrectionInterval(intervalId);
                return;
              }
              if (Date.now() - startedAt > timeoutMs || prompted) {
                clearCorrectionInterval(intervalId);
                return;
              }

              const current = await window.electronAPI.readClipboard();
              if (!canCommit()) {
                clearCorrectionInterval(intervalId);
                return;
              }
              if (!current || current === lastClipboard) return;
              lastClipboard = current;

              const pairs = inferCorrectionPairs(insertedText, current);
              if (pairs.length === 0) return;
              prompted = true;
              clearCorrectionInterval(intervalId);

              toastRef.current?.({
                title: "Teach Correction Memory",
                description: "Copied correction detected. Click Learn to save it.",
                duration: 12000,
                action: React.createElement(
                  "button",
                  {
                    className:
                      "rounded-[6px] border border-primary/30 bg-primary/10 px-2 py-1 text-[11px] font-medium text-primary hover:bg-primary/15",
                    onClick: async () => {
                      try {
                        for (const p of pairs) {
                          await window.electronAPI.confirmCorrection(p.source, p.target);
                        }

                        try {
                          const dict = await window.electronAPI.getDictionary();
                          const set = new Set(Array.isArray(dict) ? dict : []);
                          let changed = false;
                          for (const p of pairs) {
                            if (p.target && p.target.length <= 200 && !set.has(p.target)) {
                              set.add(p.target);
                              changed = true;
                            }
                          }
                          if (changed) {
                            const next = Array.from(set);
                            await window.electronAPI.setDictionary(next);
                            localStorage.setItem("customDictionary", JSON.stringify(next));
                          }
                        } catch {
                          // ignore dictionary promotion failures
                        }

                        toastRef.current?.({
                          title: "Learned correction",
                          description: "PrivateTranscribe will use that correction next time.",
                          variant: "success",
                          duration: 4000,
                        });
                      } catch {
                        toastRef.current?.({
                          title: "Could not learn correction",
                          description: "Try again after copying the corrected text.",
                          variant: "destructive",
                          duration: 4000,
                        });
                      }
                    },
                  },
                  "Learn"
                ),
              });
            }, 750);
            correctionIntervalIds.add(intervalId);
          }
        } catch {
          // ignore
        }

        // Only save to history if the user hasn't disabled history entirely
        const historyLimitRaw = localStorage.getItem("historyLimit");
        const historyLimit = historyLimitRaw !== null ? parseInt(historyLimitRaw, 10) : 50;
        if (canCommit() && (isNaN(historyLimit) || historyLimit > 0)) {
          void manager.saveTranscription(text, result.durationSeconds);
        }

        if (
          canCommit() &&
          (result.source === "openai" || result.source === "openai-fallback") &&
          localStorage.getItem("useLocalWhisper") === "true"
        ) {
          toastRef.current?.({
            title: "Fallback Mode",
            description: "Local Whisper failed. Used OpenAI API instead.",
            variant: "default",
          });
        }

        // Notify main process that dictation is complete.
        // When overlay is disabled, this triggers the window to be destroyed
        // so it doesn't cause DWM lag while gaming.
        window.electronAPI?.notifyDictationCompleted?.().catch(() => {});
      },
    });

    // Set up hotkey listener for tap-to-talk mode
    const handleToggle = () => {
      const currentState = manager.getState();

      if (
        !currentState.isRecording &&
        !currentState.isProcessing &&
        !currentState.isStartingRecording
      ) {
        void beginRecordingFlow({ playSound: true });
      } else if (currentState.isRecording || currentState.isStartingRecording) {
        endRecordingFlow({ playSound: true });
      }
    };

    // Set up listener for push-to-talk start
    const handleStart = () => {
      const currentState = manager.getState();
      if (
        !currentState.isRecording &&
        !currentState.isProcessing &&
        !currentState.isStartingRecording
      ) {
        void beginRecordingFlow({ playSound: true });
      }
    };

    // Set up listener for push-to-talk stop
    const handleStop = () => {
      // Always restore audio when push-to-talk key is released,
      // even if recording didn't fully start (quick tap race condition)
      endRecordingFlow({ playSound: true });
    };

    const handleHybridKeyDown = () => {
      if (hybridKeyDownAt > 0) {
        return;
      }

      const currentState = manager.getState();
      hybridKeyDownAt = Date.now();
      hybridWasRecordingOnKeyDown = currentState.isRecording || currentState.isStartingRecording;
      hybridStartedFromIdle = false;

      if (
        !currentState.isRecording &&
        !currentState.isProcessing &&
        !currentState.isStartingRecording
      ) {
        hybridStartedFromIdle = true;
        void beginRecordingFlow({ playSound: true });
      }
    };

    const handleHybridKeyUp = () => {
      if (hybridKeyDownAt <= 0) {
        return;
      }

      const heldMs = Date.now() - hybridKeyDownAt;
      const shouldStop =
        hybridWasRecordingOnKeyDown ||
        (hybridStartedFromIdle && heldMs >= HYBRID_HOLD_THRESHOLD_MS);

      hybridKeyDownAt = 0;
      hybridStartedFromIdle = false;
      hybridWasRecordingOnKeyDown = false;

      if (shouldStop) {
        endRecordingFlow({ playSound: true });
      }
    };

    const disposeToggle = window.electronAPI.onToggleDictation(() => {
      handleToggle();
      onToggleRef.current?.();
    });

    const disposeStart = window.electronAPI.onStartDictation?.(() => {
      handleStart();
      onToggleRef.current?.();
    });

    const disposeStop = window.electronAPI.onStopDictation?.(() => {
      handleStop();
      onToggleRef.current?.();
    });

    const disposeHybridKeyDown = window.electronAPI.onHybridDictationKeyDown?.(() => {
      handleHybridKeyDown();
      onToggleRef.current?.();
    });

    const disposeHybridKeyUp = window.electronAPI.onHybridDictationKeyUp?.(() => {
      handleHybridKeyUp();
      onToggleRef.current?.();
    });

    const handleNoAudioDetected = () => {
      toastRef.current?.({
        title: "No Audio Detected",
        description: "The recording contained no detectable audio. Please try again.",
        variant: "default",
      });
    };

    const disposeNoAudio = window.electronAPI.onNoAudioDetected?.(handleNoAudioDetected);

    const beginRecordingFlow = async ({ playSound = false } = {}) => {
      const currentState = manager.getState();
      if (
        currentState.isRecording ||
        currentState.isProcessing ||
        currentState.isStartingRecording
      ) {
        return false;
      }

      if (playSound) {
        playFeedback("playStartSound");
      }
      duckAudio();
      pauseMedia();
      try {
        const started = await manager.startRecording();
        if (!started) {
          restoreAudio();
          resumeMedia();
        }
        return started;
      } catch (error) {
        restoreAudio();
        resumeMedia();
        throw error;
      }
    };

    const endRecordingFlow = ({ playSound = false } = {}) => {
      const currentState = manager.getState();
      if (!currentState.isRecording && !currentState.isStartingRecording) {
        restoreAudio();
        resumeMedia();
        return false;
      }

      if (playSound) {
        playFeedback("playStopSound");
      }
      const stopped = manager.stopRecording();
      restoreAudio();
      resumeMedia();
      return stopped;
    };

    // Cleanup
    return () => {
      disposed = true;
      disposeToggle?.();
      disposeStart?.();
      disposeStop?.();
      disposeHybridKeyDown?.();
      disposeHybridKeyUp?.();
      disposeNoAudio?.();
      for (const intervalId of correctionIntervalIds) {
        clearInterval(intervalId);
      }
      correctionIntervalIds.clear();
      manager.cleanup();
      if (audioManagerRef.current === manager) {
        audioManagerRef.current = null;
      }
    };
  }, []);

  const startRecording = useCallback(async () => {
    if (!audioManagerRef.current) {
      return false;
    }

    const currentState = audioManagerRef.current.getState();
    if (currentState.isRecording || currentState.isProcessing || currentState.isStartingRecording) {
      return false;
    }

    const audioFeedbackEnabled = localStorage.getItem("audioFeedback") === "true";
    if (audioFeedbackEnabled) {
      import("../utils/audioFeedback").then((m) => m.playStartSound()).catch(() => {});
    }

    const mode = localStorage.getItem("musicDuckingMode") || "off";
    if (mode !== "off") {
      const duckLevel = parseFloat(localStorage.getItem("musicDuckLevel") || "0.2");
      window.electronAPI?.duckSystemAudio?.({ mode, duckLevel });
    }

    const pauseSetting = localStorage.getItem("pauseMediaOnRecord");
    if (pauseSetting === "true" || pauseSetting === "1" || pauseSetting === "on") {
      window.electronAPI?.mediaPause?.();
    }

    try {
      const started = await audioManagerRef.current.startRecording();
      if (!started) {
        window.electronAPI?.restoreSystemAudio?.();
        window.electronAPI?.mediaResume?.();
      }
      return started;
    } catch (error) {
      window.electronAPI?.restoreSystemAudio?.();
      window.electronAPI?.mediaResume?.();
      throw error;
    }
  }, []);

  const stopRecording = useCallback(() => {
    if (!audioManagerRef.current) {
      return false;
    }

    const currentState = audioManagerRef.current.getState();
    if (!currentState.isRecording && !currentState.isStartingRecording) {
      window.electronAPI?.restoreSystemAudio?.();
      window.electronAPI?.mediaResume?.();
      return false;
    }

    const audioFeedbackEnabled = localStorage.getItem("audioFeedback") === "true";
    if (audioFeedbackEnabled) {
      import("../utils/audioFeedback").then((m) => m.playStopSound()).catch(() => {});
    }

    const stopped = audioManagerRef.current.stopRecording();
    window.electronAPI?.restoreSystemAudio?.();
    window.electronAPI?.mediaResume?.();
    return stopped;
  }, []);

  const cancelRecording = useCallback(() => {
    try {
      if (audioManagerRef.current) {
        return audioManagerRef.current.cancelRecording();
      }
      return false;
    } finally {
      window.electronAPI?.restoreSystemAudio?.();
      window.electronAPI?.mediaResume?.();
      // Notify main process that dictation was cancelled.
      // When overlay is disabled, this triggers the window to be destroyed.
      window.electronAPI?.notifyDictationCompleted?.().catch(() => {});
    }
  }, []);

  const cancelProcessing = useCallback(() => {
    try {
      if (audioManagerRef.current) {
        return audioManagerRef.current.cancelProcessing();
      }
      return false;
    } finally {
      // Notify main process that dictation was cancelled.
      // When overlay is disabled, this triggers the window to be destroyed.
      window.electronAPI?.notifyDictationCompleted?.().catch(() => {});
    }
  }, []);

  const toggleListening = useCallback(() => {
    const manager = audioManagerRef.current;
    if (!manager) {
      return;
    }

    const currentState = manager.getState();
    if (
      !currentState.isRecording &&
      !currentState.isProcessing &&
      !currentState.isStartingRecording
    ) {
      void startRecording();
    } else if (currentState.isRecording || currentState.isStartingRecording) {
      stopRecording();
    }
  }, [startRecording, stopRecording]);

  return {
    isRecording,
    isProcessing,
    longSession,
    transcript,
    startRecording,
    stopRecording,
    cancelRecording,
    cancelProcessing,
    toggleListening,
    audioManagerRef,
  };
};
