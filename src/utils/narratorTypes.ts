/** Shapes the narrator's main-process service sends to the renderer. */

export type NarratorLanguage = "da" | "en";
export type NarratorCommand = "brief" | "more" | "follow" | "stop";

export interface NarratorSettings {
  enabled: boolean;
  language: NarratorLanguage;
  voiceDa: "piper-da" | "roest-da";
  voiceEn: string;
  listen: boolean;
  bargeIn: boolean;
  /** Only waits are spoken, and nothing listens to the room. */
  gaming: boolean;
  /** Wait for a pause in a voice call, and lower other apps while speaking. */
  makeRoom: boolean;
  /** For 15 s after a spoken question, the dictation key answers it with one of its options. */
  answerByVoice: boolean;
  /** Only chats with narrator mode on are heard; every other chat is silent. */
  onlyNarratorMode: boolean;
  followed: string[];
}

/** Where a voice question is; the overlay draws one state per phase. */
export type NarratorQuestionPhase =
  | "speaking"
  | "not-caught"
  | "open"
  | "recording"
  | "hearing"
  | "reading"
  | "confirming"
  | "closing"
  | "done";

/** What the chat got back from ask_by_voice. */
export type NarratorQuestionResult =
  "answered" | "no_answer" | "no_match" | "cancelled" | "not_active";

/** The voice question being asked through ask_by_voice, or the last one. */
export interface NarratorVoiceQuestion {
  id: string;
  /** The chat's short name for itself. */
  chat: string;
  question: string;
  choices: string[];
  /** The language the question was written, and is said, in. */
  language: NarratorLanguage;
  phase: NarratorQuestionPhase;
  /** When the answer window closes (epoch ms), while it is open. */
  windowEndsAt: number | null;
  /** The choice heard, from its read-back on. */
  picked: string | null;
  /** When the pick goes (epoch ms), while it can still be cancelled. */
  confirmEndsAt: number | null;
  /** Tries heard that matched no choice. */
  missed: number;
  /** How the answer window ended, while its last line is said. */
  ended: string | null;
  result: NarratorQuestionResult | null;
  startedAt: number;
  endedAt: number | null;
}

export interface NarratorItem {
  id: string;
  chatId: string;
  chatTitle: string;
  project: string;
  kind: "waiting" | "finished";
  card: string;
  recap: string;
  ask: string;
  at: number;
  heard: boolean;
  canOpen: boolean;
  followed: boolean;
  /** Its question was said through ask_by_voice already. */
  voiceAsked: boolean;
}

export interface NarratorState {
  running: boolean;
  enabled: boolean;
  gate: boolean;
  settings: NarratorSettings;
  items: NarratorItem[];
  speaking: { itemId: string | null; language: NarratorLanguage } | null;
  queued: number;
  voiceError: { language: string; code?: string; message: string } | null;
  lastPlayback: {
    result: "done" | "stopped" | "timeout" | "no-overlay";
    chime: boolean;
    language: NarratorLanguage;
    /** When the words began to play; null when nothing did. */
    at: number | null;
    /** From the end of the chat's turn to its words, for a wait or a followed chat. */
    latencyMs: number | null;
    /** From the end of the chat's turn to the chime played ahead of its words. */
    chimeLatencyMs: number | null;
    /** Why it spoke when it did, after waiting on a voice call. */
    pause: { reason: string; waitedMs: number } | null;
    /** Whether other apps played lower while it spoke. */
    ducked: boolean;
  } | null;
  rewriterError: { code: string; message: string } | null;
  week: Record<string, number>;
  /** Whether the overlay transcribes locally with no cloud fallback; voice answers need it. */
  localOnly: boolean;
  /** Whether the dictation key answers a question right now. */
  answering: boolean;
  /** Whether ask_by_voice is answered now: gaming mode, Answer by voice and local transcription. */
  takesVoiceQuestions: boolean;
  question: NarratorVoiceQuestion | null;
  /** Chats that wait on the user: open waits and voice questions left unanswered. */
  waiting: number;
}

export interface NarratorVoiceStatus {
  "piper-da": { id: string; installed: boolean; downloading: boolean; sizeBytes: number };
  "roest-da": { id: string; installed: boolean; optIn: boolean };
  "kokoro-en": { id: string; installed: boolean };
}

/** Main to overlay: one item streamed as it is made. */
export type NarratorPlayMessage =
  | { jobId: string; type: "begin"; chime: boolean }
  | { jobId: string; type: "part"; pcm: Float32Array; sampleRate: number }
  | { jobId: string; type: "end" }
  | { jobId: string; type: "cancel" };

/** Main to overlay: start, stop or throw away the recording of a voice answer. */
export interface NarratorAnswerMessage {
  type: "start" | "stop" | "discard";
  id: string;
  /** With "start": the question's language, used when transcription is set to Auto. */
  language?: NarratorLanguage;
}

export interface NarratorDownloadProgress {
  downloadedBytes: number;
  totalBytes: number;
  file?: string;
  done?: boolean;
}
