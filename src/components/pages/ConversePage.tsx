import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  MessagesSquare,
  FolderOpen,
  Headphones,
  Square,
  Send,
  X,
  KeyRound,
  Check,
  Mic,
  MicOff,
  ShieldAlert,
} from "lucide-react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Toggle } from "../ui/toggle";
import { InfoBox } from "../ui/InfoBox";
import { SectionLabel } from "../ui/SectionLabel";
import { SettingsDisclosure } from "../ui/SettingsDisclosure";
import { SettingsRow } from "../ui/SettingsSection";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { VoicePicker } from "../ui/VoicePicker";
import { getTranscriptionProvider } from "../../models/ModelRegistry";
import {
  DEFAULT_KOKORO_VOICE_ID,
  KOKORO_MODEL_ID,
  VOICE_STORAGE_KEY,
} from "../../models/kokoroVoices";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useConverseVoice, type ConverseVoicePhase } from "../../hooks/useConverseVoice";
import { END_OF_TURN_CHOICES, VAD_DEFAULT_END_OF_TURN_MS } from "../../utils/converseVad";
import type {
  ConversePermissionEntry,
  ConverseState,
  KokoroModelStatus,
} from "../../types/electron";

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

/** Start of the main process's refusal for an untrusted folder (converseAgent.js). */
const FOLDER_TRUST_REQUIRED = "This folder has Claude Code settings you have not trusted yet";

type FolderTrustFile = { file: string; sha256: string; status: "new" | "changed" | "trusted" };
type FolderTrustCheck = {
  needsTrust: boolean;
  reason: "no-config" | "untrusted" | "changed" | "trusted";
  files: FolderTrustFile[];
};
/** The two folder-trust channels preload.js exposes for this page. */
type FolderTrustApi = {
  converseCheckFolderTrust?: (cwd: string) => Promise<FolderTrustCheck>;
  converseTrustFolder?: (cwd: string, shownFiles: FolderTrustFile[]) => Promise<FolderTrustCheck>;
};
const folderTrustApi = () => window.electronAPI as unknown as FolderTrustApi | undefined;

/** Electron wraps invoke rejections; keep only the sentence written for the user. */
function invokeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, "");
}

type RememberedProject = { path: string; lastUsedAt: number };

type TranscriptTurn =
  | { kind: "user"; gen: number; text: string }
  | {
      kind: "assistant";
      gen: number;
      sentences: string[];
      /** Sentence that was playing when the user interrupted; null if it ran to the end. */
      cutIndex: number | null;
    }
  /**
   * A permission question, held by id only. Its live content is looked up in
   * the relay's own log on every poll, so a question can never be shown as
   * pending after the relay has already settled it.
   */
  | { kind: "permission"; id: number };

/** Longest the one-line summary on a settled record gets. */
const MAX_SUMMARY_CHARS = 72;

/** Keys worth leading with, in the order a person would look for them. */
const SUMMARY_KEYS = ["file_path", "command", "path", "pattern", "url", "notebook_path", "prompt"];

