import { expect, test } from "./fixtures/electron-app";

/**
 * History entries were truncated twice over: sliced to 280 characters in JS
 * and clamped to three lines in CSS. Whichever hit first won, so an ordinary
 * dictation was cut mid-word well before the visible lines were full.
 */
const PARAGRAPH =
  "I feel like with the system before you could like talk Danish and then switch to " +
  "English mid conversation or like mid transcription and then it would like it would " +
  "still have like some that was Danish and some that was English. But I guess I think " +
  "this system is fine actually because you never really switch I believe.";

const VERY_LONG = Array.from(
  { length: 8 },
  (_, i) =>
    `Sentence number ${i + 1} of a long dictation that keeps going well past any reasonable preview length.`
).join(" ");

async function seed(page: import("@playwright/test").Page, text: string) {
  await page.evaluate(async (value) => {
    await (
      window as { electronAPI?: { saveTranscription: (t: string, d: number) => Promise<unknown> } }
    ).electronAPI?.saveTranscription(value, 30);
  }, text);
  await page.getByRole("button", { name: "History", exact: true }).click();
  await expect(page.getByRole("heading", { name: "History" })).toBeVisible();
}

test.describe("history entry truncation", () => {
  test("shows an ordinary dictation in full", async ({ controlPanel }) => {
    await seed(controlPanel, PARAGRAPH);

    // The whole thing fits inside the preview, so nothing is hidden and there
    // is nothing to expand.
    await expect(controlPanel.getByText(PARAGRAPH)).toBeVisible();
    await expect(controlPanel.getByRole("button", { name: /Show More/ })).toHaveCount(0);
  });

  test("clamps a genuinely long one and expands it again", async ({ controlPanel }) => {
    await seed(controlPanel, VERY_LONG);

    const showMore = controlPanel.getByRole("button", { name: /Show More/ });
    await expect(showMore).toBeVisible();

    await showMore.click();
    await expect(controlPanel.getByRole("button", { name: /Show Less/ })).toBeVisible();

    // The toggle has to survive expanding, even though expanding removes the
    // overflow that justified showing it.
    await controlPanel.getByRole("button", { name: /Show Less/ }).click();
    await expect(controlPanel.getByRole("button", { name: /Show More/ })).toBeVisible();
  });

  test("never cuts mid-word, the way a character slice did", async ({ controlPanel }) => {
    await seed(controlPanel, VERY_LONG);

    // The old slice appended its own ellipsis into the text node. The clamp
    // leaves the text intact and hides the overflow visually instead.
    const text = await controlPanel
      .locator("p", { hasText: "Sentence number 1" })
      .first()
      .innerText();
    expect(text).toContain("Sentence number 8");
  });
});
