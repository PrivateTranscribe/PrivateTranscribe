import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MessagesSquare, Lock, FolderOpen, Headphones, Square, Send, X } from "lucide-react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Toggle } from "../ui/toggle";
import { InfoBox } from "../ui/InfoBox";
import { SectionLabel } from "../ui/SectionLabel";
import { SettingsRow } from "../ui/SettingsSection";
import { BetaBadge } from "../ui/BetaBadge";
import { BetaAccessLink } from "../ui/BetaAccessLink";
import { isFeatureUnlocked } from "../../hooks/useProStatus";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import type { ConverseState } from "../../types/electron";

/**
 * Converse: talk to Claude Code about one project folder and hear the reply
 * spoken by the local voice.
 *
 * The session itself lives in the main process and playback lives in the
 * overlay renderer, because both have to survive this window being closed.
 * This page is a view onto that session: it reads `converseGetState()` on a
 * short interval rather than subscribing to `converse-sentence`, because those
 * events are addressed to the overlay (the window that owns the audio). The
 * session's own state carries the same truth — the sentences it has emitted so
 * far, the turn they belong to, and where playback is — so the transcript
 * still fills in sentence by sentence while the answer is being spoken.
 */

/** Remembered project folders, most recent first. */
const PROJECTS_KEY = "converseProjects";
const MAX_REMEMBERED_PROJECTS = 8;

/** Fast enough that sentences appear while they are still being spoken. */
const POLL_MS = 200;

type RememberedProject = { path: string; lastUsedAt: number };

type TranscriptTurn =
  | { kind: "user"; gen: number; text: string }
  | {
      kind: "assistant";
      gen: number;
      sentences: string[];
      /** Sentence that was playing when the user interrupted; null if it ran to the end. */
      cutIndex: number | null;
    };

/** The shape of `lastInterrupt` this page reads; the session records more. */
type InterruptRecord = {
  at?: number;
  from?: string;
  playerWas?: { playIndex?: number } | null;
};

/**
 * The state machine's own word for what is happening, capitalized. The word is
 * the system state; the line under it says what that means right now, so
 * "Listening" cannot be mistaken for a microphone that is recording.
 */
const STATE_LABELS: Record<string, string> = {
  idle: "Idle",
  thinking: "Thinking",
  speaking: "Speaking",
  listening: "Listening",
  stopped: "Stopped",
};

const STATE_DOT: Record<string, string> = {
  idle: "bg-muted-foreground/50",
  thinking: "bg-info",
  speaking: "bg-primary",
  listening: "bg-muted-foreground/50",
  stopped: "bg-muted-foreground/50",
};

function folderName(fullPath: string): string {
  const parts = fullPath.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || fullPath;
}

function readProjects(): RememberedProject[] {
  try {
    const raw = localStorage.getItem(PROJECTS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry) => entry && typeof entry.path === "string" && entry.path.trim())
      .map((entry) => ({ path: entry.path, lastUsedAt: Number(entry.lastUsedAt) || 0 }))
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
      .slice(0, MAX_REMEMBERED_PROJECTS);
  } catch {
    return [];
  }
}

function writeProjects(list: RememberedProject[]): void {
  try {
    localStorage.setItem(PROJECTS_KEY, JSON.stringify(list.slice(0, MAX_REMEMBERED_PROJECTS)));
  } catch {
    // A folder the app forgets costs one extra click, never the session.
  }
}

/** Why an utterance bounced, in words that say what to do about it. */
function refusalMessage(reason?: string): string {
  switch (reason) {
    case "busy":
      return "Claude Code is still working on the previous message.";
    case "agent-unavailable":
      return "Claude Code is not answering. Check that the claude command runs in a terminal.";
    case "session-stopped":
      return "This session has stopped. Start it again to keep talking.";
    case "not-started":
      return "No session is running.";
    default:
      return "That message was not sent.";
  }
}

function SettingsPanel({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border-subtle/50 bg-surface-raised/50 divide-y divide-border-subtle/30 overflow-hidden">
      {children}
    </div>
  );
}

function SettingsPanelRow({ children }: { children: React.ReactNode }) {
  return <div className="px-5 py-4">{children}</div>;
}

