import fs from "node:fs";
import path from "node:path";
import { expect, test } from "./fixtures/electron-app";
import { unlockTesterAccess, unlockTesterAccessAfterRestart } from "./fixtures/tester-access";
import type { Page } from "@playwright/test";

/**
 * Ledger gate `merge-ai-pages`: the Voice Assistant page is gone and everything
 * it offered lives on AI Enhancement.
 *
 * The interesting part is not that a text field renders. It is that the name
 * typed into it still lands in the system prompt the reasoning pipeline sends,
 * and that it survives a restart under the same storage key an existing user
 * already has. A merge that moved the control but broke either of those would
 * look completely fine in a screenshot.
 *
 * No live prompt is spent. The reasoning provider is pointed at a `.invalid`
 * host that can never resolve, and `window.fetch` is intercepted in the page
 * the same way tests/e2e/fixtures/tester-access.ts stubs licensing. Everything
 * between the text field and the request body — useAgentName, PromptStudio,
 * ReasoningService, getSystemPrompt — is the real shipped code.
 */

const EVIDENCE_DIR = path.resolve("test-results/e2e");

/** A screenshot that is present but blank would pass a bare existence check. */
const MIN_SCREENSHOT_BYTES = 10_000;

/** Distinctive enough that finding it in a prompt cannot be a coincidence. */
const AGENT_NAME = "Nimbus7Quartzly";

/**
 * Unresolvable by construction (RFC 2606 reserves `.invalid`), so even if the
 * fetch interception below were removed the spec still could not reach a
 * provider.
 */
const FAKE_REASONING_BASE = "https://e2e.invalid/v1";

async function openAiEnhancement(controlPanel: Page) {
  await controlPanel.getByRole("button", { name: /^AI Enhancement( Beta)?$/ }).click();
  await expect(controlPanel.getByRole("heading", { name: "AI Enhancement" })).toBeVisible();
  await controlPanel.locator("summary").filter({ hasText: "Advanced settings" }).click();
}

async function captureEvidence(page: Page, fileName: string, fullPage: boolean) {
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
      // Something animates forever on this screen; the shot is still worth having.
    });

  if (fullPage) {
    await page.screenshot({ path: filePath, fullPage: true });
  } else {
    // The sidebar is a fixed 220px column; 240 catches its right border. The
    // before/after pair is clipped identically so they can be laid side by side.
    const height = await page.evaluate(() => window.innerHeight);
    await page.screenshot({ path: filePath, clip: { x: 0, y: 0, width: 240, height } });
  }

  expect(fs.existsSync(filePath), `${fileName} was not written`).toBe(true);
  const bytes = fs.statSync(filePath).size;
  expect(bytes, `${fileName} is too small to show anything (${bytes} bytes)`).toBeGreaterThan(
    MIN_SCREENSHOT_BYTES
  );
}

