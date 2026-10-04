import fs from "node:fs";
import path from "node:path";
import { test, expect } from "./fixtures/electron-app";

/**
 * The upgrade path for analytics consent, which nobody can reach by hand.
 *
 * 0.15.0 widened what the optional analytics cover, so a grant given against
 * the older disclosure is paused until the new one has been shown and accepted.
 * That branch only runs on a profile written by an older build - a developer's
 * own machine was rewritten to the current version by the build they are
 * running, so dogfooding skips straight past it and every existing user lands
 * on it. These specs are the only thing standing in for that.
 */

const CONSENT_FILE = "analytics-consent.txt";
const MODAL_HEADING = "Help improve PrivateTranscribe";

const readConsent = (userDataDir: string) =>
  fs.readFileSync(path.join(userDataDir, CONSENT_FILE), "utf8").trim();

test.describe("analytics consent after an upgrade", () => {
  // A copy built from source never asks, so these runs act as an official build.
  test.use({ appEnv: { PRIVATETRANSCRIBE_OFFICIAL_BUILD: "1" } });

  test.describe("upgrading from a build that asked less", () => {
    test.use({ seedConsentFile: "granted" });

    test("asks again instead of assuming the old yes still covers it", async ({ controlPanel }) => {
      await expect(controlPanel.getByText(MODAL_HEADING)).toBeVisible();
      // The disclosure has to name what was added, or re-asking is theatre.
      await expect(controlPanel.getByText(/transcription speed/i)).toBeVisible();
      await expect(controlPanel.getByText(/CPU, GPU, or cloud mode/i)).toBeVisible();
    });

    test("records the new grant against the version that was shown", async ({
      controlPanel,
      userDataDir,
    }) => {
      await controlPanel.getByRole("button", { name: /yes/i }).click();
      await expect(controlPanel.getByText(MODAL_HEADING)).toBeHidden();

      expect(readConsent(userDataDir)).toBe("granted:v2");
    });

    test("takes no for an answer, and stops asking", async ({ controlPanel, userDataDir }) => {
      await controlPanel.getByRole("button", { name: /no/i }).click();
      await expect(controlPanel.getByText(MODAL_HEADING)).toBeHidden();

      expect(readConsent(userDataDir)).toBe("denied:v2");
    });
  });

  test.describe("upgrading from a build that was already told no", () => {
    test.use({ seedConsentFile: "denied" });

    // A previous refusal is an answer to a broader question than the one being
    // asked now. Re-prompting someone who already said no would read as nagging
    // them until they say yes.
    test("does not reopen a decision the user already made", async ({ controlPanel }) => {
      await expect(controlPanel.getByText(MODAL_HEADING)).toBeHidden();
    });
  });

  test.describe("already on the current disclosure", () => {
    test.use({ seedConsentFile: "granted:v2" });

    test("does not ask a user who has already seen this version", async ({ controlPanel }) => {
      await expect(controlPanel.getByText(MODAL_HEADING)).toBeHidden();
    });
  });
});
