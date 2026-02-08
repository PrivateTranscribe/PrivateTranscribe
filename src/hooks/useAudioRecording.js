import { useState, useEffect, useRef, useCallback } from "react";
import AudioManager from "../helpers/audioManager";

export const useAudioRecording = (toast, options = {}) => {
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
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
    audioManagerRef.current = manager;
    let disposed = false;

    manager.setCallbacks({
      onStateChange: ({ isRecording, isProcessing }) => {
        if (disposed) {
          return;
        }
        setIsRecording(isRecording);
        setIsProcessing(isProcessing);
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
      },
      onTranscriptionComplete: async (result) => {
        if (disposed || !result.success) {
          return;
        }

        const text = result.text || "";
        if (!text.trim()) {
          return;
        }

        setTranscript(text);

        await manager.safePaste(text);

        void manager.saveTranscription(text, result.durationSeconds);

        if (result.source === "openai" && localStorage.getItem("useLocalWhisper") === "true") {
          toastRef.current?.({
            title: "Fallback Mode",
            description: "Local Whisper failed. Used OpenAI API instead.",
            variant: "default",
          });
        }
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
        void manager.startRecording();
      } else if (currentState.isRecording || currentState.isStartingRecording) {
        manager.stopRecording();
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
        void manager.startRecording();
      }
    };

    // Set up listener for push-to-talk stop
    const handleStop = () => {
      const currentState = manager.getState();
      if (currentState.isRecording || currentState.isStartingRecording) {
        manager.stopRecording();
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

    const handleNoAudioDetected = () => {
      toastRef.current?.({
        title: "No Audio Detected",
        description: "The recording contained no detectable audio. Please try again.",
        variant: "default",
      });
    };

    const disposeNoAudio = window.electronAPI.onNoAudioDetected?.(handleNoAudioDetected);

    // Cleanup
    return () => {
      disposed = true;
      disposeToggle?.();
      disposeStart?.();
      disposeStop?.();
      disposeNoAudio?.();
      manager.cleanup();
      if (audioManagerRef.current === manager) {
        audioManagerRef.current = null;
      }
    };
  }, []);

  const startRecording = useCallback(async () => {
    if (audioManagerRef.current) {
      return await audioManagerRef.current.startRecording();
    }
    return false;
  }, []);

  const stopRecording = useCallback(() => {
    if (audioManagerRef.current) {
      return audioManagerRef.current.stopRecording();
    }
    return false;
  }, []);

  const cancelRecording = useCallback(() => {
    if (audioManagerRef.current) {
      return audioManagerRef.current.cancelRecording();
    }
    return false;
  }, []);

  const cancelProcessing = useCallback(() => {
    if (audioManagerRef.current) {
      return audioManagerRef.current.cancelProcessing();
    }
    return false;
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
    transcript,
    startRecording,
    stopRecording,
    cancelRecording,
    cancelProcessing,
    toggleListening,
  };
};
