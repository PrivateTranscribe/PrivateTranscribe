import React, { useCallback, useEffect, useRef, useState } from "react";
import { Mic, RefreshCw } from "lucide-react";
import { Button } from "./button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./select";
import {
  MIC_CHOICE_AUTOMATIC,
  MIC_CHOICE_SYSTEM_DEFAULT,
  buildMicrophoneConstraints,
  describeMicrophoneSelection,
  hasExplicitBuiltInLabel,
  type AudioInputDeviceInfo,
  type MicrophonePreference,
} from "../../utils/audioDeviceUtils";

/** How long a test listens before it reports back. */
const TEST_DURATION_MS = 4000;
const LEVEL_BAR_COUNT = 7;
/** Peak RMS below this across a whole test means the device delivered silence. */
const SILENCE_PEAK_RMS = 0.015;

interface MicrophoneDeviceSelectProps {
  preferBuiltInMic: boolean;
  selectedMicDeviceId: string;
  onChange: (next: MicrophonePreference) => void;
  /** Change this to re-enumerate, e.g. once mic permission has been granted. */
  reloadSignal?: unknown;
  className?: string;
}

type TestState = "idle" | "listening" | "heard" | "silent" | "error";

/**
 * Pick the microphone dictation uses, and prove it hears you.
 *
 * The test matters as much as the list: a dead or wrong input is invisible
 * until a dictation comes back empty, and this picker is where someone lands
 * when that happens.
 */
