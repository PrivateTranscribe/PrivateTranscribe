import { Download, ExternalLink, Headphones, Square, X } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Button } from "../ui/button";
import { Toggle } from "../ui/toggle";
import { Badge } from "../ui/badge";
import { SettingsRow } from "../ui/SettingsSection";
import { SectionLabel } from "../ui/SectionLabel";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { useExperimentalFeatures } from "../../utils/experimentalFeatures";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import type {
  NarratorDownloadProgress,
  NarratorItem,
  NarratorLanguage,
  NarratorState,
  NarratorVoiceStatus,
} from "../../utils/narratorTypes";

/** Matches the panel treatment the other control-panel pages use. */
function Panel({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-xl border border-border-subtle/50 bg-surface-raised/50 divide-y divide-border-subtle/30 shadow-sm overflow-hidden">
      {children}
    </div>
  );
}

function PanelRow({ children }: { children: ReactNode }) {
  return <div className="px-5 py-3">{children}</div>;
}

function minutesAgo(at: number): string {
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

function megabytes(bytes: number): string {
  return `${Math.round(bytes / 1e6)} MB`;
}

function NarratorCard({ item }: { item: NarratorItem }) {
  const api = window.electronAPI;
  const title = item.chatTitle || item.project || "Untitled chat";
  return (
    <div data-testid="narrator-card" className="px-5 py-3 space-y-1.5">
      <div className="flex items-center gap-2 min-w-0">
        <Badge variant={item.kind === "waiting" ? "warning" : "outline"}>
          {item.kind === "waiting" ? "Waits on you" : "Finished"}
        </Badge>
        <p className="text-sm font-medium text-foreground truncate" title={title}>
          {title}
        </p>
        <span className="text-xs text-muted-foreground shrink-0">{minutesAgo(item.at)}</span>
        {!item.heard && (
          <span className="text-xs text-primary shrink-0" aria-label="Not heard yet">
            new
          </span>
        )}
      </div>
      <p className="text-[13px] text-muted-foreground leading-relaxed">{item.card}</p>
      <div className="flex items-center gap-1.5">
        {item.canOpen && (
          <Button size="sm" variant="outline" onClick={() => void api?.narratorOpen?.(item.id)}>
            <ExternalLink size={13} aria-hidden />
            Open chat
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          aria-pressed={item.followed}
          onClick={() => void api?.narratorFollow?.(item.chatId, !item.followed)}
        >
          {item.followed ? "Stop following" : "Follow this chat"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-label={`Dismiss ${title}`}
          onClick={() => void api?.narratorDismiss?.(item.id)}
        >
          <X size={13} aria-hidden />
          Dismiss
        </Button>
      </div>
    </div>
  );
}

/**
 * The agent narrator: speaks what waits on the user in their Claude Code chats,
 * keeps the rest as cards. The service runs in the main process; this page
 * shows its state and its switches.
 */
export default function NarratorPage() {
  const api = window.electronAPI;
  const [experimentalOn] = useExperimentalFeatures();
  const [state, setState] = useState<NarratorState | null>(null);
  const [voices, setVoices] = useState<NarratorVoiceStatus | null>(null);
  const [download, setDownload] = useState<NarratorDownloadProgress | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [useLocalWhisper] = useLocalStorage("useLocalWhisper", false, {
    serialize: String,
    deserialize: (value) => value === "true",
  });
  const [allowCloudFallback] = useLocalStorage("allowOpenAIFallback", false, {
    serialize: String,
    deserialize: (value) => value === "true",
  });
  // Listening transcribes the room, so it needs transcription that cannot leave this PC.
  const localOnly = useLocalWhisper && !allowCloudFallback;

  const refreshVoices = useCallback(async () => {
    try {
      setVoices((await api?.narratorVoiceStatus?.()) || null);
    } catch {
      setVoices(null);
    }
  }, [api]);

  useEffect(() => {
    void api
      ?.narratorSetGate?.(experimentalOn)
      .then(setState)
      .catch(() => {});
  }, [api, experimentalOn]);

  useEffect(() => {
    void api
      ?.narratorVoiceStatus?.()
      .then((status) => setVoices(status || null))
      .catch(() => setVoices(null));
    const offState = api?.onNarratorState?.((_event, next) => setState(next));
    const offProgress = api?.onNarratorDownloadProgress?.((_event, progress) =>
      setDownload(progress)
    );
    return () => {
      offState?.();
      offProgress?.();
    };
  }, [api]);

  const update = (patch: Parameters<NonNullable<typeof api>["narratorUpdateSettings"]>[0]) => {
    void api?.narratorUpdateSettings?.(patch).then(setState);
  };

  const downloadPiper = async () => {
    setDownloadError(null);
    setDownload({ downloadedBytes: 0, totalBytes: voices?.["piper-da"].sizeBytes || 0 });
    const result = await api?.narratorDownloadVoice?.("piper-da");
    setDownload(null);
    if (result && !result.ok) setDownloadError(result.error || "The download failed.");
    await refreshVoices();
  };

  const settings = state?.settings;
  const piper = voices?.["piper-da"];
  const roest = voices?.["roest-da"];
  const kokoro = voices?.["kokoro-en"];
  const danishReady =
    settings?.voiceDa === "roest-da" ? Boolean(roest?.installed) : Boolean(piper?.installed);
  const voiceReady = settings?.language === "en" ? Boolean(kokoro?.installed) : danishReady;
  const items = state?.items || [];
  const spokenThisWeek =
    (state?.week.interrupt || 0) +
    (state?.week.followed || 0) +
    (state?.week.brief || 0) +
    (state?.week.more || 0);
  const cardsThisWeek = state?.week.card || 0;

  const statusLine = () => {
    if (!state?.enabled) return "Off. Nothing is read from your chats.";
    if (!state.running) return "Waiting for Experimental features to be on.";
    if (!voiceReady)
      return "Following your chats. A wait only chimes until the voice for this language is downloaded.";
    return "Following every Claude Code chat on this PC.";
  };

  const pct =
    download && download.totalBytes > 0
      ? Math.min(100, Math.round((download.downloadedBytes / download.totalBytes) * 100))
      : 0;

  return (
    <div data-testid="narrator-page" className="p-8 max-w-4xl mx-auto space-y-4">
      <div className="flex items-start gap-3">
        <Headphones size={28} className="text-primary mt-0.5 shrink-0" />
        <div>
          <h1 className="text-3xl font-semibold text-foreground tracking-tight">Narrator</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Says out loud when a Claude Code chat needs you. Finished work waits here as cards.
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            The voice is synthetic, made on this PC. Text for rewriting goes to Claude through your
            own Claude Code login.
          </p>
        </div>
      </div>

      <Panel>
        <PanelRow>
          <SettingsRow
            label="Narrate my Claude Code chats"
            description={<span data-testid="narrator-status">{statusLine()}</span>}
          >
            <Toggle
              checked={Boolean(settings?.enabled)}
              onChange={(enabled) => update({ enabled })}
            />
          </SettingsRow>
        </PanelRow>
        <PanelRow>
          <SettingsRow
            label="Wait for a pause in calls"
            description="Before it reads a chat out, waits up to 8 seconds for a pause on Discord, Teams, Zoom or Slack. Other apps play at 30% while it speaks."
          >
            <Toggle
              checked={settings?.makeRoom !== false}
              onChange={(makeRoom) => update({ makeRoom })}
            />
          </SettingsRow>
        </PanelRow>
        <PanelRow>
          <SettingsRow
            label="Speak in"
            description="Used when a chat interrupts. A question you ask is answered in its own language."
          >
            <Select
              value={settings?.language || "da"}
              onValueChange={(value) => update({ language: value as NarratorLanguage })}
            >
              <SelectTrigger aria-label="Speak in" className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="da">Danish</SelectItem>
                <SelectItem value="en">English</SelectItem>
              </SelectContent>
            </Select>
          </SettingsRow>
        </PanelRow>
        {state?.voiceError && (
          <PanelRow>
            <p className="text-[13px] text-warning" data-testid="narrator-voice-error">
              Could not speak: {state.voiceError.message}
            </p>
          </PanelRow>
        )}
        {state?.rewriterError?.code === "login" && (
          <PanelRow>
            <p className="text-[13px] text-warning">
              Claude Code asks for a login, so cards are read as written. Run claude once in a
              terminal and sign in.
            </p>
          </PanelRow>
        )}
      </Panel>

      <SectionLabel>Voices</SectionLabel>
      <Panel>
        <PanelRow>
          <SettingsRow
            label="Danish voice"
            description={
              piper?.installed
                ? "Piper “talesyntese”. Runs on the processor, ready offline."
                : `Piper “talesyntese”. Download once (${megabytes(piper?.sizeBytes || 0)}).`
            }
          >
            {piper?.installed ? (
              <Button size="sm" variant="ghost" onClick={() => void api?.narratorTestVoice?.("da")}>
                Test
              </Button>
            ) : (
              <Button
                size="sm"
                disabled={Boolean(download) || !voices}
                onClick={() => void downloadPiper()}
              >
                <Download size={14} aria-hidden />
                {download ? `Downloading ${pct}%` : "Download"}
              </Button>
            )}
          </SettingsRow>
          {downloadError && <p className="text-[13px] text-destructive mt-2">{downloadError}</p>}
        </PanelRow>
        {roest?.installed && (
          <PanelRow>
            <SettingsRow
              label="Use Røst for Danish"
              description="Higher quality, made by the CoRal project, run from the Python setup on this PC. It needs the graphics card. On the processor each item takes about half a minute to start. Falls back to Piper when it fails."
            >
              <Toggle
                checked={settings?.voiceDa === "roest-da"}
                onChange={(on) => update({ voiceDa: on ? "roest-da" : "piper-da" })}
              />
            </SettingsRow>
          </PanelRow>
        )}
        <PanelRow>
          <SettingsRow
            label="English voice"
            description={
              kokoro?.installed
                ? "The Read Aloud voice."
                : "Uses the Read Aloud voice model. Download it on the Read Aloud page."
            }
          >
            <Button
              size="sm"
              variant="ghost"
              disabled={!kokoro?.installed}
              onClick={() => void api?.narratorTestVoice?.("en")}
            >
              Test
            </Button>
          </SettingsRow>
        </PanelRow>
      </Panel>

      <SectionLabel>Hands-free</SectionLabel>
      <Panel>
        <PanelRow>
          <SettingsRow
            label="Listen for questions"
            description={
              localOnly
                ? "Say “hvad er nyt?” or “what's new?”, “fortæl mere” or “tell me more”, “følg den chat” or “follow that chat”, and “stop”. Short sentences only, transcribed on this PC."
                : useLocalWhisper
                  ? "Unavailable while your transcription settings allow a cloud fallback. Room audio must never leave this PC."
                  : "Needs local transcription, so room audio never leaves this PC. Turn it on under Dictation."
            }
          >
            <Toggle
              checked={Boolean(settings?.listen) && localOnly}
              disabled={!localOnly}
              onChange={(listen) => update({ listen })}
            />
          </SettingsRow>
        </PanelRow>
        <PanelRow>
          <SettingsRow
            label="Stop speaking when I talk"
            description="For a headset. Through speakers the microphone would hear the narrator itself. The dictation hotkey always stops it."
          >
            <Toggle
              checked={settings?.bargeIn === true}
              onChange={(bargeIn) => update({ bargeIn })}
            />
          </SettingsRow>
        </PanelRow>
      </Panel>

      <div className="flex items-center justify-between pt-2">
        <SectionLabel>Cards</SectionLabel>
        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            variant="outline"
            disabled={!state?.running}
            onClick={() => void api?.narratorCommand?.("brief")}
          >
            What's new?
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={!state?.running}
            onClick={() => void api?.narratorStop?.()}
          >
            <Square size={12} className="fill-current" aria-hidden />
            Stop
          </Button>
        </div>
      </div>
      <Panel>
        {items.length === 0 ? (
          <PanelRow>
            <p className="text-[13px] text-muted-foreground" data-testid="narrator-empty">
              {state?.running
                ? "Nothing yet. When a chat finishes or asks you something, it shows up here."
                : "Cards appear here while the narrator is on."}
            </p>
          </PanelRow>
        ) : (
          items.map((item) => <NarratorCard key={item.id} item={item} />)
        )}
      </Panel>
      <p className="text-xs text-muted-foreground" data-testid="narrator-week">
        Last 7 days: {spokenThisWeek} spoken, {cardsThisWeek}{" "}
        {cardsThisWeek === 1 ? "card" : "cards"}. Kept in a local log on this PC only.
      </p>
    </div>
  );
}
