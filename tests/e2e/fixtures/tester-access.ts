import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

/** Answer `/licensing/activate` with an approved-tester entitlement. */
async function stubLicensingServer(controlPanel: Page): Promise<void> {
  await controlPanel.evaluate(() => {
    const realFetch = window.fetch.bind(window);
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/licensing/activate")) {
        return new Response(
          JSON.stringify({
            success: true,
            entitlement: { token: "e2e-token", expiresAt: null, betaAccess: true },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return realFetch(input, init);
    };
  });
}

/** The Pro settings screen, reached the way a user reaches it. */
async function openProSettings(controlPanel: Page): Promise<void> {
  await controlPanel.getByRole("button", { name: "Settings", exact: true }).click();
  await controlPanel.getByRole("button", { name: "PrivateTranscribe Pro", exact: true }).click();
}

/**
 * Take the app through its real activation path with a stubbed licensing
 * server.
 *
 * Tester access is deliberately session-only: it is set by a successful server
 * response and never restored from localStorage, so there is no key a spec
 * could write to fake it. Every spec that needs a beta feature unlocked has to
 * go through the activation UI, which is why this lives in fixtures/ rather
 * than in one spec file.
 */
export async function unlockTesterAccess(controlPanel: Page): Promise<void> {
  await stubLicensingServer(controlPanel);
  await openProSettings(controlPanel);

  await controlPanel.getByPlaceholder("XXXX-XXXX-XXXX-XXXX").fill("E2EETEST00000000");
  await controlPanel.getByRole("button", { name: "Activate", exact: true }).click();

  await expect(controlPanel.getByText("PrivateTranscribe Pro - Active")).toBeVisible();
  // The activation toast covers the top-right of the window for 4s; a
  // screenshot taken under it would be judged with a toast in it.
  await expect(controlPanel.getByText("License activated!")).toHaveCount(0, { timeout: 10_000 });
}

/** Everything LicensingService caches about an activation, in localStorage. */
const LICENSE_STORAGE_KEYS = [
  "privatetranscribe_license_key",
  "privatetranscribe_entitlement",
  "privatetranscribe_pro_status",
  "privatetranscribe_seal",
  "privatetranscribe_ts",
];

/**
 * Unlock tester access again after an app restart.
 *
 * The beta flag is session-only, so a restarted app is locked even though the
 * cached license is still on disk — and the Pro screen is then a race: it shows
 * the active banner until start-up revalidation against the real licensing
 * server finishes, and the activation form afterwards. A spec that guessed
 * either way would be flaky.
 *
 * Dropping the cached license first removes the race entirely: with no key
 * stored, revalidation returns without making a request and the activation form
 * is the only reachable state, so the normal unlock path applies. Only
 * licensing keys are touched — anything the spec is actually asserting on
 * stays where it was.
 */
export async function unlockTesterAccessAfterRestart(controlPanel: Page): Promise<void> {
  await controlPanel.evaluate((keys) => {
    for (const key of keys) localStorage.removeItem(key);
  }, LICENSE_STORAGE_KEYS);
  await controlPanel.reload({ waitUntil: "domcontentloaded" });

  await unlockTesterAccess(controlPanel);
}
