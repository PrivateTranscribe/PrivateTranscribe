import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "./fixtures/electron-app";
import { evidenceDir } from "./fixtures/evidence";
import { unlockTesterAccess } from "./fixtures/tester-access";
import type { Page } from "@playwright/test";

test.use({ experimentalFeatures: true });

/**
 * Ledger gate `converse-permission-ux`: the user half of the permission relay.
 *
 * The relay itself was proven fail-closed by the live gate. What was missing was
 * everything a person touches: real sessions never turned the relay on, and no
 * UI existed to see a question or answer it — so enabling it would have meant
 * every question silently denying itself 55 seconds later.
 *
 * The seam this spec drives is the real one, end to end and in one direction:
 *
 *   stub `claude` reads the --mcp-config the app wrote
 *     -> spawns the app's REAL conversePermissionMcp.cjs with that port+token
 *     -> MCP tools/call approve
 *     -> loopback HTTP POST to the relay
 *     -> relay logs it and notifies the session
 *     -> the Converse page shows a card
 *     -> a click calls conversePermissionAnswer
 *     -> relay.answer resolves the held HTTP response
 *     -> the MCP reply reaches the stub, which writes what it got to disk.
 *
 * That last file is the judge. Asserting on the card alone would only prove the
 * page can draw a card; asserting on what the stub received proves the click
 * actually resolved the question the harness was blocked on. Nothing in the
 * chain is faked except the model, and no live Claude prompt is spent.
 */

const EVIDENCE_DIR = evidenceDir("converse-permission-ui");
const STUB_PATH = path.join(__dirname, "fixtures", "claude-stub.cjs");

/** A screenshot that is present but blank would pass a bare existence check. */
const MIN_SCREENSHOT_BYTES = 10_000;

/** Selects the stub's permission branch. Must contain the default marker. */
const PERMISSION_UTTERANCE = "Go ahead and ask permission to write that file.";

/**
 * Short deny timeout for the auto-deny case only. The shipped value is 55s;
 * sitting through it once per run would make this spec slower than the thing it
 * tests. It can only move the fail-closed timer, never disable it.
 */
const SHORT_TIMEOUT_MS = 6_000;

type StubDecision = { behavior: string; message?: string; updatedInput?: unknown };

async function captureEvidence(page: Page, fileName: string) {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const filePath = path.join(EVIDENCE_DIR, fileName);

  // The pointer stays where the last click left it, so without this the
  // evidence shows a hover state the design never asked for.
  await page.mouse.move(1180, 500);
  await page
    .waitForFunction(
      () =>
        document
          .getAnimations()
          .every(
            (animation) => animation.playState === "finished" || animation.playState === "idle"
          ),
      null,
      { timeout: 5_000 }
    )
    .catch(() => {
      // Something animates forever here; the screenshot is still worth having.
    });

  await page.screenshot({ path: filePath, fullPage: true });
  expect(fs.existsSync(filePath), `${fileName} was not written`).toBe(true);
  const bytes = fs.statSync(filePath).size;
  expect(bytes, `${fileName} is too small to show anything (${bytes} bytes)`).toBeGreaterThan(
    MIN_SCREENSHOT_BYTES
  );
  return filePath;
}

