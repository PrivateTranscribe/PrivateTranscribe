import React, { useState, useEffect, useRef, useCallback } from "react";
import AudioManager, { MISSING_SECTION_MARKER } from "../helpers/audioManager";
import { cleanAgentPrompt, extractSendCommand } from "../utils/agentPrompt";
import ReasoningService from "../services/ReasoningService";
import {
  buildTranscriptionAnalyticsProperties,
  trackAnalyticsEvent,
  trackAnalyticsEventOnce,
} from "../utils/analytics";
import { isFeatureUnlocked } from "../utils/betaFeatures";
import { deliverDictation } from "../utils/dictationDelivery";
import { formatHotkeyLabel, readStoredHotkey } from "../utils/hotkeys";

/**
 * Whether a voice-mute attempt failed in a way the user needs to hear about.
 *
 * Only two outcomes qualify. "no-call" and "no-key" are the ordinary quiet
 * cases — warning on those would put a toast in front of anyone who dictates
 * while not in a call, which is most dictations. "hold-failed" and "error" are
 * different: the app decided a call was live, tried to mute it, and could not.
 */
export const shouldWarnAboutFailedMute = (result) => {
  if (!result || result.muted) return false;
  return result.reason === "hold-failed" || result.reason === "error";
};

/**
 * The toast to show when the clipboard changed after a dictation but auto-learn
 * refused the correction, or null to stay silent.
 *
 * Same principle as the mute warning above. The user copies things during the 30s
 * poll window that have nothing to do with correcting the dictation, and answering
 * every one of them trains people to ignore the toast that matters.
 *
 * Only "token-count-changed" earns a reply. That is a real correction attempt that
 * missed by a word, the user gets nothing back today, and there is a specific setting
 * that would have learned it. Everything else stays silent:
 *
 * - "too-different" / "mostly-deleted": ordinary clipboard use, or a cleared field.
 * - "no-learnable-span": phrase learning is already on, so there is nothing to suggest.
 * - "too-long": a 30+ word edit is not a word fix anyone is waiting on.
 * - "no-change": nothing actually changed.
 */
export const getCorrectionRejectionNotice = (reason) => {
  if (reason !== "token-count-changed") return null;
  return {
    title: "Couldn't learn that correction",
    description:
      'That edit adds or removes words, and auto-learn only handles word-for-word fixes. Turn on "Learn phrase and sentence rewrites" under Correction Memory on the Dictionary page to learn bigger edits.',
    variant: "default",
    duration: 8000,
  };
};

