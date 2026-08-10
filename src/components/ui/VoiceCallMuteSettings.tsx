import React, { useCallback, useEffect, useRef, useState } from "react";
import { Mic, MicOff, Check, X, AlertTriangle } from "lucide-react";
import HotkeyInput from "./HotkeyInput";
import { Toggle } from "./toggle";
import type { VoiceCallApp } from "../../types/electron";

const STATUS_POLL_MS = 2000;
const TEST_HOLD_MS = 1200;

// Seconds between asking for the key to be sent and sending it. Discord only
// records a keybind while its own window has focus, so the delay is what lets
// the user get over there first.
const SEND_DELAY_S = 5;
const SEND_HOLD_MS = 400;

// F13 is the key to reach for when every real one is taken. No keyboard ships
// it, which is exactly why nothing can already be using it, and PrivateTranscribe
// is the one pressing it anyway.
const SPARE_KEY = "F13";

type TestState = "idle" | "running" | "passed" | "failed";

/** Whether a key exists only as a signal, with no button on any keyboard. */
// eslint-disable-next-line react-refresh/only-export-components
export function isKeyboardlessKey(key: string): boolean {
  return /^F(1[3-9]|2[0-4])$/.test(key);
}

/**
 * Advice about a chosen key, or null when it is a good one.
 *
 * The distinction that matters here is hold versus tap. This key is held down
 * for the entire length of the dictation, which makes it a different problem
 * from an ordinary shortcut. Anything fine to tap can be ruinous to hold.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function describeKeyRisk(key: string): string | null {
  if (!key) return null;
  if (key.includes("+")) {
    return "This key is held down until you stop dictating, so its modifiers stay pressed the whole time. That changes every keystroke and mouse click that lands anywhere else on your machine. A single key with no modifiers avoids it.";
  }
  if (key.startsWith("Mouse")) {
    return "Mouse buttons are held down until you stop dictating, so the release at the end can fire back or forward in whichever window has focus. A single key avoids it.";
  }
  return null;
}

interface VoiceCallMuteSettingsProps {
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  muteKey: string;
  onMuteKeyChange: (key: string) => void;
}

/**
 * Settings for holding a voice app's push-to-mute key while dictating.
 *
 * The setup is deliberately walked through rather than assumed. Windows has no
 * way for one app to mute another app's microphone, so the only route is the
 * voice app's own keybind, and Discord ships without a global mute keybind
 * bound. Telling the user that plainly is better than a key field with no
 * explanation of why it is needed.
 */
