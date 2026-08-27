import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "./fixtures/electron-app";

/**
 * Ledger gate `converse-permission-relay`, LIVE ONLY — this file spends real
 * Claude prompts (one per run) and therefore lives outside the default suite
 * (see playwright-live.config.ts). The orchestrator runs it deliberately.
 *
 * What is being proven: with an empty allowlist, the `claude` process's OWN
 * permission question travels through the app's relay, an injected "no" means
 * the sentinel file does not exist afterwards, and an injected "yes" means it
 * does. The filesystem is the judge — the agent's account of itself closes
 * nothing.
 */

const MODE = process.env.PT_CONVERSE_E2E_MODE === "live" ? "live" : "not-live";

/** Empty allowlist: every tool use must go through the permission prompt. */
function writeSettingsFile(dir: string): string {
  const file = path.join(dir, "pt-e2e-claude-settings.json");
  fs.writeFileSync(file, JSON.stringify({ permissions: { allow: [], deny: [] } }));
  return file;
}

const EVIDENCE_DIR = path.resolve(__dirname, "..", "..", "docs", "goal-evidence");

type PermissionLogEntry = {
  id: number;
  at: number;
  tool_name: string;
  input: unknown;
  answeredWith: "allow" | "deny" | null;
};

test.use({ seedKokoroModel: true });

test.describe("converse permission relay (live)", () => {
  test.setTimeout(180_000);

  test.beforeAll(() => {
    if (MODE !== "live") {
      throw new Error(
        "This spec spends live Claude prompts and only runs with PT_CONVERSE_E2E_MODE=live, " +
          "via playwright-live.config.ts. It must never run in the default suite."
      );
    }
  });

  for (const decision of ["deny", "allow"] as const) {
    test(`an injected "${decision}" ${decision === "deny" ? "prevents" : "permits"} the sentinel file`, async ({
      overlayWindow,
    }) => {
      const workDir = fs.mkdtempSync(path.join(os.tmpdir(), `pt-permission-${decision}-`));
      const sentinel = path.join(workDir, `sentinel-${decision}.txt`);
      const settingsFile = writeSettingsFile(workDir);

      try {
        await overlayWindow.evaluate(
          async () => await (window as any).electronAPI.readAloudLoadEngine()
        );

        const started = await overlayWindow.evaluate(
          async (opts) => await (window as any).electronAPI.converseStart(opts),
          // strictMcpConfig is NOT the product default (a real session must not
          // suppress the user's own project MCP servers). This spec asks for it
          // deliberately: the only server that may answer here is the app's own
          // relay, so whatever the machine has configured cannot influence the
          // decision this test measures.
          { model: "haiku", cwd: workDir, permissionRelay: true, strictMcpConfig: true, settingsFile }
        );
        expect(started.agentMode, "session must run live").toBe("live");

        // Armed BEFORE the utterance, the way a user's standing answer would
        // be. The relay logs the question either way, and denies anything
        // unanswered on its own 55s timeout.
        await overlayWindow.evaluate(
          async (behavior) =>
            await (window as any).electronAPI.conversePermissionAutoAnswer(behavior),
          decision
        );

        await overlayWindow.evaluate(
          async (text) => await (window as any).electronAPI.converseSendUtterance(text),
          `Use the Write tool to create a file at exactly ${sentinel.replace(/\\/g, "\\\\")} ` +
            `containing the single word sentinel. Do it now; do not ask me anything back.`
        );

        // Wait for the turn to finish (listening again) rather than for
        // playback details — the judge here is the filesystem, not the audio.
        const finished = await overlayWindow.evaluate(async () => {
          const api = (window as any).electronAPI;
          const deadline = Date.now() + 150_000;
          for (;;) {
            const state = await api.converseGetState();
            const back =
              (state.state === "listening" || state.state === "idle") &&
              state.turnGen >= 1 &&
              !state.player?.playing;
            if (back || Date.now() > deadline) return state;
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
        });

        const log = (finished.permissionLog || []) as PermissionLogEntry[];
        fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
        fs.writeFileSync(
          path.join(EVIDENCE_DIR, `permission-relay-${decision}.json`),
          JSON.stringify(
            { decision, sentinel, log, reply: finished.lastResponse?.text ?? "" },
            null,
            2
          )
        );

        expect(finished.agentMode, `stayed live (lastError: ${finished.lastError})`).toBe("live");
        expect(
          log.length,
          "the harness's permission question never reached the relay"
        ).toBeGreaterThan(0);
        expect(
          log.every((entry) => entry.answeredWith === decision),
          `every question answered "${decision}": ${JSON.stringify(log)}`
        ).toBe(true);

        // The filesystem is the judge.
        if (decision === "deny") {
          expect(fs.existsSync(sentinel), "denied run must not create the file").toBe(false);
        } else {
          expect(fs.existsSync(sentinel), "allowed run must create the file").toBe(true);
          expect(fs.readFileSync(sentinel, "utf8").trim()).toBe("sentinel");
        }

        console.log(
          `PERMISSION_${decision.toUpperCase()}_OK tools=[${log.map((entry) => entry.tool_name).join(",")}] ` +
            `fileExists=${fs.existsSync(sentinel)}`
        );
      } finally {
        await overlayWindow
          .evaluate(async () => await (window as any).electronAPI.converseStop())
          .catch(() => {});
        // The killed claude process holds its cwd for a moment on Windows;
        // best-effort cleanup must not fail a run whose assertions passed.
        for (let attempt = 0; attempt < 5; attempt++) {
          try {
            fs.rmSync(workDir, { recursive: true, force: true });
            break;
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
        }
      }
    });
  }
});
