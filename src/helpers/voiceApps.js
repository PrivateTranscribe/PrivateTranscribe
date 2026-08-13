"use strict";

/**
 * Voice apps PrivateTranscribe knows how to mute, and the pure helpers for
 * matching them against microphone capture sessions.
 *
 * The list is deliberately an allowlist rather than "anything holding the
 * microphone". On a real machine the capture endpoint routinely has sessions
 * from NVIDIA Broadcast, browsers, and PrivateTranscribe itself, several of
 * them permanently active. Muting on any active session would fire constantly.
 *
 * `process` is matched against the executable base name reported by
 * windows-mic-watch.exe, case-insensitively. `pushToMute` records whether the
 * app offers a hold-to-mute keybind, which is the only kind we can drive
 * without risking the state getting out of sync.
 */

const VOICE_APPS = [
  { id: "discord", label: "Discord", process: "discord", pushToMute: true },
  { id: "teams", label: "Microsoft Teams", process: "ms-teams", pushToMute: false },
  { id: "teams-classic", label: "Microsoft Teams (classic)", process: "teams", pushToMute: false },
  { id: "zoom", label: "Zoom", process: "zoom", pushToMute: false },
  { id: "slack", label: "Slack", process: "slack", pushToMute: false },
];

function normalizeProcessName(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/\.exe$/, "");
}

/**
 * Returns the known voice app for a capture-session process name, or null.
 */
function matchVoiceApp(processName, apps = VOICE_APPS) {
  const normalized = normalizeProcessName(processName);
  if (!normalized) return null;
  return apps.find((app) => normalizeProcessName(app.process) === normalized) || null;
}

/**
 * Reduces a raw session list to the known voice apps that are actively
 * streaming. Inactive sessions are ignored: an app that has used the
 * microphone at some point in this boot keeps a session around afterwards, so
 * presence alone says nothing about whether a call is happening.
 */
function findActiveVoiceApps(sessions, apps = VOICE_APPS) {
  if (!Array.isArray(sessions)) return [];
  const found = new Map();
  for (const session of sessions) {
    if (!session || session.active !== true) continue;
    const app = matchVoiceApp(session.name, apps);
    if (!app || found.has(app.id)) continue;
    found.set(app.id, {
      id: app.id,
      label: app.label,
      pid: session.pid,
      pushToMute: app.pushToMute,
    });
  }
  return [...found.values()];
}

/**
 * Parses one stdout line from windows-mic-watch.exe. Detection is best effort:
 * an unreadable line yields null and the previous state is kept, rather than
 * being treated as "nobody is on the microphone", which would make the app
 * think a call ended.
 */
function parseMicWatchLine(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed) return null;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || !Array.isArray(parsed.sessions)) return null;
  return parsed.sessions
    .filter((entry) => entry && Number.isInteger(entry.pid) && entry.pid > 0)
    .map((entry) => ({
      pid: entry.pid,
      name: typeof entry.name === "string" ? entry.name.slice(0, 128) : "",
      active: entry.active === true,
    }));
}

module.exports = {
  VOICE_APPS,
  findActiveVoiceApps,
  matchVoiceApp,
  normalizeProcessName,
  parseMicWatchLine,
};