export default function ConversePage() {
  const isUnlocked = isFeatureUnlocked("converse");

  const [projects, setProjects] = useState<RememberedProject[]>(() => readProjects());
  const [projectPath, setProjectPath] = useState<string | null>(null);
  const [muteWhileSpeaking, setMuteWhileSpeaking] = useLocalStorage<boolean>(
    "converseMuteWhileSpeaking",
    true
  );

  const [sessionActive, setSessionActive] = useState(false);
  const [starting, setStarting] = useState(false);
  const [liveState, setLiveState] = useState<ConverseState | null>(null);
  const [transcript, setTranscript] = useState<TranscriptTurn[]>([]);
  const [draft, setDraft] = useState("");
  const [startError, setStartError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);

  const lastInterruptAtRef = useRef(0);
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);

  const state = liveState?.state ?? "stopped";
  const isSpeaking = sessionActive && state === "speaking";
  const isThinking = sessionActive && state === "thinking";

  const rememberProject = useCallback((path: string) => {
    setProjects((current) => {
      const next = [
        { path, lastUsedAt: Date.now() },
        ...current.filter((entry) => entry.path !== path),
      ].slice(0, MAX_REMEMBERED_PROJECTS);
      writeProjects(next);
      return next;
    });
  }, []);

  const forgetProject = useCallback((path: string) => {
    setProjects((current) => {
      const next = current.filter((entry) => entry.path !== path);
      writeProjects(next);
      return next;
    });
  }, []);

  /** Fold one poll of the session state into the transcript. */
  const applyState = useCallback((next: ConverseState) => {
    const utterance = next.lastUtterance ?? null;
    const sentences = next.lastResponse?.sentences ?? [];

    // An interrupt bumps the turn generation while the reply is still on
    // screen, so the cut is recorded against the utterance that produced it.
    const interrupt = (next.lastInterrupt ?? null) as InterruptRecord | null;
    let mark: { gen: number; index: number } | null = null;
    if (
      interrupt &&
      typeof interrupt.at === "number" &&
      interrupt.at !== lastInterruptAtRef.current
    ) {
      lastInterruptAtRef.current = interrupt.at;
      if (interrupt.from === "speaking" && utterance) {
        mark = { gen: utterance.gen, index: interrupt.playerWas?.playIndex ?? 0 };
      }
    }
    const cutMark = mark;

    setTranscript((current) => {
      let updated = current;

      if (
        utterance &&
        !updated.some((turn) => turn.kind === "user" && turn.gen === utterance.gen)
      ) {
        updated = [...updated, { kind: "user", gen: utterance.gen, text: utterance.text }];
      }

      if (utterance && sentences.length > 0) {
        const at = updated.findIndex(
          (turn) => turn.kind === "assistant" && turn.gen === utterance.gen
        );
        if (at === -1) {
          updated = [
            ...updated,
            { kind: "assistant", gen: utterance.gen, sentences: [...sentences], cutIndex: null },
          ];
        } else {
          const existing = updated[at] as Extract<TranscriptTurn, { kind: "assistant" }>;
          if (existing.sentences.length !== sentences.length) {
            updated = updated.slice();
            updated[at] = { ...existing, sentences: [...sentences] };
          }
        }
      }

      if (cutMark) {
        const at = updated.findIndex(
          (turn) => turn.kind === "assistant" && turn.gen === cutMark.gen
        );
        if (at >= 0) {
          const existing = updated[at] as Extract<TranscriptTurn, { kind: "assistant" }>;
          updated = updated.slice();
          updated[at] = {
            ...existing,
            cutIndex: Math.min(cutMark.index, Math.max(0, existing.sentences.length - 1)),
          };
        }
      }

      return updated;
    });
  }, []);

  // A session started before this page was opened is still the live one, so the
  // page joins it instead of pretending nothing is running.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const current = await window.electronAPI?.converseGetState?.();
        if (cancelled || !current?.running) return;
        setLiveState(current);
        setSessionActive(true);
        if (current.cwd) setProjectPath(current.cwd);
        applyState(current);
      } catch {
        // No session; the page opens on the picker.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [applyState]);

  useEffect(() => {
    if (!sessionActive) return undefined;
    let cancelled = false;

    const tick = async () => {
      try {
        const next = await window.electronAPI?.converseGetState?.();
        if (cancelled || !next) return;
        setLiveState(next);
        applyState(next);
        if (!next.running) setSessionActive(false);
      } catch {
        // A dropped poll is re-tried on the next tick.
      }
    };

    void tick();
    const timer = window.setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [sessionActive, applyState]);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ block: "end" });
  }, [transcript]);

  const handleChooseFolder = useCallback(async () => {
    const result = await window.electronAPI?.showOpenDialog?.({
      title: "Choose the project folder Claude Code should work in",
      properties: ["openDirectory"],
    });
    const chosen = result && !result.canceled ? result.filePaths[0] : null;
    if (!chosen) return;
    setProjectPath(chosen);
    rememberProject(chosen);
  }, [rememberProject]);

  const handleStart = useCallback(async () => {
    if (!projectPath) return;
    setStarting(true);
    setStartError(null);
    setSendError(null);
    try {
      const started = await window.electronAPI.converseStart({ cwd: projectPath });
      lastInterruptAtRef.current = 0;
      setTranscript([]);
      setLiveState(started);
      setSessionActive(true);
      rememberProject(projectPath);
    } catch (error) {
      setStartError(error instanceof Error ? error.message : String(error));
    } finally {
      setStarting(false);
    }
  }, [projectPath, rememberProject]);

  const handleSend = useCallback(async () => {
    const text = draft.trim();
    if (!text) return;
    setSendError(null);
    setDraft("");
    try {
      const result = await window.electronAPI.converseSendUtterance(text);
      if (!result?.accepted) {
        setDraft(text);
        setSendError(refusalMessage(result?.reason));
        return;
      }
      // Echoed straight away rather than waiting for the next poll, so the
      // message appears in the transcript as it is sent.
      if (typeof result.turnGen === "number") {
        const gen = result.turnGen;
        setTranscript((current) =>
          current.some((turn) => turn.kind === "user" && turn.gen === gen)
            ? current
            : [...current, { kind: "user", gen, text }]
        );
      }
    } catch (error) {
      setDraft(text);
      setSendError(error instanceof Error ? error.message : String(error));
    }
  }, [draft]);

  const handleInterrupt = useCallback(async () => {
    try {
      await window.electronAPI.converseInterrupt("interrupted from the Converse page");
    } catch {
      // The session is already gone; the next poll clears the view.
    }
  }, []);

  const handleStop = useCallback(async () => {
    try {
      await window.electronAPI.converseStop();
    } catch {
      // Already stopped.
    }
    setSessionActive(false);
    setLiveState(null);
    setTranscript([]);
    lastInterruptAtRef.current = 0;
  }, []);

  /**
   * "3 of 8" once the whole answer has arrived, "3" while it is still being
   * written. The sentence count is only final at turn end, and a total that
   * silently grows while the user reads it is worse than no total at all.
   */
  const speakingPosition = useMemo(() => {
    const player = liveState?.player;
    if (!player) return null;
    const spoken = player.playIndex + 1;
    if (!player.total) return player.known > 0 ? `${spoken}` : null;
    return `${Math.min(spoken, player.total)} of ${player.total}`;
  }, [liveState]);

  const statusHelp = (() => {
    switch (state) {
      case "idle":
        return "Session ready. Send the first message.";
      case "thinking":
        return "Claude Code is working on your message.";
      case "speaking":
        return speakingPosition
          ? `Reading sentence ${speakingPosition} out loud.`
          : "Reading the reply out loud.";
      case "listening":
        return "Claude Code has finished. Your turn.";
      default:
        return "No session is running.";
    }
  })();

  return (
    <div className="p-8 max-w-4xl mx-auto">
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-2">
          <MessagesSquare size={28} className="text-primary" />
          <h1 className="text-3xl font-semibold text-foreground tracking-tight">Converse</h1>
          <BetaBadge locked={!isUnlocked} />
        </div>
        <p className="text-sm text-muted-foreground">
          Ask Claude Code about one project folder and hear the answer spoken by the local voice
        </p>
      </div>

      {!isUnlocked && (
        <div className="rounded-xl border border-primary/20 bg-primary/5 p-6 text-center space-y-3">
          <Lock size={24} className="mx-auto text-primary/60" />
          <h3 className="text-base font-semibold text-foreground">Talk to Claude Code out loud</h3>
          <p className="text-sm text-muted-foreground max-w-md mx-auto leading-relaxed">
            Converse points the Claude Code CLI at a folder on this machine and speaks its replies
            with the on-device voice model. The conversation reaches Claude Code exactly as it would
            from a terminal. This unfinished beta requires approved tester access.
          </p>
          <BetaAccessLink className="text-sm" />
        </div>
      )}

      {isUnlocked && !sessionActive && (
        <div className="space-y-8">
          <div>
            <SectionLabel className="mb-3">Project folder</SectionLabel>
            <SettingsPanel>
              <SettingsPanelRow>
                {projectPath ? (
                  <div className="flex items-center justify-between gap-4">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-foreground truncate">
                        {folderName(projectPath)}
                      </p>
                      <p
                        className="text-[12px] text-muted-foreground font-mono truncate"
                        data-testid="converse-project-path"
                      >
                        {projectPath}
                      </p>
                    </div>
                    <Button variant="ghost" size="sm" onClick={() => setProjectPath(null)}>
                      Change folder
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <p className="text-[13px] text-muted-foreground leading-relaxed">
                      Claude Code runs inside the folder you choose, the same as it would in a
                      terminal opened there.
                    </p>
                    <Button onClick={handleChooseFolder} className="gap-2">
                      <FolderOpen size={15} />
                      Choose a project folder
                    </Button>
                  </div>
                )}
              </SettingsPanelRow>

              {!projectPath && projects.length > 0 && (
                <SettingsPanelRow>
                  <SectionLabel className="mb-2">Recent folders</SectionLabel>
                  <div className="divide-y divide-border-subtle/30">
                    {projects.map((entry) => (
                      <div key={entry.path} className="flex items-center gap-2 py-1.5">
                        <button
                          type="button"
                          data-testid="converse-recent-project"
                          onClick={() => {
                            setProjectPath(entry.path);
                            rememberProject(entry.path);
                          }}
                          className="min-w-0 flex-1 rounded-md px-2 py-1 text-left transition-colors hover:bg-surface-2"
                        >
                          <span className="block text-[13px] text-foreground truncate">
                            {folderName(entry.path)}
                          </span>
                          <span className="block text-[11px] text-muted-foreground font-mono truncate">
                            {entry.path}
                          </span>
                        </button>
                        <button
                          type="button"
                          aria-label={`Forget ${entry.path}`}
                          onClick={() => forgetProject(entry.path)}
                          className="shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground"
                        >
                          <X size={13} />
                        </button>
                      </div>
                    ))}
                  </div>
                </SettingsPanelRow>
              )}
            </SettingsPanel>
          </div>

          {projectPath && (
            <>
              <div>
                <SectionLabel className="mb-3">Session</SectionLabel>
                <SettingsPanel>
                  <SettingsPanelRow>
                    <SettingsRow
                      label="Agent"
                      description="Converse talks to the Claude Code CLI installed on this machine. It is the only agent in this release."
                    >
                      <span className="text-sm text-foreground">Claude Code</span>
                    </SettingsRow>
                  </SettingsPanelRow>

                  <SettingsPanelRow>
                    <SettingsRow
                      label="Mute my microphone while Claude Code speaks"
                      description="Stops the spoken reply being picked up as your next sentence. Saved now, used once voice input reaches this page."
                    >
                      <Toggle checked={muteWhileSpeaking} onChange={setMuteWhileSpeaking} />
                    </SettingsRow>
                  </SettingsPanelRow>

                  <SettingsPanelRow>
                    <InfoBox variant="muted" className="p-3">
                      <div className="flex items-start gap-2.5">
                        <Headphones size={15} className="mt-px shrink-0 text-muted-foreground" />
                        <p className="text-[12px] text-muted-foreground leading-relaxed">
                          Headphones recommended. Out of speakers, the microphone hears the reply
                          and treats it as your next sentence.
                        </p>
                      </div>
                    </InfoBox>
                  </SettingsPanelRow>
                </SettingsPanel>
              </div>

              {startError && (
                <InfoBox variant="warning" className="p-4">
                  <p className="text-[13px] text-foreground leading-relaxed">{startError}</p>
                  {/* This hint only applies to the voice-model-missing failure; a
                      Claude Code CLI problem needs no mention of Settings. */}
                  {startError.startsWith("The voice model is not installed") && (
                    <p className="text-[12px] text-muted-foreground mt-1">
                      The voice model is downloaded in Settings, under Read Aloud.
                    </p>
                  )}
                </InfoBox>
              )}

              <div className="flex items-center gap-3">
                <Button onClick={handleStart} disabled={starting} className="gap-2">
                  <MessagesSquare size={15} />
                  {starting ? "Starting session" : "Start session"}
                </Button>
                <span className="text-[12px] text-muted-foreground">
                  Starts Claude Code in {folderName(projectPath)}.
                </span>
              </div>
            </>
          )}
        </div>
      )}

      {isUnlocked && sessionActive && (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-4 rounded-xl border border-border-subtle/50 bg-surface-raised/50 px-5 py-3.5">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span
                  data-testid="converse-status"
                  data-state={state}
                  className="inline-flex items-center gap-2 text-sm font-medium text-foreground"
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${STATE_DOT[state] || "bg-muted-foreground/50"}`}
                    aria-hidden
                  />
                  {STATE_LABELS[state] || state}
                </span>
                <span className="text-[12px] text-muted-foreground truncate">{statusHelp}</span>
              </div>
              <p className="text-[11px] text-muted-foreground/70 font-mono truncate mt-1">
                {liveState?.cwd || projectPath}
              </p>
            </div>

            <div className="flex shrink-0 items-center gap-2">
              {isSpeaking && (
                <Button variant="outline" size="sm" onClick={handleInterrupt} className="gap-1.5">
                  {/* Filled: an outlined square reads as a checkbox, not stop. */}
                  <Square size={13} fill="currentColor" />
                  Interrupt
                </Button>
              )}
              <Button variant="ghost" size="sm" onClick={handleStop}>
                Stop session
              </Button>
            </div>
          </div>

          {liveState?.agentMode === "mock" && (
            <InfoBox variant="warning" className="p-3">
              <p className="text-[12px] text-foreground leading-relaxed">
                Claude Code returned an error, so you are hearing the built-in stand-in reply
                instead of a real answer.
                {liveState.lastError ? ` It said: ${liveState.lastError}` : ""}
              </p>
            </InfoBox>
          )}

          <div
            data-testid="converse-transcript"
            className="min-h-[280px] max-h-[420px] overflow-y-auto rounded-xl border border-border-subtle/50 bg-surface-raised/50 px-5 py-4"
          >
            {transcript.length === 0 ? (
              <p className="text-[13px] text-muted-foreground">
                Nothing said yet. The conversation appears here as it is spoken.
              </p>
            ) : (
              <div className="space-y-5">
                {transcript.map((turn) =>
                  turn.kind === "user" ? (
                    <div key={`user-${turn.gen}`} className="space-y-1">
                      <SectionLabel as="span" className="block">
                        You
                      </SectionLabel>
                      <p className="text-[13px] leading-relaxed text-foreground">{turn.text}</p>
                    </div>
                  ) : (
                    <div key={`assistant-${turn.gen}`} className="space-y-1">
                      <SectionLabel as="span" className="block text-primary/70">
                        Claude Code
                      </SectionLabel>
                      <p className="text-[13px] leading-relaxed text-foreground">
                        {turn.sentences.map((sentence, index) => (
                          <React.Fragment key={index}>
                            <span
                              className={
                                turn.cutIndex !== null && index > turn.cutIndex
                                  ? "text-muted-foreground/45"
                                  : undefined
                              }
                            >
                              {sentence}{" "}
                            </span>
                            {turn.cutIndex === index && (
                              <span
                                data-testid="converse-cut-marker"
                                className="mr-1 inline-flex items-center rounded border border-warning/30 bg-warning/10 px-1.5 py-px align-middle text-[10px] font-medium text-warning"
                              >
                                cut off here
                              </span>
                            )}
                          </React.Fragment>
                        ))}
                      </p>
                      {turn.cutIndex !== null && turn.cutIndex < turn.sentences.length - 1 && (
                        <p className="text-[11px] text-muted-foreground">
                          You interrupted, so the greyed text was never spoken. Claude Code is told
                          which sentences you heard.
                        </p>
                      )}
                    </div>
                  )
                )}
                <div ref={transcriptEndRef} />
              </div>
            )}
          </div>

          {sendError && <p className="text-[12px] text-destructive">{sendError}</p>}

          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Input
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void handleSend();
                }}
                placeholder="Type to Claude Code"
                disabled={isThinking || isSpeaking}
                className="flex-1"
                data-testid="converse-input"
              />
              <Button
                onClick={handleSend}
                disabled={!draft.trim() || isThinking || isSpeaking}
                className="gap-1.5"
              >
                <Send size={14} />
                Send
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground/70">
              Voice input reaches this page in a later build. For now the conversation is typed and
              the reply is spoken.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
