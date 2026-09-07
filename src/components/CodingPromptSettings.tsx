import { useState, useEffect } from "react";
import { useSettings } from "../hooks/useSettings";
import { useEnhancementPreferences } from "../hooks/useEnhancementPreferences";
import { getEffectiveEntitlement, isFeatureUnlocked } from "../hooks/useProStatus";
import { readAgentModeUsage } from "../utils/agentModeUsage";
import {
  AGENT_MODE_HOTKEY_OPTIONS,
  normalizeHotkeyForComparison,
  parseHotkey,
} from "../utils/hotkeys";
import { SettingsDisclosure } from "./ui/SettingsDisclosure";
import { SettingsRow } from "./ui/SettingsSection";
import { Toggle } from "./ui/toggle";
import { Badge } from "./ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

/**
 * Agent Mode's two IPC calls, and the status they report.
 *
 * The main process owns the key listener, so it is the only thing that knows
 * whether the hold key is really live, so the section asks it rather than
 * inferring a state from the toggle. Declared here because the shared
 * electronAPI type does not carry these two calls yet.
 */
interface AgentModeHotkeyStatus {
  registered: boolean;
  hotkey: string;
  enabled?: boolean;
  reason?: string;
}

interface AgentModeRewriteStatus {
  available: boolean;
  bin: string | null;
  reason?: "not-found" | "diagnostic-flag";
}

interface AgentModeBridge {
  agentModeSyncHotkey?: (settings: {
    enabled: boolean;
    hotkey: string;
  }) => Promise<AgentModeHotkeyStatus>;
  agentModeHotkeyStatus?: () => Promise<AgentModeHotkeyStatus>;
  agentModeRewriteStatus?: () => Promise<AgentModeRewriteStatus>;
}

const agentModeBridge = (): AgentModeBridge =>
  (window.electronAPI ?? {}) as unknown as AgentModeBridge;

/** The modifier each right-hand Agent Mode key is, for conflict comparison. */
const AGENT_MODE_MODIFIER_EQUIVALENTS: Record<string, string> = {
  RightControl: "Ctrl",
  RightAlt: "Alt",
  RightShift: "Shift",
};

const agentModeKeyLabel = (value: string): string =>
  AGENT_MODE_HOTKEY_OPTIONS.find((option) => option.value === value)?.label || value;

/**
 * Whether the Agent Mode key and the dictation key are the same physical key.
 *
 * A bare `RightControl` is Ctrl, so it only clashes with a dictation hotkey
 * that is itself modifier-only; `Ctrl+Space` leaves Right Ctrl alone. Every
 * other Agent Mode key is an ordinary key, compared on base key name.
 */
const isAgentModeKeySameAsDictation = (agentHotkey: string, dictationHotkey: string): boolean => {
  const modifierEquivalent = AGENT_MODE_MODIFIER_EQUIVALENTS[agentHotkey];
  if (modifierEquivalent) {
    return (
      normalizeHotkeyForComparison(dictationHotkey) ===
      normalizeHotkeyForComparison(modifierEquivalent)
    );
  }

  const agentBase = parseHotkey(agentHotkey).baseKey.trim().toUpperCase();
  const dictationBase = parseHotkey(dictationHotkey).baseKey.trim().toUpperCase();
  return agentBase.length > 0 && agentBase === dictationBase;
};

