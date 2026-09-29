import { useState, useEffect } from "react";
import { useSettings } from "../hooks/useSettings";
import { useEnhancementPreferences } from "../hooks/useEnhancementPreferences";
import { isFeatureUnlocked } from "../utils/betaFeatures";
import { formatHotkeyLabel } from "../utils/hotkeys";
import { SettingsDisclosure } from "./ui/SettingsDisclosure";
import { SettingsRow } from "./ui/SettingsSection";
import { Toggle } from "./ui/toggle";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

interface AgentModeRewriteStatus {
  available: boolean;
  bin: string | null;
  reason?: "not-found" | "diagnostic-flag";
}

interface AgentModeBridge {
  agentModeRewriteStatus?: () => Promise<AgentModeRewriteStatus>;
}

const agentModeBridge = (): AgentModeBridge =>
  (window.electronAPI ?? {}) as unknown as AgentModeBridge;

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
    agentModeRewrite,
    setAgentModeRewrite,
    dictationKey,
    useLocalWhisper,
    reasoningModel,
    reasoningProvider,
  } = useSettings();
  const { useSharedConnection, setUseSharedConnection } = useEnhancementPreferences();
  const canUseSharedConnection = isFeatureUnlocked("ai-enhancement");
  const [agentModeRewriteStatus, setAgentModeRewriteStatus] =
    useState<AgentModeRewriteStatus | null>(null);

  // Claude Code can be installed while this window is open, so its status is
  // re-read whenever the window comes back to the front rather than only on mount.
  useEffect(() => {
    let cancelled = false;
    const refreshRewriteStatus = () => {
      void agentModeBridge()
        .agentModeRewriteStatus?.()
        .then((status) => {
          if (!cancelled && status) setAgentModeRewriteStatus(status);
        })
        .catch(() => undefined);
    };
    refreshRewriteStatus();
    window.addEventListener("focus", refreshRewriteStatus);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", refreshRewriteStatus);
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

  return (
    <SettingsDisclosure
      title="Agent mode"
      settingsLabel="Agent mode"
      description="Choose how your normal dictation shortcut handles speech."
      status={agentModeEnabled ? "On" : "Off"}
    >
      <SettingsPanel>
        <SettingsPanelRow>
          <SettingsRow
            label="Enable agent mode"
            description={
              agentModeEnabled
                ? `On. ${formatHotkeyLabel(dictationKey)} turns speech into a coding prompt.`
                : `Off. ${formatHotkeyLabel(dictationKey)} uses normal dictation.`
            }
          >
            <Toggle
              checked={agentModeEnabled}
              onChange={setAgentModeEnabled}
              aria-label="Enable agent mode"
            />
          </SettingsRow>
        </SettingsPanelRow>

        <SettingsPanelRow>
          <SettingsRow
            label="Agent mode AI connection"
            description={
              useSharedConnection
                ? "Shares the connection above. Agent mode has its own enhancement switch."
                : "Your saved Claude Code connection. Choose the shared connection to use the settings above."
            }
          >
            <Select
              value={useSharedConnection ? "shared" : "claude-code"}
              onValueChange={(value) => setUseSharedConnection(value === "shared")}
            >
              <SelectTrigger className="w-[210px]" aria-label="Agent mode AI connection">
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
                    ? "Turn on beta features in Settings to use the shared connection. Until then, prompts are pasted as spoken."
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
      </SettingsPanel>
    </SettingsDisclosure>
  );
}