export default function VoiceCallMuteSettings({
  enabled,
  onEnabledChange,
  muteKey,
  onMuteKeyChange,
}: VoiceCallMuteSettingsProps) {
  const [activeApps, setActiveApps] = useState<VoiceCallApp[]>([]);
  const [supported, setSupported] = useState(true);
  const [testState, setTestState] = useState<TestState>("idle");
  const [countdown, setCountdown] = useState<number | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      const status = await window.electronAPI?.voiceMuteStatus?.();
      if (!mountedRef.current || !status) return;
      setSupported(status.supported !== false);
      setActiveApps(Array.isArray(status.activeApps) ? status.activeApps : []);
    } catch {
      // Status is informational. A failure here must not break the settings page.
    }
  }, []);

  // Poll only while the section is switched on. There is no reason to watch the
  // microphone for somebody who has not enabled the feature.
  useEffect(() => {
    if (!enabled) return undefined;
    void refreshStatus();
    const id = setInterval(refreshStatus, STATUS_POLL_MS);
    return () => clearInterval(id);
  }, [enabled, refreshStatus]);

  const runTest = useCallback(async () => {
    if (!muteKey) return;
    setTestState("running");
    try {
      const result = await window.electronAPI?.voiceMuteTest?.({
        key: muteKey,
        holdMs: TEST_HOLD_MS,
      });
      if (!mountedRef.current) return;
      setTestState(result?.ok ? "passed" : "failed");
    } catch {
      if (mountedRef.current) setTestState("failed");
    }
  }, [muteKey]);

  // Counts down, then presses the key for real so Discord's recording field can
  // capture it. This is the only way to bind a key the keyboard cannot produce,
  // and it works for an awkward-to-reach one too.
  useEffect(() => {
    if (countdown === null) return undefined;
    if (countdown > 0) {
      const id = setTimeout(
        () => setCountdown((value) => (value === null ? null : value - 1)),
        1000
      );
      return () => clearTimeout(id);
    }
    setCountdown(null);
    void window.electronAPI?.voiceMuteTest?.({ key: muteKey, holdMs: SEND_HOLD_MS });
    return undefined;
  }, [countdown, muteKey]);

  const inCall = activeApps.length > 0;
  const keyRisk = describeKeyRisk(muteKey);
  const usingSpareKey = isKeyboardlessKey(muteKey);

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground">
            Mute my voice call while dictating
          </div>
          <p className="text-sm text-muted-foreground mt-1 leading-relaxed">
            Holds your voice app&apos;s push-to-mute key while you dictate, so the call doesn&apos;t
            hear it. Only fires when you are actually in a call.
          </p>
        </div>
        <Toggle checked={enabled} onChange={onEnabledChange} />
      </div>

      {enabled && !supported && (
        <p className="text-sm text-muted-foreground">
          This is a Windows feature. It has no effect on this platform.
        </p>
      )}

      {enabled && supported && (
        <div className="space-y-4 pt-1">
          {/* Step 1 - the part PrivateTranscribe cannot do for you */}
          <div className="rounded-lg border border-border-subtle/60 bg-surface-raised/40 p-4">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Step 1 &middot; in Discord
            </div>
            <p className="text-sm text-foreground/90 mt-2 leading-relaxed">
              Open <span className="font-medium">Settings → Keybinds → Add a Keybind</span>, set the
              action to <span className="font-medium">Push to Mute</span>, and press{" "}
              <kbd className="px-1.5 py-0.5 bg-surface-raised border border-border-subtle rounded text-xs font-semibold">
                Pause/Break
              </kbd>
              . Discord ships without this keybind, so there is nothing to reuse.
            </p>
            <p className="text-xs text-muted-foreground mt-2 leading-relaxed">
              Windows gives no way for one app to mute another app&apos;s microphone, so this
              keybind is the only way in. Pause/Break is the suggestion because the key is held for
              as long as you dictate, and it is the one key that does nothing else in Windows. Any
              single key you don&apos;t otherwise use works too — and if they are all taken, step 2
              can bind a key your keyboard does not even have.
            </p>
          </div>

          {/* Step 2 - teach PrivateTranscribe the same key */}
          <div className="rounded-lg border border-border-subtle/60 bg-surface-raised/40 p-4">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Step 2 &middot; here
            </div>
            <p className="text-sm text-foreground/90 mt-2 mb-3 leading-relaxed">
              Press the same key so PrivateTranscribe knows what to send.
            </p>
            {/* This is the voice app's mute key, not the dictation hotkey. */}
            <HotkeyInput
              value={muteKey}
              onChange={onMuteKeyChange}
              appliesToDictationHotkey={false}
            />
            {keyRisk && (
              <p className="flex items-start gap-2 text-xs text-muted-foreground mt-3 leading-relaxed">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                <span>{keyRisk}</span>
              </p>
            )}

            {/* The way out when every key on the keyboard is already spoken for */}
            {usingSpareKey ? (
              <div className="mt-3 pt-3 border-t border-border-subtle/60">
                <p className="text-xs text-muted-foreground leading-relaxed">
                  Your keyboard has no {muteKey} key, and that is the point — nothing else can
                  already be using it. You never press it yourself; PrivateTranscribe sends it.
                </p>
                <p className="text-xs text-muted-foreground mt-2 leading-relaxed">
                  To bind it: open Discord&apos;s <span className="font-medium">Push to Mute</span>{" "}
                  keybind and click its record field, then come back and press the button below. It
                  waits {SEND_DELAY_S} seconds so you can switch to Discord before the key lands.
                </p>
                <button
                  type="button"
                  onClick={() => setCountdown(SEND_DELAY_S)}
                  disabled={countdown !== null}
                  className="mt-3 text-sm px-3 py-1.5 rounded-md border border-border-subtle hover:bg-surface-raised disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  {countdown !== null
                    ? `Sending ${muteKey} in ${countdown}…`
                    : `Send ${muteKey} to Discord`}
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => onMuteKeyChange(SPARE_KEY)}
                className="mt-3 text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground transition-colors"
              >
                Every key already taken? Use {SPARE_KEY} instead
              </button>
            )}
          </div>

          {/* Live state, so the mechanism is visible rather than mysterious */}
          <div className="flex items-center justify-between gap-4 rounded-lg border border-border-subtle/60 bg-surface-raised/40 px-4 py-3">
            <div className="flex items-center gap-2.5 min-w-0">
              {inCall ? (
                <Mic className="w-4 h-4 text-foreground shrink-0" />
              ) : (
                <MicOff className="w-4 h-4 text-muted-foreground shrink-0" />
              )}
              <span className="text-sm text-foreground/90 truncate">
                {inCall
                  ? `In a call: ${activeApps.map((app) => app.label).join(", ")}`
                  : "No voice call detected"}
              </span>
            </div>
            <button
              type="button"
              onClick={runTest}
              disabled={!muteKey || testState === "running"}
              className="shrink-0 text-sm px-3 py-1.5 rounded-md border border-border-subtle hover:bg-surface-raised disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {testState === "running" ? "Testing…" : "Test"}
            </button>
          </div>

          {testState === "passed" && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Check className="w-4 h-4 shrink-0" />
              Key sent. Check whether your mute indicator flipped and came back.
            </p>
          )}
          {testState === "failed" && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <X className="w-4 h-4 shrink-0" />
              PrivateTranscribe could not send that key. Try a different one.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