/** What the stub was handed back by the MCP call, once it has written it. */
async function readDecisions(file: string, timeoutMs = 30_000): Promise<StubDecision[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (fs.existsSync(file)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
        if (Array.isArray(parsed) && parsed.length > 0) return parsed as StubDecision[];
      } catch {
        // Half-written; try again.
      }
    }
    if (Date.now() > deadline) {
      throw new Error(`the stub never recorded a decision at ${file}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** Start a session from the page itself, exactly as a user would. */
async function startSessionFromPage(controlPanel: Page, overlayWindow: Page, projectDir: string) {
  await controlPanel.evaluate(
    (dir) =>
      localStorage.setItem(
        "converseProjects",
        JSON.stringify([{ path: dir, lastUsedAt: Date.now() }])
      ),
    projectDir
  );
  await unlockTesterAccess(controlPanel);

  // Kokoro is loaded outside the turn, the way the other converse gates do it.
  await overlayWindow.waitForFunction(() => Boolean((window as any).__converseTest), null, {
    timeout: 30_000,
  });
  const engineStatus = await overlayWindow.evaluate(
    async () => await (window as any).electronAPI.readAloudLoadEngine()
  );
  expect(engineStatus.loaded, `engine failed to load: ${engineStatus.error}`).toBe(true);

  await controlPanel.getByRole("button", { name: /^Converse( Beta)?$/ }).click();
  await expect(controlPanel.getByRole("heading", { name: "Converse" })).toBeVisible();
  await controlPanel.getByTestId("converse-recent-project").first().click();
  await expect(controlPanel.getByTestId("converse-project-path")).toHaveText(projectDir);
  await controlPanel.getByRole("button", { name: "Start session" }).click();
  await expect(controlPanel.getByTestId("converse-status")).toBeVisible();

  // The whole gate rests on this: a session started from the UI, with no
  // options passed, must have the relay running. Before this gate it did not.
  const started = await controlPanel.evaluate(
    async () => await (window as any).electronAPI.converseGetState()
  );
  expect(started.agentMode, "the stub run must use the live agent path").toBe("live");
  expect(
    started.permissionRelay,
    "a session started from the UI with no options must have the relay on by default"
  ).toBe(true);
}

/** Answer the oldest pending card and wait for that exact card to be gone. */
async function answerOldestCard(controlPanel: Page, action: "Allow" | "Deny") {
  const card = controlPanel.getByTestId("converse-permission-card").first();
  await expect(card).toBeVisible();
  const id = await card.getAttribute("data-permission-id");
  await card.getByRole("button", { name: action }).click();
  // Waiting on the id, not on the count, so a second card sliding into first
  // position can never be mistaken for the first one having been answered.
  await expect(
    controlPanel.locator(`[data-testid="converse-permission-card"][data-permission-id="${id}"]`)
  ).toHaveCount(0, { timeout: 15_000 });
  return Number(id);
}

async function askForPermission(controlPanel: Page) {
  await controlPanel.getByTestId("converse-input").fill(PERMISSION_UTTERANCE);
  await controlPanel.getByRole("button", { name: "Send", exact: true }).click();
}

function makeWorkspace(label: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pt-permission-ui-${label}-`));
  return { dir, resultFile: path.join(dir, "decisions.json") };
}

/** The killed stub can hold its cwd for a moment on Windows. */
function removeWorkspace(dir: string) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      // Retry; a cleanup failure must not fail a passing run.
    }
  }
}

const workspaces = {
  allow: makeWorkspace("allow"),
  deny: makeWorkspace("deny"),
  autodeny: makeWorkspace("autodeny"),
};

const stubEnv = (resultFile: string, extra: Record<string, string> = {}) => ({
  // Node refuses to spawn a .cmd without a shell on Windows, so the binary is
  // node itself and the stub rides in on the argument prefix.
  PT_CONVERSE_CLAUDE_BIN: process.execPath,
  PT_CONVERSE_CLAUDE_ARGS: JSON.stringify([STUB_PATH]),
  CLAUDE_STUB_PERMISSION_RESULT: resultFile,
  ...extra,
});