function SettingsPanel({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-xl border border-border-subtle/50 bg-surface-raised/50 backdrop-blur-sm divide-y divide-border-subtle/30 shadow-sm overflow-hidden ${className}`}
    >
      {children}
    </div>
  );
}

function SettingsPanelRow({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={`px-5 py-4 ${className}`}>{children}</div>;
}

export default function CodingPromptSettings() {
  const {
    agentModeEnabled,
    setAgentModeEnabled,
    agentModeHotkey,
    setAgentModeHotkey,
    agentModeRewrite,
    setAgentModeRewrite,
    dictationKey,
    useLocalWhisper,
    reasoningModel,
    reasoningProvider,
  } = useSettings();
  const { useSharedConnection, setUseSharedConnection } = useEnhancementPreferences();
  const canUseSharedConnection = isFeatureUnlocked("ai-enhancement");
  const [agentModeStatus, setAgentModeStatus] = useState<AgentModeHotkeyStatus | null>(null);
  const [agentModeRewriteStatus, setAgentModeRewriteStatus] =
    useState<AgentModeRewriteStatus | null>(null);
  const [agentModeUsage, setAgentModeUsage] = useState(() => readAgentModeUsage());
  const [isAgentModePro, setIsAgentModePro] = useState(() => getEffectiveEntitlement() === "pro");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const bridge = agentModeBridge();
      await bridge
        .agentModeSyncHotkey?.({ enabled: agentModeEnabled, hotkey: agentModeHotkey })
        .catch(() => undefined);
      const status = await bridge.agentModeHotkeyStatus?.().catch(() => undefined);
      if (!cancelled && status) setAgentModeStatus(status);
    })();
    return () => {
      cancelled = true;
    };
  }, [agentModeEnabled, agentModeHotkey]);

  useEffect(() => {
    let cancelled = false;
    void agentModeBridge()
      .agentModeHotkeyStatus?.()
      .then((status) => {
        if (!cancelled && status) setAgentModeStatus(status);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // A prompt is spent in the overlay window, so the count is re-read whenever
  // this window comes back to the front rather than only on mount.
  useEffect(() => {
    let cancelled = false;
    const refreshAgentModeUsage = () => {
      setAgentModeUsage(readAgentModeUsage());
      setIsAgentModePro(getEffectiveEntitlement() === "pro");
      void agentModeBridge()
        .agentModeRewriteStatus?.()
        .then((status) => {
          if (!cancelled && status) setAgentModeRewriteStatus(status);
        })
        .catch(() => undefined);
    };
    refreshAgentModeUsage();
    window.addEventListener("focus", refreshAgentModeUsage);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", refreshAgentModeUsage);
    };
  }, []);

  // The toggle disables itself on not-found instead of hiding: a row that
  // vanishes reads as a missing feature, a disabled one says what to install.
  const agentModeRewriteBlocked =
    agentModeRewriteStatus !== null && !agentModeRewriteStatus.available;
  const agentModeRewriteLive =
    agentModeRewrite && agentModeRewriteStatus !== null && agentModeRewriteStatus.available;

  const agentModeRewriteDescription = (): string => {
    if (!agentModeRewriteStatus) return "Checking for Claude Code...";
    if (agentModeRewriteStatus.reason === "diagnostic-flag") {
      return "Turned off by a diagnostic flag for this run.";
    }
    if (!agentModeRewriteStatus.available) {
      return "Claude Code was not found on this PC. Prompts are pasted as spoken, with paths in backticks.";
    }
    if (agentModeRewrite) {
      return "Rewrites prompts through your Claude Code login before pasting.";
    }
    return "Off. Prompts are pasted as spoken, with paths in backticks.";
  };

  const agentModeStatusDescription = (): string => {
    if (!agentModeEnabled) return "Off. The dictation key works as before.";
    if (!agentModeStatus) return "Checking the key...";
    if (agentModeStatus.registered) {
      return `Listening for ${agentModeKeyLabel(agentModeHotkey)} in every app. Hold it and talk.`;
    }
    switch (agentModeStatus.reason) {
      case "disabled":
        return "Off. The dictation key works as before.";
      case "windows-only":
        return "Windows only for now.";
      case "diagnostic-flag":
        return "Turned off by a diagnostic flag for this run.";
      case "suspended":
        return "Paused while a hotkey field is capturing.";
      default:
        return "The key listener could not start, so the hold key is not live. Restarting PrivateTranscribe usually fixes it.";
    }
  };

  const agentModeKeyClashesWithDictation =
    agentModeEnabled && isAgentModeKeySameAsDictation(agentModeHotkey, dictationKey);

  return (
    <SettingsDisclosure
      title="Coding prompt shortcut"
      settingsLabel="Coding prompt shortcut"
      description="Use a second key when you’re talking to a coding agent."
      status={
        !agentModeEnabled
          ? "Off"
          : !agentModeStatus
            ? "Checking…"
            : agentModeStatus.registered
              ? agentModeKeyLabel(agentModeHotkey)
              : "Unavailable"
      }
    >
      <SettingsPanel>
        <SettingsPanelRow>
          <SettingsRow
            label="Enable coding prompt shortcut"
            description={agentModeStatusDescription()}
          >
            <Toggle
              checked={agentModeEnabled}
              onChange={setAgentModeEnabled}
              aria-label="Enable coding prompt shortcut"
            />
          </SettingsRow>
        </SettingsPanelRow>

        <SettingsPanelRow>
          <SettingsRow label="Coding prompt hotkey" description="Hold this key while you speak.">
            <Select
              value={agentModeHotkey}
              onValueChange={setAgentModeHotkey}
              disabled={!agentModeEnabled}
            >
              <SelectTrigger className="w-[180px]" aria-label="Coding prompt hotkey">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {AGENT_MODE_HOTKEY_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingsRow>
          {agentModeKeyClashesWithDictation && (
            <p className="text-[11px] text-warning leading-relaxed mt-2">
              Same key as dictation. Pick another one.
            </p>
          )}
        </SettingsPanelRow>

        <SettingsPanelRow>
          <SettingsRow
            label="Shortcut AI connection"
            description={
              useSharedConnection
                ? "Shares the connection above. The shortcut has its own enhancement switch."
                : "Your saved Claude Code connection. Choose the shared connection to use the settings above."
            }
          >
            <Select
              value={useSharedConnection ? "shared" : "claude-code"}
              onValueChange={(value) => setUseSharedConnection(value === "shared")}
            >
              <SelectTrigger className="w-[210px]" aria-label="Shortcut AI connection">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="shared" disabled={!canUseSharedConnection}>
                  Same as AI Enhancement
                </SelectItem>
                <SelectItem value="claude-code">Claude Code</SelectItem>
              </SelectContent>
            </Select>
          </SettingsRow>
        </SettingsPanelRow>
        <SettingsPanelRow>
          <SettingsRow
            label="Enhance coding prompts"
            description={
              useSharedConnection
                ? !agentModeRewrite
                  ? "Off. Prompts are pasted as spoken, with paths in backticks."
                  : !canUseSharedConnection
                    ? "The shared connection requires tester access. Prompts are pasted as spoken."
                    : !reasoningModel
                      ? "Choose a model above. Until then, prompts are pasted as spoken."
                      : "Uses the AI connection above with the Coding prompt style."
                : agentModeRewriteDescription()
            }
          >
            <Toggle
              checked={agentModeRewrite}
              aria-label="Enhance coding prompts"
              onChange={setAgentModeRewrite}
              disabled={!agentModeEnabled || (!useSharedConnection && agentModeRewriteBlocked)}
            />
          </SettingsRow>
        </SettingsPanelRow>

        <SettingsPanelRow>
          <p className="text-xs text-muted-foreground">
            Say "new line" for a line break or end with "send" to press Enter.
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            {useLocalWhisper
              ? "Audio is transcribed on this PC."
              : "Audio is sent to your selected transcription service."}
            {agentModeRewrite &&
              useSharedConnection &&
              canUseSharedConnection &&
              reasoningModel &&
              (reasoningProvider === "local" ||
              !["claude-code", "openai", "anthropic", "gemini", "groq", "custom"].includes(
                reasoningProvider
              )
                ? " Text enhancement runs on this PC."
                : " Text is sent to the AI connection above.")}
            {!useSharedConnection &&
              agentModeRewriteLive &&
              " Rewriting sends text through your Claude Code login."}
          </p>
        </SettingsPanelRow>

        <SettingsPanelRow>
          <SettingsRow
            label="Prompts today"
            description={
              isAgentModePro ? (
                "Unlimited coding shortcuts on this license. Your AI provider’s limits still apply."
              ) : (
                <>
                  Starter includes {agentModeUsage.limit} a day. Resets at midnight.{" "}
                  <button
                    type="button"
                    onClick={() =>
                      void window.electronAPI?.openControlPanel?.({
                        page: "settings",
                        settingsTab: "pro",
                      })
                    }
                    className="text-primary underline-offset-2 hover:underline"
                  >
                    Unlimited with Pro
                  </button>
                </>
              )
            }
          >
            <div className="flex items-center gap-2.5">
              <span className="text-[13px] tabular-nums text-muted-foreground font-mono">
                {isAgentModePro
                  ? "Unlimited"
                  : `${agentModeUsage.usesToday} of ${agentModeUsage.limit}`}
              </span>
              {isAgentModePro && <Badge variant="pro">Pro</Badge>}
            </div>
          </SettingsRow>
        </SettingsPanelRow>
      </SettingsPanel>
    </SettingsDisclosure>
  );
}