export default function MicrophoneDeviceSelect({
  preferBuiltInMic,
  selectedMicDeviceId,
  onChange,
  reloadSignal,
  className = "",
}: MicrophoneDeviceSelectProps) {
  const [devices, setDevices] = useState<AudioInputDeviceInfo[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [testState, setTestState] = useState<TestState>("idle");
  const [testError, setTestError] = useState<string | null>(null);
  const [level, setLevel] = useState(0);

  const rafRef = useRef<number | null>(null);
  const timeoutRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const peakRef = useRef(0);

  const loadDevices = useCallback(async () => {
    setIsLoading(true);
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      setDevices(
        all
          .filter((device) => device.kind === "audioinput")
          .map((device) => ({ deviceId: device.deviceId, label: device.label }))
      );
    } catch {
      setDevices([]);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadDevices();

    const handleDeviceChange = () => void loadDevices();
    navigator.mediaDevices?.addEventListener("devicechange", handleDeviceChange);
    return () => {
      navigator.mediaDevices?.removeEventListener("devicechange", handleDeviceChange);
    };
  }, [loadDevices, reloadSignal]);

  const stopTest = useCallback(() => {
    if (rafRef.current !== null) {
      window.cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (timeoutRef.current) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    sourceRef.current?.disconnect();
    sourceRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;

    const audioContext = audioContextRef.current;
    audioContextRef.current = null;
    if (audioContext) void audioContext.close();
  }, []);

  useEffect(() => stopTest, [stopTest]);

  const runTest = useCallback(async () => {
    stopTest();
    setTestError(null);
    setTestState("listening");
    setLevel(0);
    peakRef.current = 0;

    try {
      const constraints = buildMicrophoneConstraints(devices, {
        preferBuiltInMic,
        selectedMicDeviceId,
      });
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      streamRef.current = stream;

      // Labels only become readable once a stream has been granted, so this is
      // also the moment a nameless list fills in.
      void loadDevices();

      const AudioContextCtor = window.AudioContext;
      if (!AudioContextCtor) throw new Error("AudioContext is not available.");
      const audioContext = new AudioContextCtor();
      audioContextRef.current = audioContext;

      const source = audioContext.createMediaStreamSource(stream);
      sourceRef.current = source;
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      const samples = new Uint8Array(analyser.fftSize);

      const measure = () => {
        analyser.getByteTimeDomainData(samples);
        let sum = 0;
        for (let i = 0; i < samples.length; i += 1) {
          const normalized = (samples[i] - 128) / 128;
          sum += normalized * normalized;
        }
        const rms = Math.sqrt(sum / samples.length);
        peakRef.current = Math.max(peakRef.current, rms);
        setLevel(Math.min(1, rms * 6));
        rafRef.current = window.requestAnimationFrame(measure);
      };
      measure();

      timeoutRef.current = window.setTimeout(() => {
        const heardSomething = peakRef.current >= SILENCE_PEAK_RMS;
        stopTest();
        setLevel(0);
        setTestState(heardSomething ? "heard" : "silent");
      }, TEST_DURATION_MS);
    } catch (error) {
      stopTest();
      setLevel(0);
      setTestState("error");
      setTestError(
        error instanceof Error ? error.message : "PrivateTranscribe could not open that microphone."
      );
    }
  }, [devices, loadDevices, preferBuiltInMic, selectedMicDeviceId, stopTest]);

  const value = preferBuiltInMic
    ? MIC_CHOICE_AUTOMATIC
    : selectedMicDeviceId || MIC_CHOICE_SYSTEM_DEFAULT;

  const handleValueChange = (next: string) => {
    setTestState("idle");
    setTestError(null);

    if (next === MIC_CHOICE_AUTOMATIC) {
      onChange({ preferBuiltInMic: true, selectedMicDeviceId: "" });
      return;
    }
    if (next === MIC_CHOICE_SYSTEM_DEFAULT) {
      onChange({ preferBuiltInMic: false, selectedMicDeviceId: "" });
      return;
    }
    onChange({ preferBuiltInMic: false, selectedMicDeviceId: next });
  };

  const activeLabel = describeMicrophoneSelection(devices, {
    preferBuiltInMic,
    selectedMicDeviceId,
  });
  const hasLabels = devices.some((device) => device.label);
  const selectedIsGone =
    !preferBuiltInMic &&
    !!selectedMicDeviceId &&
    hasLabels &&
    !devices.some((device) => device.deviceId === selectedMicDeviceId);

  const activeBars = Math.ceil(level * LEVEL_BAR_COUNT);

  return (
    <div className={`space-y-3 ${className}`}>
      <div className="flex items-center gap-2">
        <Select value={value} onValueChange={handleValueChange}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder="Select a microphone" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={MIC_CHOICE_AUTOMATIC}>Automatic (prefer built-in)</SelectItem>
            <SelectItem value={MIC_CHOICE_SYSTEM_DEFAULT}>System default</SelectItem>
            {devices
              .filter((device) => device.deviceId && device.deviceId !== "default")
              .map((device) => (
                <SelectItem key={device.deviceId} value={device.deviceId}>
                  {device.label || `Microphone ${device.deviceId.slice(0, 8)}`}
                  {hasExplicitBuiltInLabel(device.label || "") && (
                    <span className="ml-2 text-xs text-muted-foreground">(Built-in)</span>
                  )}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>

        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => void loadDevices()}
          disabled={isLoading}
          className="h-9 w-9 shrink-0 p-0"
          aria-label="Refresh microphone list"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? "animate-spin" : ""}`} />
        </Button>
      </div>

      <div className="flex items-center gap-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void runTest()}
          disabled={testState === "listening"}
          className="h-8 px-3 text-xs"
        >
          <Mic className="w-3.5 h-3.5" />
          {testState === "listening" ? "Listening..." : "Test microphone"}
        </Button>

        <div className="flex items-center gap-1.5">
          {Array.from({ length: LEVEL_BAR_COUNT }, (_, index) => (
            <div
              key={index}
              className={`h-2 w-2 rounded transition-colors duration-150 ${
                index < activeBars ? "bg-primary" : "bg-border"
              }`}
            />
          ))}
        </div>
      </div>

      {testState === "listening" && (
        <p className="text-xs text-muted-foreground">Say something - listening on {activeLabel}.</p>
      )}

      {testState === "heard" && <p className="text-xs text-success">Heard you on {activeLabel}.</p>}

      {testState === "silent" && (
        <p className="text-xs text-warning">
          No sound came through {activeLabel}. Pick another microphone, or check that it is not
          muted in your system sound settings.
        </p>
      )}

      {testState === "error" && (
        <p className="text-xs text-destructive">
          {testError || "PrivateTranscribe could not open that microphone."}
        </p>
      )}

      {testState === "idle" && selectedIsGone && (
        <p className="text-xs text-warning">
          The microphone you picked is unplugged. Dictation falls back to the system default until
          it is back.
        </p>
      )}

      {testState === "idle" && !selectedIsGone && (
        <p className="text-xs text-muted-foreground">
          {hasLabels
            ? `Dictation uses: ${activeLabel}`
            : "Run a test to allow access and see your device names."}
        </p>
      )}
    </div>
  );
}
