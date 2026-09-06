import fs from "node:fs";
import path from "node:path";
import { expect, test } from "./fixtures/electron-app";
import { unlockTesterAccess } from "./fixtures/tester-access";
import samples from "../fixtures/prompt-profile-samples.json";

// Opt-in observations with the already-installed model. No provider stubs,
// cloud credentials, automatic downloads, real microphone, or pasted text.
test.use({ appEnv: { PRIVATETRANSCRIBE_DIAG_DISABLE_OVERLAY_WINDOW: "1" } });
test("observe current and experimental prompts with the cached local model", async ({
  controlPanel: page,
}) => {
  test.setTimeout(240_000);
  const model = "qwen3.8-2b-distill-q4_k_m";
  const output =
    process.env.PT_PROMPT_EVIDENCE_DIR || path.resolve("test-results/prompt-profiles-live");
  fs.mkdirSync(output, { recursive: true });
  await page.evaluate((id) => {
    localStorage.setItem("useReasoningModel", "true");
    localStorage.setItem("reasoningProvider", "local");
    localStorage.setItem("reasoningModel", id);
    localStorage.setItem("preferredLanguage", "auto");
  }, model);
  await unlockTesterAccess(page);
  await page
    .getByRole("navigation")
    .getByRole("button", { name: /^AI Enhancement/ })
    .click();
  await expect(
    page.getByRole("button", { name: "Compare both prompts", exact: true })
  ).toBeEnabled();
  const results: unknown[] = [];
  for (const sample of samples) {
    await page.getByRole("textbox", { name: "Text to clean up" }).fill(sample.text);
    await page.getByRole("button", { name: "Compare both prompts", exact: true }).click();
    await expect(page.getByTestId("comparison-result")).toHaveCount(2, { timeout: 100_000 });
    await expect(
      page.getByRole("button", { name: "Compare both prompts", exact: true })
    ).toBeEnabled();
    const outputs = await page.getByTestId("comparison-result").allTextContents();
    const timings = await page.getByText(/Qwen3.8 2B Distill ·/).allTextContents();
    results.push({
      ...sample,
      outputs,
      timings,
      errors: await page.getByRole("alert").allTextContents(),
    });
    fs.writeFileSync(
      path.join(output, "local-observations.json"),
      JSON.stringify(
        { model, date: new Date().toISOString(), repeats: 1, style: "none", results },
        null,
        2
      )
    );
    console.log(`Observed ${sample.id}: ${JSON.stringify(outputs)}`);
    if (["closing", "unclear-word"].includes(sample.id)) {
      await page.getByTestId("comparison-result").last().scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(output, `after-live-${sample.id}.png`) });
    }
  }
});