export const useAudioRecording = (toast, options = {}) => {
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [longSession, setLongSession] = useState({ active: false });
  const [transcript, setTranscript] = useState("");
  /** Mirrors the in-effect agentSession flag so the overlay can badge it. */
  const [isAgentSession, setIsAgentSession] = useState(false);
  /**
   * Separate from isProcessing because the two end at different moments: the
   * recorder owns isProcessing, and the Claude Code rewrite runs inside the
   * completion callback, after the transcript exists and with its own cancel.
   */
  const [isRewriting, setIsRewriting] = useState(false);
  const audioManagerRef = useRef(null);
  const toastRef = useRef(toast);
  const onToggleRef = useRef(options.onToggle);
  /**
   * The one begin/end recording flow, published out of the effect that owns the
   * AudioManager so the button goes through exactly what the hotkey does.
   *
   * There used to be a second copy of the flow out here for the button, and it
   * ducked the system volume without the latch the first one had. Spamming the
   * button was then two flows racing over one volume.
   */
  const recordingFlowRef = useRef(null);
  /**
   * Published out of the effect for the same reason: cancelRecording and
   * cancelProcessing live out here and have to be able to clear the flag.
   */
  const clearAgentSessionRef = useRef(null);

  useEffect(() => {
    toastRef.current = toast;
  }, [toast]);

  useEffect(() => {
    onToggleRef.current = options.onToggle;
  }, [options.onToggle]);

  useEffect(() => {
    const manager = new AudioManager();
    // Beta features stay off in the recorder until the user turns them on in Settings.
    manager._checkBetaFeatureAccess = (featureId) => {
      try {
        return isFeatureUnlocked(featureId);
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
    /**
     * Whether the recording in flight, or the processing after it, started with
     * Agent mode enabled in settings. A stale true would push the NEXT plain dictation
     * through the rules pass and press Enter on it, so every path that ends a
     * session without reaching onTranscriptionComplete clears it.
     */
    let agentSession = false;

    const setAgentSession = (active) => {
      agentSession = Boolean(active);
      // The shortcut rewrites once, after splitting the spoken send command.
      // Ordinary dictation cleanup would otherwise consume or rewrite it first.
      manager.codingPromptSession = agentSession;
      setIsAgentSession(agentSession);
      if (!agentSession) setIsRewriting(false);
    };

    const clearCorrectionInterval = (intervalId) => {
      clearInterval(intervalId);
      correctionIntervalIds.delete(intervalId);
    };

    const isBetaFeatureUnlocked = (featureId) => {
      try {
        return isFeatureUnlocked(featureId);
      } catch {
        return false;
      }
    };

    // ── Audio ducking helpers ────────────────────────────────────────────────
    // Read settings directly from localStorage so this plain-JS hook doesn't
    // need to import the TypeScript useSettings hook.
    const duckAudio = () => {
      const mode = localStorage.getItem("musicDuckingMode") || "off";
      if (mode === "off") return;
      const duckLevel = parseFloat(localStorage.getItem("musicDuckLevel") || "0.2");
      window.electronAPI?.duckSystemAudio?.({ mode, duckLevel });
    };

    // No "did we duck?" latch on this side. The main process is the only thing
    // that knows whether the volume is actually down, restoring is a no-op when
    // it is not, and a latch that got out of step here was one more way to end
    // a dictation with the volume still lowered.
    const restoreAudio = () => {
      window.electronAPI?.restoreSystemAudio?.();
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

    // ── Voice-call mute helpers ──────────────────────────────────────────────
    // Hold the voice app's push-to-mute key while recording so a Discord call
    // doesn't hear the dictation. The main process decides whether a call is
    // actually happening and only releases a key it holds, so unmute is a safe
    // no-op when nothing was muted.
    let voiceMuteRequested = false;

    const muteVoiceCall = () => {
      if (localStorage.getItem("muteVoiceCallOnRecord") !== "true") return;
      const key = readStoredHotkey(localStorage.getItem("voiceCallMuteKey"));
      if (!key) return;
      voiceMuteRequested = true;

      // A mute that does not happen has to be visible. Being outside a call is
      // the ordinary case and stays quiet, but a key the helper could not send
      // means the user is talking into a live call in the belief that nobody
      // can hear them. Staying silent about that is the one failure this whole
      // feature exists to prevent.
      Promise.resolve(window.electronAPI?.voiceMuteStart?.({ key }))
        .then((result) => {
          if (disposed || !shouldWarnAboutFailedMute(result)) return;
          toastRef.current?.({
            title: "Your call was not muted",
            description: `PrivateTranscribe could not send ${formatHotkeyLabel(key)} to your voice app, so the call can hear this dictation. Check the mute key in Settings.`,
            variant: "destructive",
            duration: 10000,
          });
        })
        .catch(() => {
          // The mute is best effort; a broken IPC bridge must not stop recording.
        });
    };

    const unmuteVoiceCall = () => {
      if (!voiceMuteRequested) return;
      voiceMuteRequested = false;
      window.electronAPI?.voiceMuteStop?.();
    };

    // ── Audio feedback helper ─────────────────────────────────────────────────
    const playFeedback = (sound) => {
      const enabled = localStorage.getItem("audioFeedback") === "true";
      if (!enabled) return;
      import("../utils/audioFeedback").then((m) => m[sound]()).catch(() => {});
    };

    // ── Cold-start feedback ───────────────────────────────────────────────────
    // The first dictation after launch pays the whisper model load, which can
    // run long enough to read as a hang behind the overlay's generic processing
    // state. When the first local transcription is still working after a few
    // seconds, say what is actually happening - once per app session.
    let firstTranscriptionDone = false;
    let coldStartTimer = null;
    const clearColdStartTimer = () => {
      if (coldStartTimer) {
        clearTimeout(coldStartTimer);
        coldStartTimer = null;
      }
    };

    manager.setCallbacks({
      onStateChange: ({ isRecording, isProcessing, longSession }) => {
        if (disposed) {
          return;
        }
        if (isProcessing && !firstTranscriptionDone && !coldStartTimer) {
          coldStartTimer = setTimeout(() => {
            coldStartTimer = null;
            if (disposed || firstTranscriptionDone) return;
            if (localStorage.getItem("useLocalWhisper") !== "true") return;
            toastRef.current?.({
              title: "Loading the speech model",
              description:
                "The first dictation after launch takes longer while the model loads. The next ones are fast.",
              variant: "default",
              duration: 8000,
            });
          }, 4000);
        } else if (!isProcessing) {
          clearColdStartTimer();
        }
        setIsRecording(isRecording);
        setIsProcessing(isProcessing);
        setLongSession(longSession || { active: false });
      },
      onError: (error) => {
        if (disposed) {
          return;
        }
        setAgentSession(false);
        // A missing model or engine binary is a setup problem the overlay
        // cannot fix. Put the way out on the toast itself instead of naming
        // Settings and leaving the user to go find the right page.
        const isSetupError = /not downloaded|binary not found/i.test(
          `${error.title ?? ""} ${error.description ?? ""}`
        );
        toastRef.current?.({
          title: error.title,
          description: error.description,
          variant: "destructive",
          ...(isSetupError && {
            duration: 12000,
            action: React.createElement(
              "button",
              {
                className:
                  "rounded-[6px] border border-primary/30 bg-primary/10 px-2 py-1 text-[11px] font-medium text-primary hover:bg-primary/15",
                onClick: () => {
                  window.electronAPI?.openControlPanel?.({
                    page: "settings",
                    settingsTab: "transcription",
                  });
                },
              },
              "Open Settings"
            ),
          }),
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
        // Read and cleared before any early return, so an abandoned completion
        // cannot leave the flag set for the next dictation.
        const wasAgentSession = agentSession;
        setAgentSession(false);
        clearColdStartTimer();
        if (result.success) {
          // The model is loaded now; later dictations don't need the hint.
          firstTranscriptionDone = true;
        }
        // Always restore audio when transcription finishes (safety net)
        restoreAudio();
        resumeMedia();
        unmuteVoiceCall();

        const canCommit = () =>
          !disposed && (typeof commitContext.isCurrent !== "function" || commitContext.isCurrent());

        if (!canCommit() || !result.success) {
          return { recoverable: false, reason: "Dictation completion was canceled" };
        }

        const rawText = result.text || "";
        if (!rawText.trim()) {
          return { recoverable: false, reason: "No usable transcription text was produced" };
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
            const corrections = isBetaFeatureUnlocked("correction-memory")
              ? await window.electronAPI?.getCorrectionMemory?.(200)
              : [];
            text = snapTranscript({ transcript: rawText, dictionaryWords, corrections });
          }
        } catch {
          // Non-fatal: snapping is best-effort.
        }

        if (!canCommit()) {
          return;
        }

        let sendEnter = false;
        if (wasAgentSession) {
          // The send word is decided here, not by the model, so Enter never depends on
          // what the rewrite did with the tail.
          const { text: spoken, send } = extractSendCommand(text);
          sendEnter = send;
          const rewriteOn = localStorage.getItem("agentModeRewrite") !== "false";
          let rewritten = null;
          let failure = null;
          if (rewriteOn) {
            setIsRewriting(true);
            try {
              const useSharedConnection =
                localStorage.getItem("codingPromptUseSharedConnection") === "true";
              let reply;
              if (useSharedConnection) {
                if (!isFeatureUnlocked("ai-enhancement")) {
                  throw new Error(
                    "Turn on beta features in Settings to use the shared connection."
                  );
                }
                const enhanced = await ReasoningService.processText(
                  spoken,
                  localStorage.getItem("reasoningModel") || "",
                  null,
                  {
                    writingStyle: "coding",
                    preferredLanguage: localStorage.getItem("preferredLanguage"),
                    smartContext: null,
                    timeoutMs: 12000,
                    maxRetries: 0,
                  }
                );
                reply = { ok: true, text: enhanced };
              } else {
                reply = await window.electronAPI?.agentModeRewrite?.(spoken);
              }
              if (reply?.ok && typeof reply.text === "string" && reply.text.trim()) {
                rewritten = reply.text.trim();
              } else {
                failure = reply || { reason: "bad-output" };
              }
            } catch (error) {
              failure = { reason: "spawn-error", message: String(error?.message || error) };
            } finally {
              setIsRewriting(false);
            }
            if (!canCommit()) return;
          }
          if (rewritten !== null) {
            text = rewritten;
          } else {
            text = cleanAgentPrompt(spoken).text;
            // Nothing is said when the setting is off: the settings page already
            // explains what off means, so a toast would only repeat it every time.
            if (failure && failure.reason !== "disabled") {
              toastRef.current?.({
                title:
                  failure.reason === "not-found"
                    ? "Claude Code not found. Pasted as spoken."
                    : "Enhancement unavailable. Pasted as spoken.",
                variant: "default",
                duration: 5000,
              });
            }
          }
          // No analytics event here yet: event names are pinned by a database
          // check constraint, so a new one needs a Supabase migration first.
        }

        setTranscript(text);

        if (result.completeness?.reason === "failed-chunks") {
          const failed = result.completeness.failedChunks;
          const total = result.completeness.totalChunks;
          toastRef.current?.({
            title: "Part of this recording is missing",
            description: `${failed} of ${total} sections could not be transcribed. Each gap is marked "${MISSING_SECTION_MARKER}" in the text.`,
            variant: "destructive",
            duration: 12000,
          });
        } else if (result.completeness?.suspicious) {
          toastRef.current?.({
            title: "Transcription may be incomplete",
            description: "Review the transcription before using it.",
            variant: "default",
            duration: 8000,
          });
        }

        // ── Action Engine ──────────────────────────────────────────────────────
        // Check whether the final transcript triggers any user-configured action.
        // When one or more actions match, execute them and suppress the default
        // paste/copy behaviour - the utterance was a voice command, not dictation
        // content.  If the IPC call is unavailable or throws, fall through to the
        // normal paste path so that dictation is never silently blocked.
        let actionHandled = false;
        try {
          const aeEnabled = localStorage.getItem("actionEngineEnabled") !== "false";
          if (
            // A ramble aimed at a coding agent is never a voice command.
            !wasAgentSession &&
            aeEnabled &&
            isBetaFeatureUnlocked("action-engine") &&
            window.electronAPI?.actionEngineMatch
          ) {
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
        // Default false, matching useSettings: a fresh install pastes without
        // also overwriting the clipboard. Paste failure still copies (fallback
        // in deliverDictation is unconditional).
        const shouldCopy = localStorage.getItem("copyToClipboard") === "true";

        const historyLimitRaw = localStorage.getItem("historyLimit");
        const historyLimit = historyLimitRaw !== null ? parseInt(historyLimitRaw, 10) : 50;
        if (historyLimit === 0) {
          await manager.recordTranscriptionActivity(text, result.durationSeconds);
          if (!canCommit()) {
            return;
          }
        }
        const delivery = await deliverDictation({
          text,
          shouldPersist: isNaN(historyLimit) || historyLimit > 0,
          shouldPaste: !actionHandled && shouldPaste,
          shouldCopy: !actionHandled && shouldCopy,
          additionalConfirmedDelivery: actionHandled,
          persist: () => manager.saveTranscription(text, result.durationSeconds),
          paste: () => manager.safePaste(text, sendEnter ? { sendEnter: true } : {}),
          copy: (value) => window.electronAPI?.writeClipboard?.(value),
        });
        if (!canCommit()) {
          return;
        }

        // Delivery-failure feedback. These fire regardless of the success-toast
        // preference: a silently degraded delivery is indistinguishable from
        // the hotkey doing nothing, which reads as the app being broken.
        if (!delivery.recoverable) {
          // History, paste, and clipboard all failed - this toast is the only
          // surviving copy of the words, so show them and keep it up longer.
          toastRef.current?.({
            title: "Dictation could not be delivered",
            description: text.length > 200 ? text.slice(0, 200) + "…" : text,
            variant: "destructive",
            duration: 15000,
          });
        } else if (!actionHandled && shouldPaste && delivery.pasteConfirmed !== true) {
          if (!delivery.copied) {
            toastRef.current?.({
              title: "Saved to History only",
              description:
                "The text could not be pasted or copied. Open History in the control panel to get it.",
              variant: "destructive",
              duration: 8000,
            });
          } else if (!delivery.pasteDispatched && delivery.pasteEvidence !== "none") {
            // A dispatched shortcut can land even when accessible text is stale,
            // reformatted, truncated, or unchanged by replacing the selection.
            // Only report a fallback when dispatch itself failed. Unconfirmed
            // attempts still keep the transcript on the clipboard and in History.
            const pasteKey =
              (window.electronAPI?.getPlatform?.() ?? "win32") === "darwin" ? "Cmd+V" : "Ctrl+V";
            toastRef.current?.({
              title: "Text copied",
              description: `Automatic paste was unavailable. Click your text field and press ${pasteKey}.`,
              variant: "default",
              duration: 6000,
            });
          }
        }

        // Success confirmation notification (skipped for action triggers - those
        // show their own "Action triggered" toast above)
        const showSuccess = localStorage.getItem("successConfirmation") === "true";
        if (!canCommit()) {
          return;
        }
        if (showSuccess && !actionHandled && delivery.outputAction !== "copy-fallback") {
          toastRef.current?.({
            title: "Transcription complete",
            description: text.length > 80 ? text.slice(0, 80) + "…" : text,
            variant: "default",
            duration: 2000,
          });
        }

        const outputAction = actionHandled
          ? "action"
          : delivery.outputAction === "copy-fallback"
            ? "copy"
            : delivery.outputAction;
        const analyticsProperties = buildTranscriptionAnalyticsProperties({
          source: result.source,
          outputAction,
          text,
          durationSeconds: result.durationSeconds,
          // Non-English accuracy is materially worse, and worse still on the
          // smaller models. Without these two we cannot tell whether that
          // affects a handful of users or most of them.
          preferredLanguage: localStorage.getItem("preferredLanguage"),
          model: result.activeModel,
          computeMode: result.computeMode,
          transcriptionAudioDurationSeconds: result.timings?.transcriptionAudioDurationSeconds,
          // Inference time when the engine reported it, so the first dictation
          // after launch is not scored on its model load.
          transcriptionProcessingDurationMs:
            result.timings?.transcriptionInferenceDurationMs ??
            result.timings?.transcriptionProcessingDurationMs,
        });
        void trackAnalyticsEvent("transcription_completed", analyticsProperties);
        void trackAnalyticsEventOnce("first_transcription_completed", analyticsProperties);

        // Correction memory: only surface the learn action after the user copies
        // a changed version, not after every transcription.
        try {
          const enableLearning =
            (localStorage.getItem("enableCorrectionLearning") || "false") === "true";
          const allowPhraseLearning =
            (localStorage.getItem("enablePhraseCorrectionLearning") || "false") === "true";
          if (
            enableLearning &&
            isBetaFeatureUnlocked("correction-memory") &&
            window.electronAPI?.readClipboard &&
            window.electronAPI?.confirmCorrection
          ) {
            const { inferCorrectionPairs, explainCorrectionRejection } =
              await import("../utils/tokenSnapper");
            const insertedText = text;
            const startedAt = Date.now();
            const timeoutMs = 30000;
            let lastClipboard = await window.electronAPI.readClipboard();
            let prompted = false;
            // At most one "couldn't learn that" toast per dictation cycle, even though the
            // poll keeps running so a later word-for-word copy can still be learned.
            let explainedRejection = false;

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

              const pairs = inferCorrectionPairs(insertedText, current, {
                allowPhraseLearning,
              });
              if (pairs.length === 0) {
                // The clipboard did change, so the user made an edit and got nothing back.
                // Only answer the near-miss: a genuine word-level correction that added or
                // removed a word. "too-different" and "mostly-deleted" are ordinary clipboard
                // use (copying something unrelated, clearing a field), and "no-learnable-span"
                // means phrase learning is already on, so nagging there would fire on every
                // copy the user makes in the 30s window. Those stay silent by design.
                if (!explainedRejection) {
                  const notice = getCorrectionRejectionNotice(
                    explainCorrectionRejection(insertedText, current, { allowPhraseLearning })
                  );
                  if (notice) {
                    explainedRejection = true;
                    toastRef.current?.(notice);
                  }
                }
                return;
              }
              prompted = true;
              clearCorrectionInterval(intervalId);

              toastRef.current?.({
                title: "Teach Correction Memory",
                description: allowPhraseLearning
                  ? "Copied correction detected. Click Learn to save it."
                  : "Copied word correction detected. Click Learn to save it.",
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
                            const target = typeof p.target === "string" ? p.target.trim() : "";
                            if (
                              target &&
                              target.length <= 200 &&
                              !/\s/.test(target) &&
                              !set.has(target)
                            ) {
                              set.add(target);
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
        return {
          recoverable: delivery.recoverable,
          reason: delivery.recoverable ? null : "History, paste, and clipboard delivery failed",
        };
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

      // Read at session start so settings changes apply to the next recording.
      setAgentSession(localStorage.getItem("agentModeDictationEnabled") === "true");

      if (playSound) {
        playFeedback("playStartSound");
      }
      duckAudio();
      pauseMedia();
      muteVoiceCall();
      try {
        const started = await manager.startRecording();
        if (!started) {
          setAgentSession(false);
          restoreAudio();
          resumeMedia();
          unmuteVoiceCall();
        } else {
          void trackAnalyticsEvent("transcription_started");
        }
        return started;
      } catch (error) {
        setAgentSession(false);
        restoreAudio();
        resumeMedia();
        unmuteVoiceCall();
        throw error;
      }
    };

    const endRecordingFlow = ({ playSound = false } = {}) => {
      const currentState = manager.getState();
      if (!currentState.isRecording && !currentState.isStartingRecording) {
        restoreAudio();
        resumeMedia();
        unmuteVoiceCall();
        return false;
      }

      if (playSound) {
        playFeedback("playStopSound");
      }
      const stopped = manager.stopRecording();
      restoreAudio();
      resumeMedia();
      unmuteVoiceCall();
      return stopped;
    };

    recordingFlowRef.current = { begin: beginRecordingFlow, end: endRecordingFlow };
    clearAgentSessionRef.current = () => setAgentSession(false);

    // Cleanup
    return () => {
      disposed = true;
      clearColdStartTimer();
      recordingFlowRef.current = null;
      clearAgentSessionRef.current = null;
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

  /**
   * Start a dictation. Same flow the hotkey uses, on purpose: the button used
   * to run its own copy, and two copies meant two ducks, two media pauses and
   * no voice-call mute.
   */
  const startRecording = useCallback(async () => {
    const flow = recordingFlowRef.current;
    if (!flow) return false;
    return flow.begin({ playSound: true });
  }, []);

  const stopRecording = useCallback(() => {
    const flow = recordingFlowRef.current;
    if (!flow) return false;
    return flow.end({ playSound: true });
  }, []);

  const cancelRecording = useCallback(() => {
    try {
      if (audioManagerRef.current) {
        return audioManagerRef.current.cancelRecording();
      }
      return false;
    } finally {
      clearAgentSessionRef.current?.();
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
        // The renderer presents the recorder's short final-data flush as
        // processing so the voice meter can stop immediately. If Escape is
        // pressed during that window, preserve the user's cancel intent by
        // discarding the recording instead of asking a not-yet-started
        // transcription request to abort.
        if (audioManagerRef.current.getState().isStoppingRecording) {
          return audioManagerRef.current.cancelRecording();
        }
        return audioManagerRef.current.cancelProcessing();
      }
      return false;
    } finally {
      clearAgentSessionRef.current?.();
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
    isAgentSession,
    isRewriting,
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
