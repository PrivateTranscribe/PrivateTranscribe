import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "./fixtures/electron-app";
import { unlockTesterAccess } from "./fixtures/tester-access";

/**
 * A message sent while Claude Code is still working is queued and answered
 * next — never bounced with "busy". This is the Codex-style follow-up flow:
 * the CLI runs stdin user messages strictly in order, and the session's
 * staleness fence must not confuse "a newer utterance exists" with "the
 * running turn was interrupted" (the bug this spec was written against: the
 * first turn's whole reply was dropped as stale the moment a follow-up was
 * typed).
 *
 * The agent is the stub CLI (fixtures/claude-stub.cjs), which queues stdin
 * messages exactly like the real CLI does (verified live against v2.1.224).
 */

const STUB_PATH = path.join(__dirname, "fixtures", "claude-stub.cjs");

test.use({
  seedKokoroModel: true,
  appEnv: {
    PT_CONVERSE_CLAUDE_BIN: process.execPath,
    PT_CONVERSE_CLAUDE_ARGS: JSON.stringify([STUB_PATH]),
    // Long enough that the follow-up is reliably sent while turn one is still
    // in `thinking`.
    CLAUDE_STUB_DELAY_MS: "6000",
    CLAUDE_STUB_DELTA_GAP_MS: "100",
  },
});

test("a follow-up typed mid-turn is queued and both turns are answered", async ({
  controlPanel,
  overlayWindow,
}) => {
  test.setTimeout(300_000);

  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-converse-queue-"));
  await controlPanel.evaluate(
    (dir) =>
      localStorage.setItem(
        "converseProjects",
        JSON.stringify([{ path: dir, lastUsedAt: Date.now() }])
      ),
    projectDir
  );
  await unlockTesterAccess(controlPanel);

  // Pay the engine load outside the conversation, as the other converse specs do.
  await overlayWindow.waitForFunction(() => Boolean((window as any).__converseTest), null, {
    timeout: 30_000,
  });
  const engineStatus = await overlayWindow.evaluate(
    async () => await (window as any).electronAPI.readAloudLoadEngine()
  );
  expect(engineStatus.loaded, `engine failed to load: ${engineStatus.error}`).toBe(true);

  await controlPanel.getByRole("button", { name: /^Converse( Beta)?$/ }).click();
  await controlPanel.getByTestId("converse-recent-project").first().click();
  await controlPanel.getByRole("button", { name: "Start session" }).click();

  const status = controlPanel.getByTestId("converse-status");
  await expect(status).toHaveAttribute("data-state", "idle", { timeout: 20_000 });

  // Turn one.
  await controlPanel.getByTestId("converse-input").fill("Tell me about this project.");
  await controlPanel.getByRole("button", { name: "Send", exact: true }).click();
  await expect(status).toHaveAttribute("data-state", "thinking", { timeout: 10_000 });

  // The input stays usable mid-turn and says so.
  await expect(controlPanel.getByTestId("converse-input")).toBeEnabled();
  await expect(controlPanel.getByTestId("converse-input")).toHaveAttribute(
    "placeholder",
    /follow-up/i
  );

  // Turn two, sent while turn one is still being worked on: accepted straight
  // into the transcript, no refusal.
  await controlPanel.getByTestId("converse-input").fill("Also check the readme afterwards.");
  await controlPanel.getByRole("button", { name: "Send", exact: true }).click();
  await expect(controlPanel.getByTestId("converse-transcript")).toContainText(
    "Also check the readme afterwards."
  );

  // Both turns are answered, in order — the stub's short acknowledgement
  // appears once per answered turn. One ack would mean the queued follow-up
  // was lost; the pre-fix bug showed exactly one (the FIRST turn's reply was
  // dropped as stale).
  await expect
    .poll(
      async () =>
        (
          ((await controlPanel.getByTestId("converse-transcript").textContent()) || "").match(
            /Stub short acknowledgement/g
          ) || []
        ).length,
      { timeout: 120_000 }
    )
    .toBe(2);

  // And the loop settles back to listening once everything is spoken.
  await expect(status).toHaveAttribute("data-state", "listening", { timeout: 60_000 });
});
