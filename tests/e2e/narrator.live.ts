import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "./fixtures/electron-app";

/**
 * The narrator against this PC's real Claude Code chats, LIVE ONLY: it reads
 * ~/.claude/projects and runs the real rewriter on the user's Claude login,
 * so it lives outside the default suite (playwright-live.config.ts).
 *
 * It turns the narrator on in a throwaway profile and watches for
 * PT_NARRATOR_LIVE_MINUTES (default 10). It passes once a chat that waits on
 * the user has been spoken with the chime, and reports how long that took
 * from the end of the chat's turn to the first sound.
 *
 * The log it writes holds real chat titles and recaps, so it goes to
 * PT_NARRATOR_LIVE_LOG or the temp folder, never into the repository.
 */

const MINUTES = Number(process.env.PT_NARRATOR_LIVE_MINUTES || 10);
const LOG =
  process.env.PT_NARRATOR_LIVE_LOG ||
  path.join(os.tmpdir(), `pt-narrator-live-${Date.now()}.jsonl`);
const PIPER_DIR =
  process.env.PT_E2E_NARRATOR_PIPER_DIR ||
  path.join(os.homedir(), ".cache", "PrivateTranscribe", "narrator-models", "piper-da");

test.use({
  experimentalFeatures: true,
  appEnv: {
    PT_NARRATOR_CLAUDE_DIR: path.join(os.homedir(), ".claude", "projects"),
    PT_NARRATOR_PIPER_DIR: PIPER_DIR,
  },
});

test("speaks a real chat's wait with the chime", async ({ controlPanel }) => {
  test.setTimeout((MINUTES + 2) * 60_000);
  const write = (entry: Record<string, unknown>) =>
    fs.appendFileSync(LOG, `${JSON.stringify({ t: new Date().toISOString(), ...entry })}\n`);

  const started = Date.now();
  await controlPanel.evaluate(() => window.electronAPI.narratorSetGate(true));
  const state = await controlPanel.evaluate(() =>
    window.electronAPI.narratorUpdateSettings({ enabled: true })
  );
  write({ event: "started", startMs: Date.now() - started, backlog: state.items.length });
  expect(state.running).toBe(true);

  const seen = new Set<string>();
  let lastPlaybackAt: number | null = null;
  let lastVoiceError = "";
  let spokenWait: Record<string, unknown> | null = null;
  const deadline = Date.now() + MINUTES * 60_000;
  while (Date.now() < deadline && !spokenWait) {
    const now = await controlPanel.evaluate(() => window.electronAPI.narratorGetState());
    for (const item of now.items) {
      if (!seen.has(item.id)) {
        seen.add(item.id);
        write({
          event: "item",
          kind: item.kind,
          title: item.chatTitle,
          at: item.at,
          card: item.card,
        });
      }
    }
    const playback = now.lastPlayback;
    if (playback?.at && playback.at !== lastPlaybackAt) {
      lastPlaybackAt = playback.at;
      const item = now.items.find((candidate) => candidate.heard && candidate.kind === "waiting");
      const entry = {
        event: "playback",
        ...playback,
        title: item?.chatTitle,
        turnEndedAt: item?.at,
        rewriterError: now.rewriterError,
      };
      write(entry);
      // latencyMs is set only for a chat's own item, and the chime only for a wait.
      if (playback.chime && playback.result === "done" && playback.latencyMs !== null) {
        spokenWait = entry;
      }
    }
    const voiceError = now.voiceError ? JSON.stringify(now.voiceError) : "";
    if (voiceError && voiceError !== lastVoiceError)
      write({ event: "voice-error", ...now.voiceError });
    lastVoiceError = voiceError;
    await controlPanel.waitForTimeout(500);
  }
  write({ event: "finished", spokenWait });
  expect(spokenWait, `no wait was spoken within ${MINUTES} min; log: ${LOG}`).not.toBeNull();
});
