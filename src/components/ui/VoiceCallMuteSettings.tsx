import React, { useCallback, useEffect, useRef, useState } from "react";
import { Mic, MicOff, Check, X, AlertTriangle } from "lucide-react";
import HotkeyInput, { type HotkeyConflict } from "./HotkeyInput";
import { Toggle } from "./toggle";
import type { VoiceCallApp } from "../../types/electron";

const STATUS_POLL_MS = 2000;
const TEST_HOLD_MS = 1200;

type TestState = "idle" | "running" | "passed" | "failed";

/**
 * Advice about a chosen key, or null when it is a good one.
 *
 * The distinction that matters here is hold versus tap. This key is held down
 * for as long as the dictation runs, which makes it a different question from
 * an ordinary shortcut. Things that are unremarkable to tap can misbehave when
 * held for minutes.
 *
 * What bounds the risk is when the key comes back up: the release is sent as
 * soon as speech stops, well before any text is pasted. So a held modifier
 * cannot corrupt the dictation itself, and the exposure is only what happens
 * during the seconds you are talking.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function describeKeyRisk(key: string): string | null {
  if (!key) return null;
  // Lock keys carry a side effect no other key does: the lock state itself
  // flips on every press. Measured on Num Lock, `False` before a dictation and
  // `True` after, so the numpad silently changes mode. This is separate from
  // the hold not persisting, which affects ordinary keys too.
  if (/(^|\+)(Num ?lock|Caps ?lock|Scroll ?lock)$/i.test(key)) {
    return "Lock keys flip their own state every time they are pressed, so a dictation leaves Num Lock or Caps Lock the opposite way round from how you left it. Pick an ordinary key instead.";
  }
  if (/(^|\+)(Alt|Option|Win|Super|Meta|Command|Cmd)\+/.test(key)) {
    return "Alt and the Windows key act on their own when they come back up — focusing a menu bar, opening Start — and this key is released every time you stop dictating. Ctrl and Shift do nothing on release, so they are the safe modifiers to hold.";
  }
  if (key.includes("Mouse")) {
    return "A held mouse button is a click that lasts the whole dictation, so releasing it can fire back or forward in whichever window has focus. A keyboard key avoids it.";
  }
  if (key.includes("+")) {
    return "Check that the last key here is not already a keybind on its own in your voice app. Discord matches on the base key, so a combination built on a key you have already bound fires both keybinds at once.";
  }
  return null;
}

interface VoiceCallMuteSettingsProps {
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  muteKey: string;
  onMuteKeyChange: (key: string) => void;
  /** The app's other hotkeys, so this field can refuse to duplicate one. */
  conflicts?: HotkeyConflict[];
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
  conflicts,
}: VoiceCallMuteSettingsProps) {
  const [activeApps, setActiveApps] = useState<VoiceCallApp[]>([]);
  const [supported, setSupported] = useState(true);
  const [testState, setTestState] = useState<TestState>("idle");
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

  const inCall = activeApps.length > 0;
  const keyRisk = describeKeyRisk(muteKey);

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
              single key you don&apos;t otherwise use works too. If every quiet key is spoken for,
              use Ctrl+Shift with a plain letter — Discord matches on the base key, so building the
              combination on top of a key you have already bound will fire both keybinds at once.
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
              ariaLabel="Voice call mute key"
              conflicts={conflicts}
              onClear={() => onMuteKeyChange("")}
            />
            {keyRisk && (
              <p className="flex items-start gap-2 text-xs text-muted-foreground mt-3 leading-relaxed">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                <span>{keyRisk}</span>
              </p>
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
