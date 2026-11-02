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
  followed: string[];
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
  } | null;
  rewriterError: { code: string; message: string } | null;
  week: Record<string, number>;
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

export interface NarratorDownloadProgress {
  downloadedBytes: number;
  totalBytes: number;
  file?: string;
  done?: boolean;
}
