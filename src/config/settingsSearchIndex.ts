/**
 * What settings search can find, and where each result lives.
 *
 * Settings are hand-written JSX spread across four files and nine sections, so
 * there is nothing to enumerate at runtime. This index is the enumeration. It is
 * pinned by tests/unit/components/settingsSearchIndex.test.ts, which re-reads
 * every `<SettingsRow label="...">` out of the source and fails when a row is
 * added, renamed, or removed without the index following - the drift that makes
 * a stale search worse than none.
 *
 * `keywords` carry the words a person actually types. Somebody hunting for
 * correction learning searches "correction memory", which appears in the group
 * heading above the row and nowhere in the label itself.
 */

export type SettingsSearchPage =
  | "settings"
  | "dictation"
  | "dictionary"
  | "read-aloud"
  | "converse"
  | "ai-enhancement";

export type SettingsSearchSection = "general" | "permissions" | "beta" | "developer";

export interface SettingsSearchEntry {
  /** The exact label rendered on the row; also its `data-settings-label`. */
  label: string;
  /** The heading above it, shown as the result's second line. */
  group: string;
  page: SettingsSearchPage;
  /** Which Settings tab holds it. Required when `page` is "settings". */
  section?: SettingsSearchSection;
  /** Words a searcher might use that the label and group do not contain. */
  keywords?: string[];
}

