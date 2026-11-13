import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "./fixtures/electron-app";
import voiceCallMeter from "../../src/helpers/narrator/voiceCallMeter";
import type { NarratorState } from "../../src/utils/narratorTypes";

/**
 * The narrator making room in a voice call, LIVE ONLY: it plays sound on this
 * PC and turns other apps down while it speaks, so it lives outside the
 * default suite (playwright-live.config.ts). The rewriter runs in stub mode,
 * so no Claude prompt is spent.
 *
 * A fake call, fixtures/fake-voice-call.cs built as discord.exe, hums and
 * pauses on an output that is not the default one where there is one (a
 * headset's Chat output; PT_E2E_CALL_DEVICE names another). A synthetic chat
 * ends its turn on a question while the call talks, in gaming mode. It passes
 * when the words wait for the call's next pause, the call plays at 30% while
 * the narrator speaks and is back at its own level after, and no window was
 * shown or focused.
 */

const SESSION = "aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff";
const LOCAL_ID = "local_00000000-1111-4222-8333-555555555555";
const PROJECT = "C--work-example-repo";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pt-e2e-room-projects-"));
const SESSIONS = fs.mkdtempSync(path.join(os.tmpdir(), "pt-e2e-room-sessions-"));
const CALL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pt-e2e-room-call-"));
const TRANSCRIPT = path.join(ROOT, PROJECT, `${SESSION}.jsonl`);
const CALL_EXE = path.join(CALL_DIR, "discord.exe");
const CSC = path.join(
  process.env.WINDIR || "C:\\Windows",
  "Microsoft.NET",
  "Framework64",
  "v4.0.30319",
  "csc.exe"
);
const CACHE = path.join(os.homedir(), ".cache", "PrivateTranscribe");
const PIPER_DIR =
  process.env.PT_E2E_NARRATOR_PIPER_DIR || path.join(CACHE, "narrator-models", "piper-da");
const VOICE_READY = {
  da: fs.existsSync(path.join(PIPER_DIR, "model.onnx")),
  en: fs.existsSync(path.join(CACHE, "kokoro-models")),
};
/** Talk 4 s, pause 1.5 s, talk 3 s, pause 6 s. The hum peaks at 0.06. */
const PATTERN = "4000:0.06,1500:0,3000:0.06,6000:0";

test.use({
  experimentalFeatures: true,
  appEnv: {
    PT_NARRATOR_CLAUDE_DIR: ROOT,
    PT_NARRATOR_DESKTOP_SESSIONS_DIR: SESSIONS,
    PT_NARRATOR_REWRITER: "stub",
    PT_NARRATOR_PIPER_DIR: PIPER_DIR,
    // The fixture keeps every run off the machine's audio; this check is about exactly that.
    PRIVATETRANSCRIBE_DIAG_DISABLE_AUDIO_DUCKING: "",
  },
});

const iso = (ms: number) => new Date(ms).toISOString();
const line = (record: Record<string, unknown>) =>
  `${JSON.stringify({ sessionId: SESSION, isSidechain: false, ...record })}\n`;

function writeWait(ask: string) {
  const now = Date.now();
  fs.appendFileSync(
    TRANSCRIPT,
    line({
      type: "assistant",
      timestamp: iso(now),
      entrypoint: "claude-desktop",
      message: {
        role: "assistant",
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: `w-${now}`,
            name: "mcp__ccd_turn__wrap_up",
            input: { recap: "The raid addon is updated and its tests pass.", ask },
          },
        ],
      },
    }) +
      line({
        type: "assistant",
        timestamp: iso(now + 5),
        message: {
          role: "assistant",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "Done." }],
        },
      }) +
      line({ type: "system", subtype: "stop_hook_summary", timestamp: iso(now + 10) })
  );
  return now;
}

function writeAnswer() {
  fs.appendFileSync(
    TRANSCRIPT,
    line({
      type: "user",
      timestamp: iso(Date.now()),
      userType: "external",
      message: { role: "user", content: "Yes." },
    })
  );
}

type CallEvent = {
  event: "device" | "segment" | "volume";
  at?: number;
  level?: number;
  volume?: number;
  name?: string;
  isDefault?: boolean;
};

function startCall() {
  const child = spawn(CALL_EXE, [
    `--device=${process.env.PT_E2E_CALL_DEVICE || "other"}`,
    `--pattern=${PATTERN}`,
    "--seconds=180",
  ]);
  const events: CallEvent[] = [];
  let pending = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    const lines = (pending + chunk).split("\n");
    pending = lines.pop() || "";
    for (const text of lines) {
      try {
        events.push(JSON.parse(text));
      } catch {
        // Not a reading.
      }
    }
  });
  return {
    events,
    stop: () => {
      child.stdin.end();
      setTimeout(() => child.kill(), 1000).unref();
    },
  };
}

test.beforeAll(() => {
  test.skip(
    process.platform !== "win32" || !fs.existsSync(CSC),
    "needs Windows and its C# compiler"
  );
  execFileSync(CSC, [
    "/nologo",
    "/optimize",
    "/target:exe",
    `/out:${CALL_EXE}`,
    path.join(__dirname, "fixtures", "fake-voice-call.cs"),
  ]);
  fs.mkdirSync(path.join(ROOT, PROJECT), { recursive: true });
  fs.writeFileSync(
    TRANSCRIPT,
    line({ type: "custom-title", customTitle: "Raid addon" }) +
      line({
        type: "user",
        timestamp: iso(Date.now() - 1000),
        message: { role: "user", content: "update it" },
      })
  );
  fs.mkdirSync(path.join(SESSIONS, "account", "org"), { recursive: true });
  fs.writeFileSync(
    path.join(SESSIONS, "account", "org", `${LOCAL_ID}.json`),
    JSON.stringify({
      sessionId: LOCAL_ID,
      cliSessionId: SESSION,
      title: "Raid addon",
      originCwd: "C:\\work\\example-repo",
      isArchived: false,
    })
  );
});