test.describe("converse permission ux", () => {
  test.describe("allowing", () => {
    test.use({
      seedKokoroModel: true,
      appEnv: stubEnv(workspaces.allow.resultFile, {
        // Two at once, so the queue has something to queue.
        CLAUDE_STUB_PERMISSION_COUNT: "2",
        CLAUDE_STUB_PERMISSION_INPUT: JSON.stringify({
          file_path: "notes/config.json",
          content: "hello from the stub",
        }),
      }),
    });

    test("shows the question, and Allow resolves it as allow", async ({
      controlPanel,
      overlayWindow,
    }) => {
      test.setTimeout(300_000);
      const { dir, resultFile } = workspaces.allow;

      try {
        await startSessionFromPage(controlPanel, overlayWindow, dir);
        await askForPermission(controlPanel);

        // ---------------------------------------------------------- pending
        const cards = controlPanel.getByTestId("converse-permission-card");
        await expect(cards.first()).toBeVisible({ timeout: 60_000 });

        // The tool and the input it would act on are both on screen.
        await expect(controlPanel.getByTestId("converse-permission-tool").first()).toHaveText(
          "Write"
        );
        await expect(controlPanel.getByTestId("converse-permission-input").first()).toContainText(
          "notes/config-1.json"
        );

        // Two questions at once queue visibly rather than replacing each other.
        await expect(cards).toHaveCount(2);
        await expect(controlPanel.getByTestId("converse-permission-queue").first()).toContainText(
          "Question 1 of 2"
        );

        // The countdown reads the relay's deadline, so it must be counting down
        // from something near the real timeout rather than from a made-up one.
        const countdown = controlPanel.getByTestId("converse-permission-countdown").first();
        await expect(countdown).toContainText(/Denies itself in \d+s/);
        const seconds = Number((await countdown.textContent())?.match(/(\d+)s/)?.[1]);
        expect(seconds, "countdown must reflect the real 55s deadline").toBeGreaterThan(40);
        expect(seconds).toBeLessThanOrEqual(55);

        // The status line has to say the session is waiting on a person, not
        // that it is thinking.
        const status = controlPanel.getByTestId("converse-status");
        await expect(status).toHaveAttribute("data-waiting", "permission");
        await expect(status).toContainText("Waiting for you");

        await captureEvidence(controlPanel, "converse-permission-pending.png");

        // --------------------------------------------------------- answered
        await answerOldestCard(controlPanel, "Allow");
        await answerOldestCard(controlPanel, "Allow");

        const records = controlPanel.getByTestId("converse-permission-record");
        await expect(records).toHaveCount(2, { timeout: 30_000 });
        await expect(records.first()).toContainText("Allowed Write");
        await expect(records.first()).toContainText("notes/config-1.json");
        await expect(records.first()).toHaveAttribute("data-behavior", "allow");
        await expect(controlPanel.getByTestId("converse-permission-card")).toHaveCount(0);
        await expect(status).not.toHaveAttribute("data-waiting", "permission");

        // The relay's own log has to agree with what the page drew.
        const log = await controlPanel.evaluate(
          async () => (await (window as any).electronAPI.converseGetState()).permissionLog
        );
        expect(log.map((entry: any) => entry.answeredWith)).toEqual(["allow", "allow"]);
        expect(log.every((entry: any) => entry.answeredBy === "user")).toBe(true);

        // THE judge: what the click actually resolved the harness's blocked
        // MCP call with, recorded by the process on the far side of the relay.
        const decisions = await readDecisions(resultFile);
        expect(decisions).toHaveLength(2);
        expect(decisions.every((decision) => decision.behavior === "allow")).toBe(true);

        // ------------------------------------------- the record persists
        // The transcript keeps it after the turn moves on; a record that only
        // existed while the question was fresh would tell the user nothing
        // about what they agreed to.
        await expect(controlPanel.getByTestId("converse-transcript")).toContainText(
          "Permission 1 came back allow.",
          { timeout: 60_000 }
        );
        await expect(records).toHaveCount(2);
        await expect(records.first()).toContainText("Allowed Write");
        await captureEvidence(controlPanel, "converse-permission-answered.png");
      } finally {
        await controlPanel
          .evaluate(async () => await (window as any).electronAPI.converseStop())
          .catch(() => {});
        removeWorkspace(dir);
      }
    });
  });

  test.describe("denying", () => {
    test.use({
      seedKokoroModel: true,
      appEnv: stubEnv(workspaces.deny.resultFile),
    });

    test("Deny resolves it as deny", async ({ controlPanel, overlayWindow }) => {
      test.setTimeout(300_000);
      const { dir, resultFile } = workspaces.deny;

      try {
        await startSessionFromPage(controlPanel, overlayWindow, dir);
        await askForPermission(controlPanel);

        const card = controlPanel.getByTestId("converse-permission-card").first();
        await expect(card).toBeVisible({ timeout: 60_000 });
        // One question on its own has no queue position to show.
        await expect(controlPanel.getByTestId("converse-permission-queue")).toHaveCount(0);

        await answerOldestCard(controlPanel, "Deny");

        const record = controlPanel.getByTestId("converse-permission-record").first();
        await expect(record).toBeVisible({ timeout: 30_000 });
        await expect(record).toContainText("Denied Write");
        await expect(record).toHaveAttribute("data-behavior", "deny");
        await expect(record).toHaveAttribute("data-answered-by", "user");
        // A user's "no" is not the same event as a question that ran out of
        // time, and must not borrow its explanation.
        await expect(record).not.toContainText("denied automatically");

        const decisions = await readDecisions(resultFile);
        expect(decisions.map((decision) => decision.behavior)).toEqual(["deny"]);

        await expect(controlPanel.getByTestId("converse-transcript")).toContainText(
          "Permission 1 came back deny.",
          { timeout: 60_000 }
        );
      } finally {
        await controlPanel
          .evaluate(async () => await (window as any).electronAPI.converseStop())
          .catch(() => {});
        removeWorkspace(dir);
      }
    });
  });

  test.describe("nobody answers", () => {
    test.use({
      seedKokoroModel: true,
      appEnv: stubEnv(workspaces.autodeny.resultFile, {
        PT_CONVERSE_PERMISSION_TIMEOUT_MS: String(SHORT_TIMEOUT_MS),
      }),
    });

    test("the card resolves to the auto-denied record the relay recorded", async ({
      controlPanel,
      overlayWindow,
    }) => {
      test.setTimeout(300_000);
      const { dir, resultFile } = workspaces.autodeny;

      try {
        await startSessionFromPage(controlPanel, overlayWindow, dir);
        await askForPermission(controlPanel);

        const card = controlPanel.getByTestId("converse-permission-card").first();
        await expect(card).toBeVisible({ timeout: 60_000 });
        // The countdown is honest about the shortened deadline rather than
        // showing a hardcoded 55.
        await expect(
          controlPanel.getByTestId("converse-permission-countdown").first()
        ).toContainText(/Denies itself in [1-6]s|Denying now/);

        // Nobody clicks. The relay's timer is what settles this.
        const record = controlPanel.getByTestId("converse-permission-record").first();
        await expect(record).toBeVisible({ timeout: 30_000 });
        await expect(record).toContainText("Denied Write");
        await expect(record).toContainText("denied automatically, no answer");
        await expect(record).toHaveAttribute("data-answered-by", "timeout");
        await expect(controlPanel.getByTestId("converse-permission-card")).toHaveCount(0);

        // Captured only now: a picture of the card still counting down would
        // not be evidence of the state this file is named after.
        await captureEvidence(controlPanel, "converse-permission-autodenied.png");

        // The page did not invent that outcome: the relay's log says the same.
        const log = await controlPanel.evaluate(
          async () => (await (window as any).electronAPI.converseGetState()).permissionLog
        );
        expect(log[0].answeredWith).toBe("deny");
        expect(log[0].answeredBy).toBe("timeout");

        // And the harness on the far side really was told no.
        const decisions = await readDecisions(resultFile);
        expect(decisions.map((decision) => decision.behavior)).toEqual(["deny"]);
      } finally {
        await controlPanel
          .evaluate(async () => await (window as any).electronAPI.converseStop())
          .catch(() => {});
        removeWorkspace(dir);
      }
    });
  });
});