export const SETTINGS_SEARCH_INDEX: SettingsSearchEntry[] = [
  // ── Settings › General ────────────────────────────────────────────────────
  {
    label: "GPU engine",
    group: "GPU speed-up",
    page: "settings",
    section: "general",
    keywords: ["cuda", "nvidia", "acceleration", "graphics card", "speed"],
  },
  {
    label: "Current version",
    group: "Updates",
    page: "settings",
    section: "general",
    keywords: ["update", "upgrade", "release", "changelog"],
  },
  {
    label: "Launch PrivateTranscribe when you start your computer",
    group: "Startup",
    page: "settings",
    section: "general",
    keywords: ["autostart", "auto start", "boot", "login", "startup"],
  },
  {
    label: "At login, open as",
    group: "Startup",
    page: "settings",
    section: "general",
    keywords: ["autostart", "tray", "minimized", "window", "boot"],
  },
  {
    label: "Microphone",
    group: "Audio Input",
    page: "settings",
    section: "permissions",
    keywords: [
      "mic",
      "microphone",
      "input device",
      "headset",
      "sound",
      "audio input",
      "built-in",
      "test",
    ],
  },
  {
    label: "Keep microphone ready",
    group: "Audio Input",
    page: "settings",
    section: "permissions",
    keywords: ["mic", "microphone", "warm", "latency", "delay"],
  },

  // ── Settings › General (behaviour, notifications, privacy) ───────────────
  {
    label: "Correction Memory",
    group: "Dictionary",
    page: "dictionary",
    keywords: ["learn", "corrections", "rewrites", "mistakes", "replacement"],
  },
  {
    label: "Apply dictionary matching",
    group: "Dictionary",
    page: "dictionary",
    keywords: ["dictionary", "snapping", "terms", "replace"],
  },
  {
    label: "While recording",
    group: "Other audio",
    page: "settings",
    section: "general",
    keywords: ["ducking", "volume", "mute other apps", "music"],
  },
  {
    label: "Volume while recording",
    group: "Other audio",
    page: "settings",
    section: "general",
    keywords: ["ducking", "volume", "quiet", "music"],
  },
  {
    label: "Pause media while recording",
    group: "Other audio",
    page: "settings",
    section: "general",
    keywords: ["ducking", "spotify", "music", "video", "playback"],
  },
  {
    label: "Auto-paste transcription",
    group: "Behavior",
    page: "settings",
    section: "general",
    keywords: ["paste", "insert", "clipboard"],
  },
  {
    label: "Copy to clipboard",
    group: "Behavior",
    page: "settings",
    section: "general",
    keywords: ["clipboard", "copy", "overwrite"],
  },
  {
    label: "Show control panel on error",
    group: "Behavior",
    page: "settings",
    section: "general",
    keywords: ["error", "window", "popup"],
  },
  {
    label: "Snap overlay to taskbar",
    group: "Behavior",
    page: "settings",
    section: "general",
    keywords: ["overlay", "dictation button", "position", "taskbar", "dock"],
  },
  {
    label: "Hide overlay",
    group: "Behavior",
    page: "settings",
    section: "general",
    keywords: ["overlay", "dictation button", "bubble", "hide", "invisible"],
  },
  {
    label: "Audio feedback",
    group: "Notifications",
    page: "settings",
    section: "general",
    keywords: ["sound", "beep", "chime"],
  },
  {
    label: "Error notifications",
    group: "Notifications",
    page: "settings",
    section: "general",
    keywords: ["toast", "alert", "warning"],
  },
  {
    label: "Success confirmation",
    group: "Notifications",
    page: "settings",
    section: "general",
    keywords: ["toast", "confirm", "done"],
  },
  {
    label: "Optional product analytics",
    group: "Privacy & History",
    page: "settings",
    section: "general",
    keywords: ["telemetry", "tracking", "privacy", "opt out", "data"],
  },
  {
    label: "History limit",
    group: "Privacy & History",
    page: "settings",
    section: "general",
    keywords: ["history", "transcriptions", "storage", "retention", "delete"],
  },
  {
    label: "Smart Context",
    group: "Privacy & History",
    page: "settings",
    section: "general",
    keywords: ["context", "active window", "app awareness"],
  },
  {
    label: "Active file context",
    group: "Privacy & History",
    page: "settings",
    section: "general",
    keywords: ["context", "file", "editor", "smart context"],
  },
  {
    label: "LLM Context Enhancement",
    group: "Privacy & History",
    page: "settings",
    section: "general",
    keywords: ["context", "ai", "reasoning", "smart context"],
  },
  {
    label: "Include active file content",
    group: "Privacy & History",
    page: "settings",
    section: "general",
    keywords: ["context", "file", "content", "privacy", "smart context"],
  },

  // ── Dictation ─────────────────────────────────────────────────────────────
  {
    label: "Output language",
    group: "Language",
    page: "dictation",
    keywords: ["danish", "dansk", "english", "dictation language", "spoken"],
  },
  {
    label: "CPU threads",
    group: "Local Whisper performance",
    page: "dictation",
    keywords: ["whisper", "performance", "speed", "cores", "cpu"],
  },
  {
    label: "Idle shutdown (minutes)",
    group: "Local Whisper performance",
    page: "dictation",
    keywords: ["whisper server", "memory", "ram", "unload", "idle"],
  },

  // ── AI Enhancement › Agent mode ──────────────────────────────
  {
    label: "Enable agent mode",
    group: "Agent mode",
    page: "ai-enhancement",
    keywords: ["agent mode", "enable", "disable", "toggle", "dictation"],
  },
  {
    label: "Agent mode AI connection",
    group: "Agent mode",
    page: "ai-enhancement",
    keywords: ["claude code", "shared", "provider", "subscription"],
  },
  {
    label: "Agent mode",
    group: "Agent mode",
    page: "ai-enhancement",
    keywords: ["claude code", "cursor", "codex", "prompt", "agent", "coding"],
  },
  {
    label: "Enhance coding prompts",
    group: "Agent mode",
    page: "ai-enhancement",
    keywords: ["claude code", "rewrite", "cli", "login", "prompt", "haiku"],
  },

  // ── Settings › Beta features ──────────────────────────────────────────────
  {
    label: "Beta features",
    group: "Beta features",
    page: "settings",
    section: "beta",
    keywords: [
      "beta",
      "experimental",
      "unfinished",
      "preview",
      "ai enhancement",
      "correction memory",
      "smart context",
      "action engine",
    ],
  },
  {
    label: "Experimental features",
    group: "Beta features",
    page: "settings",
    section: "beta",
    keywords: ["experimental", "converse", "agent mode", "action engine", "voice commands"],
  },

  // ── Settings › Permissions ────────────────────────────────────────────────
  {
    label: "Reset accessibility permissions",
    group: "System Permissions",
    page: "settings",
    section: "permissions",
    keywords: ["accessibility", "permission", "macos", "paste", "reset"],
  },

  // ── Settings › General (help) ─────────────────────────────────────────────
  {
    label: "Contact & Feedback",
    group: "Help & Support",
    page: "settings",
    section: "general",
    keywords: ["support", "email", "bug", "report", "help"],
  },

  // ── Settings › Data & Storage ─────────────────────────────────────────────
  {
    label: "Settings backup",
    group: "Data & Storage",
    page: "settings",
    section: "developer",
    keywords: ["export", "import", "backup", "restore", "migrate"],
  },
  {
    label: "Reset statistics",
    group: "Data & Storage",
    page: "settings",
    section: "developer",
    keywords: ["stats", "words", "counter", "reset", "dashboard"],
  },
  {
    label: "Model cache",
    group: "Data & Storage",
    page: "settings",
    section: "developer",
    keywords: ["disk", "storage", "whisper models", "delete", "space"],
  },
  {
    label: "Reset app data",
    group: "Data & Storage",
    page: "settings",
    section: "developer",
    keywords: ["reset", "wipe", "factory", "clear", "delete"],
  },
  {
    label: "Uninstall PrivateTranscribe",
    group: "Data & Storage",
    page: "settings",
    section: "developer",
    keywords: ["uninstall", "remove", "delete app"],
  },

  // ── Read Aloud ────────────────────────────────────────────────────────────
  {
    label: "Read the selected text out loud",
    group: "Read Aloud",
    page: "read-aloud",
    keywords: ["tts", "speech", "speak", "read aloud", "voice"],
  },
  {
    label: "Voice model",
    group: "Read Aloud",
    page: "read-aloud",
    keywords: ["tts", "kokoro", "voice", "speaker", "accent"],
  },
  {
    label: "Reading speed",
    group: "Read Aloud",
    page: "read-aloud",
    keywords: ["speed", "faster", "slower", "rate", "tts"],
  },
  {
    label: "Quiet other apps while reading",
    group: "Read Aloud",
    page: "read-aloud",
    keywords: ["ducking", "volume", "music", "tts"],
  },
  {
    label: "Read Aloud hotkey",
    group: "Read Aloud",
    page: "read-aloud",
    keywords: ["hotkey", "shortcut", "keyboard", "tts"],
  },
  {
    label: "Voice",
    group: "Read Aloud",
    page: "read-aloud",
    keywords: ["voice", "accent", "british", "american", "speaker", "kokoro", "tts"],
  },

  // ── Converse ──────────────────────────────────────────────────────────────
  {
    label: "Talk instead of typing",
    group: "Converse",
    page: "converse",
    keywords: [
      "voice",
      "mic",
      "microphone",
      "hands free",
      "converse",
      "speak",
      "dictate",
      "claude code",
      "agent",
      "assistant",
      "where your voice is transcribed",
      "local",
      "cloud",
      "privacy",
      "whisper",
      "transcription provider",
      "route",
    ],
  },
  {
    label: "Pause that ends your turn",
    group: "Converse",
    page: "converse",
    keywords: ["voice", "pause", "silence", "end of turn", "converse", "sensitivity"],
  },
  {
    label: "Mute microphone during replies",
    group: "Converse",
    page: "converse",
    keywords: [
      "mic",
      "mute",
      "converse",
      "claude code",
      "feedback",
      "echo",
      "close my microphone while claude code speaks",
    ],
  },
  {
    label: "Voice",
    group: "Converse",
    page: "converse",
    keywords: ["voice", "accent", "british", "american", "speaker", "kokoro", "tts", "converse"],
  },
];