test.afterAll(() => {
  for (const dir of [ROOT, SESSIONS, CALL_DIR]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // A call that is still exiting holds its exe for a moment.
    }
  }
});

const ASK = { da: "Skal jeg pushe opdateringen nu?", en: "Shall I push the update now?" };

for (const language of ["da", "en"] as const) {
  test(`makes room in a voice call before it speaks a wait (${language})`, async ({
    electronApp,
    controlPanel,
  }) => {
    test.skip(!VOICE_READY[language], `the ${language} voice is not downloaded on this PC`);
    test.setTimeout(90_000);

    await controlPanel.evaluate(() => window.electronAPI.narratorSetGate(true));
    await controlPanel.evaluate(
      (lang) =>
        window.electronAPI.narratorUpdateSettings({
          enabled: true,
          language: lang,
          gaming: true,
          makeRoom: true,
        }),
      language
    );

    // Every call that could show a window or take focus, written down.
    const windowsBefore = await electronApp.evaluate(({ BrowserWindow }) => {
      const calls: string[] = [];
      (globalThis as unknown as { __ptRoomCalls: string[] }).__ptRoomCalls = calls;
      for (const win of BrowserWindow.getAllWindows()) {
        const target = win as unknown as Record<string, (...args: unknown[]) => unknown>;
        for (const name of ["show", "showInactive", "focus", "moveTop", "flashFrame"]) {
          const original = target[name].bind(win);
          target[name] = (...args: unknown[]) => {
            calls.push(name);
            return original(...args);
          };
        }
      }
      return BrowserWindow.getAllWindows().map((win) => win.isVisible());
    });

    const call = startCall();
    try {
      // The turn ends 600 ms into the call's first stretch of talk.
      await expect
        .poll(() => call.events.find((e) => e.event === "segment" && (e.level || 0) > 0)?.at, {
          timeout: 10_000,
        })
        .toBeTruthy();
      const talkAt = call.events.find((e) => e.event === "segment" && (e.level || 0) > 0)!.at!;
      await controlPanel.waitForTimeout(Math.max(0, talkAt + 600 - Date.now()));
      const endedAt = writeWait(ASK[language]);

      let playback: NarratorState["lastPlayback"] = null;
      const deadline = Date.now() + 40_000;
      while (!playback && Date.now() < deadline) {
        const state = await controlPanel.evaluate(() => window.electronAPI.narratorGetState());
        if (state.voiceError) throw new Error(`voice failed: ${JSON.stringify(state.voiceError)}`);
        playback = state.lastPlayback?.at ? state.lastPlayback : null;
        if (!playback) await controlPanel.waitForTimeout(200);
      }
      expect(playback, "the wait was never spoken").not.toBeNull();
      // Restore is awaited before lastPlayback is set; give the call a beat to report it.
      await controlPanel.waitForTimeout(600);

      const segments = call.events.filter((e) => e.event === "segment");
      const volumes = call.events.filter((e) => e.event === "volume");
      const device = call.events.find((e) => e.event === "device");
      const wordsAt = playback!.at as number;
      const heard = [...segments].reverse().find((s) => s.at! <= wordsAt)!;
      const ducked = volumes.filter((v) => v.at! >= wordsAt - 200 && v.volume! < 0.5);
      const restored = volumes.at(-1)!;
      const windowCalls = await electronApp.evaluate(
        () => (globalThis as unknown as { __ptRoomCalls: string[] }).__ptRoomCalls
      );
      const windowsAfter = await electronApp.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().map((win) => win.isVisible())
      );

      const t = (ms: number | undefined) => (ms === undefined ? "-" : `+${ms - endedAt} ms`);
      console.log(
        [
          `[room:${language}] call on "${device?.name}"${device?.isDefault ? " (default output)" : ""}`,
          `  turn ended while the call talked (talk began ${t(talkAt)})`,
          `  chime ${t(endedAt + (playback!.chimeLatencyMs ?? NaN))}`,
          `  pause wait: ${playback!.pause?.reason} after ${playback!.pause?.waitedMs} ms`,
          `  words ${t(wordsAt)}, ${wordsAt - heard.at!} ms into a stretch at level ${heard.level}`,
          `  call volume: ${volumes.map((v) => `${v.volume} ${t(v.at)}`).join(", ")}`,
          `  window calls: ${windowCalls.length ? windowCalls.join(", ") : "none"}`,
        ].join("\n")
      );

      expect(playback).toMatchObject({ result: "done", chime: true, ducked: true, language });
      expect(playback!.pause).toMatchObject({ reason: "pause" });
      // It waited through talk rather than speaking at once.
      expect(playback!.pause?.waitedMs).toBeGreaterThan(1500);
      // The words began in a quiet stretch, a whole pause after it started.
      expect(heard.level).toBe(0);
      expect(wordsAt - heard.at!).toBeGreaterThanOrEqual(voiceCallMeter.QUIET_MS - 100);
      expect(wordsAt - heard.at!).toBeLessThan(voiceCallMeter.QUIET_MS + 800);
      // The call played at 30% while the narrator spoke, and is back now.
      expect(ducked.length).toBeGreaterThan(0);
      expect(Math.min(...ducked.map((v) => v.volume!))).toBeCloseTo(0.3, 2);
      expect(restored.volume).toBeCloseTo(1, 2);
      expect(windowCalls).toEqual([]);
      expect(windowsAfter).toEqual(windowsBefore);
    } finally {
      call.stop();
      writeAnswer();
    }
  });
}