test.describe("ai enhancement", () => {
  // Both renderer windows share one localStorage and both re-validate the
  // cached license on startup. After a restart that means the overlay posts the
  // spec's fake key to the real licensing server, is told it is not a licence,
  // and wipes the shared license data — sometimes after the control panel has
  // finished re-activating, which silently re-locks the page mid-test. Nothing
  // here needs the overlay, so it stays shut and the restart is deterministic.
  test.use({ appEnv: { PRIVATETRANSCRIBE_DIAG_DISABLE_OVERLAY_WINDOW: "1" } });

  test("absorbs the voice assistant, keeps its storage, and reaches the prompt", async ({
    controlPanel,
    relaunchElectronApp,
  }) => {
    await unlockTesterAccess(controlPanel);

    // ------------------------------------------------ the page is gone
    await expect(controlPanel.getByRole("button", { name: /Voice Assistant/ })).toHaveCount(0);
    await expect(controlPanel.getByRole("heading", { name: "Voice Assistant" })).toHaveCount(0);

    await openAiEnhancement(controlPanel);

    // ------------------------------------- its features are on this page
    await controlPanel.getByText("Voice instructions", { exact: true }).click();
    const nameInput = controlPanel.getByTestId("agent-name-input");
    await expect(nameInput).toBeVisible();
    // The trigger-phrase explainer and Prompt Studio came across too, inside
    // their quieter disclosure rows.
    await expect(controlPanel.getByText(/Say "Hey .*" before an instruction/)).toBeVisible();
    await controlPanel.getByText("Prompt tools", { exact: true }).click();
    await expect(controlPanel.getByRole("button", { name: "Customize" })).toBeVisible();

    await nameInput.fill(AGENT_NAME);
    await controlPanel.getByTestId("agent-name-save").click();

    await expect(controlPanel.getByText(`Assistant name updated`)).toBeVisible();
    await controlPanel.getByRole("button", { name: "OK", exact: true }).click();

    // The key is the one an existing user already has. Renaming it would strand
    // everyone who ever set a name on the old page.
    expect(await controlPanel.evaluate(() => localStorage.getItem("agentName"))).toBe(AGENT_NAME);

    await captureEvidence(controlPanel, "ai-enhancement-merged.png", true);

    // The control panel scrolls inside its own container, so a "full page"
    // screenshot is only ever one viewport tall. Prompt Studio sits below the
    // fold and needs its own shot rather than being left unjudged.
    await controlPanel.getByRole("button", { name: "Customize" }).scrollIntoViewIfNeeded();
    // Renaming has to reach the prompt shown further down the same page, not
    // just the field that was typed in.
    await expect(controlPanel.getByText(`Triggered by "Hey ${AGENT_NAME}"`)).toBeVisible();
    await captureEvidence(controlPanel, "ai-enhancement-merged-prompt-studio.png", true);

    await controlPanel.getByRole("button", { name: "Home", exact: true }).click();
    await captureEvidence(controlPanel, "sidebar-after-merge.png", false);

    // ----------------------------------------------- survives a restart
    const relaunched = await relaunchElectronApp();
    const panel = relaunched.controlPanel;

    expect(await panel.evaluate(() => localStorage.getItem("agentName"))).toBe(AGENT_NAME);
    await expect(panel.getByRole("button", { name: /Voice Assistant/ })).toHaveCount(0);

    await unlockTesterAccessAfterRestart(panel);
    await openAiEnhancement(panel);
    await panel.getByText("Voice instructions", { exact: true }).click();
    await expect(panel.getByTestId("agent-name-input")).toHaveValue(AGENT_NAME);

    // -------------------------------------- the name reaches the prompt
    // Point the reasoning pipeline at an unreachable host and capture what it
    // would have sent. PromptStudio reads the stored name through the same
    // useAgentName hook the rest of the app does, hands it to
    // ReasoningService.processText, and that is what builds the system prompt.
    await panel.evaluate((base) => {
      localStorage.setItem("useReasoningModel", "true");
      localStorage.setItem("reasoningModel", "gpt-4.1-nano");
      localStorage.setItem("reasoningProvider", "custom");
      localStorage.setItem("cloudReasoningBaseUrl", base);
      localStorage.setItem("customReasoningApiKey", "e2e-not-a-real-key");

      (window as any).__promptCapture = [];
      const realFetch = window.fetch.bind(window);
      window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("e2e.invalid")) {
          (window as any).__promptCapture.push({ url, body: String(init?.body ?? "") });
          return new Response(JSON.stringify({ output_text: "captured by the e2e stub" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return realFetch(input, init);
      };
    }, FAKE_REASONING_BASE);

    // PromptStudio reads the stored name when it mounts, so it has to be
    // remounted after the settings above were written.
    await panel.getByRole("button", { name: "Home", exact: true }).click();
    await openAiEnhancement(panel);

    await panel.getByText("Prompt tools", { exact: true }).click();
    await panel.getByRole("button", { name: "Test" }).click();
    // The preview line proves the stored name is what Prompt Studio is holding.
    await expect(panel.getByText(`Try addressing "${AGENT_NAME}"`)).toBeVisible();

    await panel.getByRole("button", { name: "Run Test" }).click();
    await expect(panel.getByText("captured by the e2e stub")).toBeVisible({ timeout: 30_000 });

    const captured: Array<{ url: string; body: string }> = await panel.evaluate(
      () => (window as any).__promptCapture ?? []
    );
    expect(
      captured.length,
      "the reasoning call never reached the stubbed endpoint"
    ).toBeGreaterThan(0);

    // The model picker also probes the custom endpoint, and those requests carry
    // no body, so the reasoning call has to be picked out rather than assumed to
    // be first.
    type ChatMessage = { role: string; content: string };
    let systemMessage: ChatMessage | undefined;
    for (const request of captured) {
      if (!request.body) continue;
      const body = JSON.parse(request.body);
      const messages: ChatMessage[] = body.input ?? body.messages ?? [];
      systemMessage = messages.find((message) => message.role === "system");
      if (systemMessage) break;
    }

    expect(
      systemMessage,
      `no system message in any of ${captured.length} captured request(s)`
    ).toBeTruthy();
    expect(
      systemMessage!.content,
      "the stored agent name never reached the system prompt"
    ).toContain(AGENT_NAME);
    // The placeholder must be substituted, not shipped raw.
    expect(systemMessage!.content).not.toContain("{{agentName}}");
  });

  test("shows an existing tester their stored voice-assistant values", async ({
    controlPanel,
    relaunchElectronApp,
  }) => {
    // What a user who configured the old Voice Assistant page already has on
    // disk. Same keys, written before the merged page is ever opened.
    const storedPrompt = "Rewrite everything as haiku. Address the user as {{agentName}}.";
    await controlPanel.evaluate((prompt) => {
      localStorage.setItem("agentName", "LegacyAtlas");
      localStorage.setItem("customUnifiedPrompt", JSON.stringify(prompt));
    }, storedPrompt);

    const relaunched = await relaunchElectronApp();
    const panel = relaunched.controlPanel;

    await unlockTesterAccess(panel);
    await openAiEnhancement(panel);

    await panel.getByText("Voice instructions", { exact: true }).click();
    await expect(panel.getByTestId("agent-name-input")).toHaveValue("LegacyAtlas");
    // Prompt Studio opens on its View tab, which renders the stored prompt with
    // the stored name filled in.
    await expect(panel.locator("summary").filter({ hasText: "Prompt tools" })).toContainText(
      "Custom"
    );
    await panel.getByText("Prompt tools", { exact: true }).click();
    await expect(panel.getByText("Custom prompt", { exact: true }).last()).toBeVisible();
    await expect(panel.getByText(/Rewrite everything as haiku/)).toBeVisible();
    await expect(panel.getByText(/Address the user as LegacyAtlas/)).toBeVisible();
  });
});