/** Lowercased haystack for one entry: label, group, and keywords together. */
function haystack(entry: SettingsSearchEntry): string {
  return [entry.label, entry.group, ...(entry.keywords || [])].join(" ").toLowerCase();
}

export function isExperimentalEntry(entry: SettingsSearchEntry): boolean {
  return entry.page === "converse" || entry.group === "Agent mode";
}

/**
 * Entries matching `query`, best first.
 *
 * Every whitespace-separated term must appear somewhere in the entry, so
 * "danish language" narrows rather than widens. Ranking prefers a label hit over
 * a keyword hit, and an earlier hit over a later one, which puts the row a
 * person named directly above the rows that merely mention it.
 */
export function searchSettings(
  query: string,
  index: SettingsSearchEntry[] = SETTINGS_SEARCH_INDEX
): SettingsSearchEntry[] {
  const terms = String(query || "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (terms.length === 0) return [];

  const scored: Array<{ entry: SettingsSearchEntry; score: number }> = [];

  for (const entry of index) {
    const label = entry.label.toLowerCase();
    const all = haystack(entry);
    if (!terms.every((term) => all.includes(term))) continue;

    let score = 0;
    for (const term of terms) {
      const inLabel = label.indexOf(term);
      if (inLabel === 0) score += 100;
      else if (inLabel > 0) score += 60;
      else if (entry.group.toLowerCase().includes(term)) score += 30;
      else score += 10;
    }
    scored.push({ entry, score });
  }

  return scored.sort((a, b) => b.score - a.score).map((row) => row.entry);
}