function truncate(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function stringifyValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Every field of the tool input, whole: Allow approves the full input, so the
 * card never cuts, collapses or drops anything the user is agreeing to.
 */
function permissionInputRows(input: unknown): { key: string; value: string }[] {
  if (input === null || input === undefined) return [];
  if (typeof input !== "object" || Array.isArray(input)) {
    return [{ key: "", value: stringifyValue(input) }];
  }
  const entries = Object.entries(input as Record<string, unknown>);
  const ordered = [
    ...entries.filter(([key]) => SUMMARY_KEYS.includes(key)),
    ...entries.filter(([key]) => !SUMMARY_KEYS.includes(key)),
  ];
  return ordered.map(([key, value]) => ({ key, value: stringifyValue(value) }));
}

/** The single most telling value, for the one-line record after it is settled. */
function inputSummary(input: unknown): string {
  const rows = permissionInputRows(input);
  if (rows.length === 0) return "";
  const lead = rows.find((row) => SUMMARY_KEYS.includes(row.key)) ?? rows[0];
  return truncate(lead.value, MAX_SUMMARY_CHARS);
}

/**
 * What the relay recorded, in the user's words. Only `answeredWith` decides
 * allow vs deny; `answeredBy` only ever changes the explanation after it.
 */
function permissionVerdict(entry: ConversePermissionEntry): {
  verdict: string;
  note: string;
  allowed: boolean;
} {
  const allowed = entry.answeredWith === "allow";
  if (allowed) return { verdict: "Allowed", note: "", allowed };
  if (entry.answeredBy === "timeout") {
    return { verdict: "Denied", note: "denied automatically, no answer", allowed };
  }
  if (entry.answeredBy === "session-stopped") {
    return { verdict: "Denied", note: "session stopped before you answered", allowed };
  }
  return { verdict: "Denied", note: "", allowed };
}

/** The shape of `lastInterrupt` this page reads; the session records more. */
type InterruptRecord = {
  at?: number;
  from?: string;
  playerWas?: { playIndex?: number; gen?: number } | null;
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

/**
 * One unanswered permission question, in the conversation where it happened.
 *
 * The countdown is cosmetic and says so by only ever counting down: the relay
 * owns the deadline and records the outcome, and this card disappears when the
 * log says the question is settled — not when the number reaches zero.
 */
export function PermissionCard({
  entry,
  nowMs,
  busy,
  position,
  total,
  onAnswer,
}: {
  entry: ConversePermissionEntry;
  nowMs: number;
  busy: boolean;
  position: number;
  total: number;
  onAnswer: (id: number, behavior: "allow" | "deny") => void;
}) {
  const rows = useMemo(() => permissionInputRows(entry.input), [entry.input]);
  const inputRef = useRef<HTMLDivElement | null>(null);
  const [overflowing, setOverflowing] = useState(false);

  // Says so when the block scrolls, so the bottom of a long command is never
  // hidden without a word.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return undefined;
    const measure = () => setOverflowing(el.scrollHeight > el.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [rows]);

  const secondsLeft =
    typeof entry.deadline === "number"
      ? Math.max(0, Math.ceil((entry.deadline - nowMs) / 1000))
      : null;

  // Neutral frame on purpose: the pending card must not borrow the affirmative
  // green and lean the eye toward Allow before the question has been read.
  return (
    <div
      data-testid="converse-permission-card"
      data-permission-id={entry.id}
      className="rounded-lg border border-border bg-surface-raised/40 px-4 py-3.5 space-y-3"
    >
      <div className="flex items-start gap-2.5">
        <KeyRound size={15} className="mt-0.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex items-baseline gap-2">
            <span className="text-[13px] text-muted-foreground">Claude Code wants to use</span>
            <span
              data-testid="converse-permission-tool"
              className="text-sm font-semibold text-foreground"
            >
              {entry.tool_name || "an unnamed tool"}
            </span>
            {total > 1 && (
              <span
                data-testid="converse-permission-queue"
                className="text-[11px] text-muted-foreground"
              >
                Question {position} of {total}
              </span>
            )}
          </div>

          {rows.length > 0 && (
            <div className="space-y-1.5">
              <div
                ref={inputRef}
                data-testid="converse-permission-input"
                tabIndex={0}
                aria-label="Everything Allow approves"
                className="max-h-64 overflow-auto rounded-md border border-border-subtle/60 bg-surface-1 px-3 py-2.5 space-y-2.5 font-mono text-[12px] leading-relaxed focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/30"
              >
                {rows.map((row, index) => (
                  <div key={row.key || index} data-testid="converse-permission-field">
                    {row.key && <div className="text-muted-foreground/70">{row.key}</div>}
                    <pre className="m-0 whitespace-pre-wrap [overflow-wrap:anywhere] font-mono text-foreground">
                      {row.value}
                    </pre>
                  </div>
                ))}
              </div>
              {overflowing && (
                <p
                  data-testid="converse-permission-scroll-hint"
                  className="text-[11px] text-muted-foreground"
                >
                  Scroll the box to read all of it. Allow approves everything in it.
                </p>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 pl-[26px]">
        <span
          data-testid="converse-permission-countdown"
          className="text-[12px] font-medium text-foreground/80"
        >
          {secondsLeft === null
            ? "Denies itself if you do not answer."
            : secondsLeft > 0
              ? `Denies itself in ${secondsLeft}s`
              : "Denying now"}
        </span>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => onAnswer(entry.id, "deny")}
          >
            Deny
          </Button>
          <Button size="sm" disabled={busy} onClick={() => onAnswer(entry.id, "allow")}>
            Allow
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * Asked before Claude Code starts in a folder that carries its own Claude Code
 * files, because --print mode loads them without the CLI's own trust prompt.
 */
export function FolderTrustPrompt({
  check,
  busy,
  onTrust,
  onCancel,
}: {
  check: FolderTrustCheck;
  busy: boolean;
  onTrust: () => void;
  onCancel: () => void;
}) {
  const changed = check.reason === "changed";
  return (
    <InfoBox variant="warning" className="p-4 space-y-3" data-testid="converse-folder-trust">
      <div className="flex items-start gap-2.5">
        <ShieldAlert size={16} className="mt-0.5 shrink-0 text-warning" aria-hidden />
        <div className="min-w-0 space-y-1.5">
          <p className="text-sm font-medium text-foreground">
            {changed
              ? "This folder's Claude Code files changed since you trusted it"
              : "Trust this folder's Claude Code files?"}
          </p>
          <p className="text-[13px] text-muted-foreground leading-relaxed">
            Claude Code loads these from the folder without asking. Hooks in its settings can run
            commands on this computer, .mcp.json can start MCP servers, and a skill can pre-approve
            tools so no permission question appears here. CLAUDE.md, AGENTS.md, agents, skills and
            commands are instructions it follows. Trust the folder only if you know where these
            files came from.
          </p>
        </div>
      </div>

      <ul
        data-testid="converse-folder-trust-files"
        className="max-h-48 overflow-y-auto rounded-md border border-border-subtle/60 bg-surface-1 px-3 py-2 space-y-1 font-mono text-[12px]"
      >
        {check.files.map((entry) => (
          <li key={entry.file} className="flex items-center justify-between gap-3">
            <span className="min-w-0 [overflow-wrap:anywhere] text-foreground">{entry.file}</span>
            {changed && entry.status !== "trusted" && (
              <span className="shrink-0 font-sans text-[11px] font-medium text-warning">
                {entry.status === "new" ? "New" : "Changed"}
              </span>
            )}
          </li>
        ))}
      </ul>

      <div className="flex items-center justify-end gap-2">
        <Button variant="outline" size="sm" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" disabled={busy} onClick={onTrust}>
          {busy ? "Starting session" : "Trust and start"}
        </Button>
      </div>
    </InfoBox>
  );
}

/** A settled question, collapsed to the one line it is worth afterwards. */
function PermissionRecord({ entry }: { entry: ConversePermissionEntry }) {
  const { verdict, note, allowed } = permissionVerdict(entry);
  const summary = inputSummary(entry.input);

  return (
    <div
      data-testid="converse-permission-record"
      data-permission-id={entry.id}
      data-behavior={entry.answeredWith}
      data-answered-by={entry.answeredBy || "user"}
      className="flex items-center gap-2 text-[12px] text-muted-foreground"
    >
      {allowed ? (
        <Check size={13} className="shrink-0 text-success" aria-hidden />
      ) : (
        <X size={13} className="shrink-0 text-muted-foreground" aria-hidden />
      )}
      <span className="text-foreground">
        {verdict} {entry.tool_name || "a tool"}
      </span>
      {summary && <span className="min-w-0 truncate font-mono">· {summary}</span>}
      {note && <span className="shrink-0">· {note}</span>}
    </div>
  );
}

/** What the microphone is doing, in the words a listener needs. */
const VOICE_PHASE_TEXT: Record<ConverseVoicePhase, string> = {
  off: "Voice is off. Type below, or switch the microphone on.",
  starting: "Opening the microphone.",
  listening: "Listening. Say your piece, then pause and it sends.",
  hearing: "Hearing you. Pause when you are done.",
  transcribing: "Writing down what you said.",
  muted: "Microphone closed while Claude Code speaks.",
  error: "The microphone is not available.",
};

/** Bars in the level meter. Enough to read as a level, few enough to stay calm. */
const METER_BARS = 14;

/**
 * The live microphone, as one row: whether it is open, what it can hear, and
 * what it is doing with it. The meter is the proof — a status line that says
 * "listening" while the bars stay flat is how a dead microphone goes unnoticed
 * for a whole conversation.
 */
function VoiceBar({
  phase,
  level,
  error,
  notice,
  enabled,
  onToggle,
  onRetry,
}: {
  phase: ConverseVoicePhase;
  level: number;
  error: string | null;
  notice: string | null;
  enabled: boolean;
  onToggle: (next: boolean) => void;
  onRetry: () => void;
}) {
  const live = phase === "listening" || phase === "hearing" || phase === "transcribing";
  const lit = Math.round(Math.min(1, Math.max(0, level)) * METER_BARS);

  return (
    <div
      data-testid="converse-voice"
      data-phase={phase}
      className="rounded-xl border border-border-subtle/50 bg-surface-raised/50 px-4 py-3 space-y-2"
    >
      <div className="flex items-center gap-3">
        <Button
          variant={enabled ? "default" : "outline"}
          size="sm"
          data-testid="converse-voice-toggle"
          aria-pressed={enabled}
          onClick={() => onToggle(!enabled)}
          className="gap-1.5 shrink-0"
        >
          {enabled ? <Mic size={14} /> : <MicOff size={14} />}
          {enabled ? "Voice on" : "Voice off"}
        </Button>

        {/* Only while the microphone is actually open. A meter beside "Voice
            off" or an error would be measuring nothing. */}
        <div
          data-testid="converse-voice-level"
          data-level={lit}
          aria-hidden
          className={`flex items-end gap-[3px] h-5 shrink-0 ${
            phase === "off" || phase === "error" ? "hidden" : ""
          }`}
        >
          {Array.from({ length: METER_BARS }, (_, index) => {
            // Height rises across the row so a quiet room still reads as a
            // shape rather than a flat line of identical dots.
            const height = 6 + Math.round((index / (METER_BARS - 1)) * 12);
            const on = live && index < lit;
            return (
              <span
                key={index}
                style={{ height }}
                className={`w-[3px] rounded-full transition-colors duration-75 ${
                  on ? "bg-primary" : "bg-border-subtle"
                }`}
              />
            );
          })}
        </div>

        {/* Never truncated: the only long line here is the microphone error,
            and the half of it that would be cut is the part that says what to
            do about it. */}
        <span
          data-testid="converse-voice-state"
          className={`min-w-0 flex-1 text-[12px] leading-relaxed ${
            phase === "error" ? "text-warning" : "text-muted-foreground"
          }`}
        >
          {phase === "error" && error ? error : VOICE_PHASE_TEXT[phase]}
        </span>

        {phase === "error" && (
          <Button variant="outline" size="sm" onClick={onRetry} className="shrink-0">
            Try again
          </Button>
        )}
      </div>

      {notice && phase !== "error" && (
        <p className="text-[11px] text-warning" data-testid="converse-voice-notice">
          {notice}
        </p>
      )}
    </div>
  );
}

export default function ConversePage() {
  const [projects, setProjects] = useState<RememberedProject[]>(() => readProjects());
  const [projectPath, setProjectPath] = useState<string | null>(null);
  const [muteWhileSpeaking, setMuteWhileSpeaking] = useLocalStorage<boolean>(
    "converseMuteWhileSpeaking",
    true
  );
  /**
   * Hands-free. On by default because this page is for talking, but it only
   * ever opens the microphone while a session is actually running — starting
   * the app never does.
   */
  const [voiceEnabled, setVoiceEnabled] = useLocalStorage<boolean>("converseVoiceEnabled", true);
  const [endOfTurnMs, setEndOfTurnMs] = useLocalStorage<number>(
    "converseEndOfTurnMs",
    VAD_DEFAULT_END_OF_TURN_MS
  );
  /**
   * The app's one voice, the same value the Read Aloud page writes. Stored raw,
   * not JSON: the overlay's ConversePlayer reads this key straight out of
   * localStorage at the start of every turn, and a quoted copy would reach
   * Kokoro as `"bm_lewis"` and be rejected as an unknown voice.
   */
  const [voiceId, setVoiceId] = useLocalStorage(VOICE_STORAGE_KEY, DEFAULT_KOKORO_VOICE_ID, {
    serialize: String,
    deserialize: String,
  });

  /**
   * Whether the voice model is on this machine. Converse cannot speak without
   * it, so the picker is only offered when previewing a voice would actually
   * make a sound — the same rule the Read Aloud page uses.
   */
  const [voiceModelInstalled, setVoiceModelInstalled] = useState(false);

  // Read, never written here: speech goes wherever the app's own transcription
  // setting sends it. The page says which of the two it is rather than claiming
  // "local" for a user who has chosen a cloud provider.
  const [useLocalWhisper] = useLocalStorage("useLocalWhisper", false, {
    serialize: String,
    deserialize: (value) => value === "true",
  });
  const [cloudTranscriptionProvider] = useLocalStorage("cloudTranscriptionProvider", "openai", {
    serialize: String,
    deserialize: String,
  });

  const [sessionActive, setSessionActive] = useState(false);
  const [starting, setStarting] = useState(false);
  const [liveState, setLiveState] = useState<ConverseState | null>(null);
  const [transcript, setTranscript] = useState<TranscriptTurn[]>([]);
  const [draft, setDraft] = useState("");
  const [startError, setStartError] = useState<string | null>(null);
  /** The folder-trust question on screen, or null. Never carried to another folder. */
  const [folderTrust, setFolderTrust] = useState<FolderTrustCheck | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);

  /**
   * The relay's permission log, mirrored verbatim from the last poll. It is the
   * only source of truth for what is pending and what was decided — the page
   * never settles a question on its own.
   */
  const [permissions, setPermissions] = useState<ConversePermissionEntry[]>([]);
  /** Ids whose answer has been sent but not yet seen in the log. */
  const [answering, setAnswering] = useState<number[]>([]);
  /** Re-render clock for the countdown; only ticks while something is pending. */
  const [nowMs, setNowMs] = useState(() => Date.now());

  const lastInterruptAtRef = useRef(0);
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);
  /** Set by the poll effect so an incoming question can pull the next poll in. */
  const refreshRef = useRef<() => void>(() => {});

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

    // All recent replies, by generation — not just the current turn's. A short
    // queued turn can finish inside one poll interval; building from the
    // per-generation history means its reply still lands in the transcript.
    const responses: { gen: number; sentences: string[] }[] =
      next.recentResponses ??
      (next.lastResponse && next.lastResponse.gen !== undefined
        ? [{ gen: next.lastResponse.gen, sentences: next.lastResponse.sentences }]
        : utterance && next.lastResponse
          ? [{ gen: utterance.gen, sentences: next.lastResponse.sentences }]
          : []);

    // An interrupt bumps the turn generation while the reply is still on
    // screen, so the cut is recorded against the turn that was audibly
    // playing — named by the player report captured at the interrupt.
    const interrupt = (next.lastInterrupt ?? null) as InterruptRecord | null;
    let mark: { gen: number; index: number } | null = null;
    if (
      interrupt &&
      typeof interrupt.at === "number" &&
      interrupt.at !== lastInterruptAtRef.current
    ) {
      lastInterruptAtRef.current = interrupt.at;
      const cutGen = interrupt.playerWas?.gen ?? utterance?.gen;
      if (interrupt.from === "speaking" && cutGen !== undefined) {
        mark = { gen: cutGen, index: interrupt.playerWas?.playIndex ?? 0 };
      }
    }
    const cutMark = mark;

    // Mirrored, never merged: an answered question stops being pending because
    // the relay says so, not because this page sent an answer.
    const permissionLog = next.permissionLog ?? [];
    setPermissions(permissionLog);
    setAnswering((current) =>
      current.filter((id) =>
        permissionLog.some((entry) => entry.id === id && entry.answeredWith === null)
      )
    );

    setTranscript((current) => {
      let updated = current;

      if (
        utterance &&
        !updated.some((turn) => turn.kind === "user" && turn.gen === utterance.gen)
      ) {
        updated = [...updated, { kind: "user", gen: utterance.gen, text: utterance.text }];
      }

      for (const response of responses) {
        if (response.sentences.length === 0) continue;
        const at = updated.findIndex(
          (turn) => turn.kind === "assistant" && turn.gen === response.gen
        );
        if (at === -1) {
          updated = [
            ...updated,
            {
              kind: "assistant",
              gen: response.gen,
              sentences: [...response.sentences],
              cutIndex: null,
            },
          ];
        } else {
          const existing = updated[at] as Extract<TranscriptTurn, { kind: "assistant" }>;
          if (existing.sentences.length !== response.sentences.length) {
            updated = updated.slice();
            updated[at] = { ...existing, sentences: [...response.sentences] };
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

      // Appended after this poll's turns, which is where they belong in time:
      // the harness only asks once it is already working on the last message.
      const known = new Set(
        updated.filter((turn) => turn.kind === "permission").map((turn) => turn.id)
      );
      const added = permissionLog
        .filter((entry) => !known.has(entry.id))
        .map((entry) => ({ kind: "permission", id: entry.id }) as TranscriptTurn);
      if (added.length > 0) updated = [...updated, ...added];

      return updated;
    });
  }, []);

  // Asked once, on arrival. The answer only gates a picker, so a failed read is
  // treated as "not installed" rather than retried — the start button already
  // says so properly if the model is really missing.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const status: KokoroModelStatus | undefined =
          await window.electronAPI?.readAloudCheckModelStatus?.(KOKORO_MODEL_ID);
        if (!cancelled) setVoiceModelInstalled(Boolean(status?.installed));
      } catch {
        if (!cancelled) setVoiceModelInstalled(false);
      }
    })();
    return () => {
      cancelled = true;
    };
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

    refreshRef.current = () => void tick();
    void tick();
    const timer = window.setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      refreshRef.current = () => {};
      window.clearInterval(timer);
    };
  }, [sessionActive, applyState]);

  // The question is already in the session state the poll reads, so this only
  // buys back the poll interval — the prompt appears the moment the harness
  // asks instead of up to POLL_MS later. The event is a nudge, never the truth.
  useEffect(() => {
    const off = window.electronAPI?.onConversePermissionRequest?.(() => refreshRef.current());
    return typeof off === "function" ? off : undefined;
  }, []);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ block: "end" });
  }, [transcript]);

  const permissionsById = useMemo(() => {
    const map = new Map<number, ConversePermissionEntry>();
    for (const entry of permissions) map.set(entry.id, entry);
    return map;
  }, [permissions]);

  const pendingPermissions = useMemo(
    () => permissions.filter((entry) => entry.answeredWith === null),
    [permissions]
  );

  /**
   * A pending question is not the agent thinking — it is the agent stopped,
   * waiting on this window. The state machine has no word for that (nothing
   * about the turn has changed), so the label says it instead of `data-state`,
   * which stays the session's own state and nothing else.
   */
  const waitingOnUser = sessionActive && pendingPermissions.length > 0;

  // Only runs while something is actually waiting, so an idle session does no
  // work per second.
  useEffect(() => {
    if (pendingPermissions.length === 0) return undefined;
    setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [pendingPermissions.length]);

  const answerPermission = useCallback(async (id: number, behavior: "allow" | "deny") => {
    setAnswering((current) => (current.includes(id) ? current : [...current, id]));
    try {
      await window.electronAPI.conversePermissionAnswer(id, behavior);
    } catch {
      // The relay is the record. If this never landed, the next poll still
      // shows the question as pending and the deny timeout still protects it.
    }
    refreshRef.current();
  }, []);

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

  useEffect(() => {
    setFolderTrust(null);
  }, [projectPath]);

  /** Start the session itself; the folder has already been checked. */
  const startSession = useCallback(
    async (cwd: string) => {
      try {
        const started = await window.electronAPI.converseStart({ cwd });
        lastInterruptAtRef.current = 0;
        setTranscript([]);
        setPermissions([]);
        setAnswering([]);
        setLiveState(started);
        setSessionActive(true);
        rememberProject(cwd);
      } catch (error) {
        const message = invokeErrorMessage(error);
        // The folder changed between the check and the start: ask again.
        const recheck = message.startsWith(FOLDER_TRUST_REQUIRED)
          ? await folderTrustApi()
              ?.converseCheckFolderTrust?.(cwd)
              .catch(() => undefined)
          : undefined;
        if (recheck?.needsTrust) setFolderTrust(recheck);
        else setStartError(message);
      }
    },
    [rememberProject]
  );

  const handleStart = useCallback(async () => {
    if (!projectPath) return;
    setStarting(true);
    setStartError(null);
    setSendError(null);
    try {
      const check = await folderTrustApi()?.converseCheckFolderTrust?.(projectPath);
      if (check?.needsTrust) {
        setFolderTrust(check);
        return;
      }
      await startSession(projectPath);
    } catch (error) {
      setStartError(invokeErrorMessage(error));
    } finally {
      setStarting(false);
    }
  }, [projectPath, startSession]);

  const handleTrustAndStart = useCallback(async () => {
    if (!projectPath || !folderTrust) return;
    setStarting(true);
    setStartError(null);
    setSendError(null);
    try {
      await folderTrustApi()?.converseTrustFolder?.(projectPath, folderTrust.files);
      setFolderTrust(null);
      await startSession(projectPath);
    } catch (error) {
      setStartError(invokeErrorMessage(error));
    } finally {
      setStarting(false);
    }
  }, [projectPath, folderTrust, startSession]);

  /**
   * The one way a turn leaves this page. The microphone calls exactly what the
   * text box calls, so a spoken turn and a typed one are the same event as far
   * as the session, the transcript, and the agent are concerned.
   *
   * @returns the message when it was refused, so the caller can put it back
   *   where the user can see it; null when it was accepted.
   */
  const submitUtterance = useCallback(async (text: string): Promise<string | null> => {
    const utterance = text.trim();
    if (!utterance) return null;
    setSendError(null);
    try {
      const result = await window.electronAPI.converseSendUtterance(utterance);
      if (!result?.accepted) {
        setSendError(refusalMessage(result?.reason));
        return utterance;
      }
      // Echoed straight away rather than waiting for the next poll, so the
      // message appears in the transcript as it is sent.
      if (typeof result.turnGen === "number") {
        const gen = result.turnGen;
        setTranscript((current) =>
          current.some((turn) => turn.kind === "user" && turn.gen === gen)
            ? current
            : [...current, { kind: "user", gen, text: utterance }]
        );
      }
      return null;
    } catch (error) {
      setSendError(error instanceof Error ? error.message : String(error));
      return utterance;
    }
  }, []);

  const handleSend = useCallback(async () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    const refused = await submitUtterance(text);
    if (refused) setDraft(refused);
  }, [draft, submitUtterance]);

  const handleInterrupt = useCallback(async () => {
    try {
      await window.electronAPI.converseInterrupt("interrupted from the Converse page");
    } catch {
      // The session is already gone; the next poll clears the view.
    }
  }, []);

  /**
   * Speaking over the reply cuts it off, in the same call the overlay's own
   * Interrupt button makes. Fired at the first detected syllable rather than
   * at the end of the sentence, because a reply that keeps talking for another
   * two seconds is exactly what makes a voice assistant feel deaf.
   */
  const handleVoiceSpeechStart = useCallback(() => {
    // A question on screen means the agent is already stopped, waiting on a
    // button. Interrupting then would bump the turn while the harness is still
    // holding its own tool call open, so talking near it changes nothing.
    if (waitingOnUser) return;
    // Only audible speech is interrupted. Talking while the agent is merely
    // working queues a follow-up instead of throwing the answer away — the
    // way Codex steers a running task rather than killing it.
    if (!isSpeaking) return;
    void window.electronAPI?.converseInterrupt?.("the user started speaking");
  }, [isSpeaking, waitingOnUser]);

  const handleVoiceUtterance = useCallback(
    (text: string) => {
      if (waitingOnUser) {
        setSendError("Answer the question above first. What you just said was not sent.");
        return;
      }
      void submitUtterance(text);
    },
    [submitUtterance, waitingOnUser]
  );

  const voice = useConverseVoice({
    enabled: voiceEnabled,
    active: sessionActive,
    // Only while sound is actually coming out. Muting through `thinking` as
    // well would swallow the "no, stop" that has to land while the agent is
    // still working.
    muted: muteWhileSpeaking && isSpeaking,
    endOfTurnMs,
    onUtterance: handleVoiceUtterance,
    onSpeechStart: handleVoiceSpeechStart,
  });

  const handleStop = useCallback(async () => {
    try {
      await window.electronAPI.converseStop();
    } catch {
      // Already stopped.
    }
    setSessionActive(false);
    setLiveState(null);
    setTranscript([]);
    setPermissions([]);
    setAnswering([]);
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

  /**
   * Where a spoken turn is actually transcribed. Converse uses the app's own
   * transcription setting, so this has to be read out rather than asserted:
   * "stays on this machine" is false for a user who has chosen a cloud
   * provider, and that is the one claim this app cannot get wrong.
   */
  const speechRoute = useMemo(() => {
    if (useLocalWhisper) {
      return {
        short: "On this machine",
        line: "Your voice is transcribed on this machine.",
      };
    }
    const name = getTranscriptionProvider(cloudTranscriptionProvider)?.name || "a cloud provider";
    return {
      short: `${name}, over the internet`,
      line: `Your voice is sent to ${name} to be transcribed.`,
    };
  }, [useLocalWhisper, cloudTranscriptionProvider]);

  const statusHelp = (() => {
    if (waitingOnUser) {
      const first = pendingPermissions[0];
      const more = pendingPermissions.length - 1;
      const tail = more > 0 ? ` ${more} more after this one.` : "";
      return `Claude Code needs your answer before it can use ${first.tool_name || "a tool"}.${tail}`;
    }
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
        </div>
        <p className="text-sm text-muted-foreground">Talk through a project with Claude Code.</p>
      </div>

      {!sessionActive && (
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
                      Choose the project Claude Code should work on.
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
                      label="Talk instead of typing"
                      description={
                        voiceEnabled ? (
                          <>
                            Speak, then pause to send. Transcription:{" "}
                            <span data-testid="converse-speech-route">{speechRoute.short}</span>.
                          </>
                        ) : (
                          "Use the microphone during a session."
                        )
                      }
                    >
                      <Toggle checked={voiceEnabled} onChange={setVoiceEnabled} />
                    </SettingsRow>
                  </SettingsPanelRow>
                </SettingsPanel>
                <div className="mt-4">
                  <SettingsDisclosure
                    title="Voice options"
                    status={voiceModelInstalled ? "Voice ready" : "Voice not installed"}
                  >
                    {voiceEnabled && (
                      <SettingsPanelRow>
                        <SettingsRow
                          label="Pause that ends your turn"
                          description="How long to wait before sending your words."
                        >
                          <Select
                            value={String(endOfTurnMs)}
                            onValueChange={(value) => setEndOfTurnMs(Number(value))}
                          >
                            <SelectTrigger
                              className="w-40"
                              data-testid="converse-end-of-turn-select"
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {END_OF_TURN_CHOICES.map((choice) => (
                                <SelectItem key={choice.value} value={String(choice.value)}>
                                  {choice.label} · {(choice.value / 1000).toFixed(1)}s
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </SettingsRow>
                      </SettingsPanelRow>
                    )}

                    <SettingsPanelRow>
                      <SettingsRow
                        label="Mute microphone during replies"
                        description="Prevents spoken replies from starting another turn."
                      >
                        <Toggle checked={muteWhileSpeaking} onChange={setMuteWhileSpeaking} />
                      </SettingsRow>
                    </SettingsPanelRow>

                    {/* Same gate as Read Aloud's: without the model nothing here
                      can make a sound, and an inert list of 28 names would only
                      mislead. */}
                    <SettingsPanelRow>
                      {voiceModelInstalled ? (
                        <VoicePicker
                          value={voiceId}
                          onChange={setVoiceId}
                          testIdPrefix="converse"
                          ariaLabel="Voice"
                          collapsible
                        />
                      ) : (
                        <SettingsRow
                          label="Voice"
                          description="Download the voice model on the Read Aloud page."
                        >
                          <span className="text-sm text-muted-foreground">Not installed</span>
                        </SettingsRow>
                      )}
                    </SettingsPanelRow>

                    {voiceEnabled && !muteWhileSpeaking && (
                      <SettingsPanelRow>
                        <InfoBox variant="muted" className="p-3">
                          <div className="flex items-start gap-2.5">
                            <Headphones
                              size={15}
                              className="mt-px shrink-0 text-muted-foreground"
                            />
                            <p className="text-[12px] text-muted-foreground leading-relaxed">
                              Use headphones so replies are not picked up by your microphone.
                            </p>
                          </div>
                        </InfoBox>
                      </SettingsPanelRow>
                    )}
                  </SettingsDisclosure>
                </div>
              </div>

              {startError && (
                <InfoBox variant="warning" className="p-4">
                  <p className="text-[13px] text-foreground leading-relaxed">{startError}</p>
                  {/* This hint only applies to the voice-model-missing failure; a
                      Claude Code CLI problem needs no mention of Settings. */}
                  {startError.startsWith("The voice model is not installed") && (
                    <p className="text-[12px] text-muted-foreground mt-1">
                      Download the voice model on the Read Aloud page.
                    </p>
                  )}
                </InfoBox>
              )}

              {folderTrust ? (
                <FolderTrustPrompt
                  check={folderTrust}
                  busy={starting}
                  onTrust={() => void handleTrustAndStart()}
                  onCancel={() => setFolderTrust(null)}
                />
              ) : (
                <div className="flex items-center gap-3">
                  <Button onClick={handleStart} disabled={starting} className="gap-2">
                    <MessagesSquare size={15} />
                    {starting ? "Starting session" : "Start session"}
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {sessionActive && (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-4 rounded-xl border border-border-subtle/50 bg-surface-raised/50 px-5 py-3.5">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span
                  data-testid="converse-status"
                  data-state={state}
                  data-waiting={waitingOnUser ? "permission" : undefined}
                  className="inline-flex items-center gap-2 text-sm font-medium text-foreground"
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${
                      waitingOnUser ? "bg-primary" : STATE_DOT[state] || "bg-muted-foreground/50"
                    }`}
                    aria-hidden
                  />
                  {waitingOnUser ? "Waiting for you" : STATE_LABELS[state] || state}
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
                {transcript.map((turn) => {
                  if (turn.kind === "permission") {
                    const entry = permissionsById.get(turn.id);
                    // The log is capped, so a very long session can forget the
                    // oldest questions. Nothing honest is left to show.
                    if (!entry) return null;
                    if (entry.answeredWith !== null) {
                      return <PermissionRecord key={`permission-${turn.id}`} entry={entry} />;
                    }
                    return (
                      <PermissionCard
                        key={`permission-${turn.id}`}
                        entry={entry}
                        nowMs={nowMs}
                        busy={answering.includes(entry.id)}
                        position={pendingPermissions.findIndex((p) => p.id === entry.id) + 1}
                        total={pendingPermissions.length}
                        onAnswer={(id, behavior) => void answerPermission(id, behavior)}
                      />
                    );
                  }

                  return turn.kind === "user" ? (
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
                  );
                })}
                <div ref={transcriptEndRef} />
              </div>
            )}
          </div>

          <VoiceBar
            phase={voice.phase}
            level={voice.level}
            error={voice.error}
            notice={voice.notice}
            enabled={voiceEnabled}
            onToggle={setVoiceEnabled}
            onRetry={voice.retry}
          />

          {sendError && <p className="text-[12px] text-destructive">{sendError}</p>}

          <div className="space-y-2">
            <div className="flex items-center gap-2">
              {/* Deliberately usable mid-turn: a message sent while Claude
                  Code is working or speaking is queued and answered next,
                  instead of bouncing with "busy". */}
              <Input
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void handleSend();
                }}
                placeholder={
                  isThinking || isSpeaking
                    ? "Type a follow-up, sent when this turn ends"
                    : "Type to Claude Code"
                }
                className="flex-1"
                data-testid="converse-input"
              />
              <Button onClick={handleSend} disabled={!draft.trim()} className="gap-1.5">
                <Send size={14} />
                Send
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground/70">
              {waitingOnUser
                ? "Permission questions are answered with the buttons above, never by voice."
                : `Speaking and typing go to the same place. ${speechRoute.line}`}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
