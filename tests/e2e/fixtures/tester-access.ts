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
  await controlPanel.getByRole("button", { name: "Pro & Beta", exact: true }).click();
}

/**
 * Take the app through its real activation path with a stubbed licensing
 * server.
 *
 * Tester access is only ever granted by a successful server response. It is
 * cached afterwards — the sealed entitlement carries `betaAccess`, which is what
 * keeps an offline tester unlocked (see tests/e2e/beta-offline.spec.ts) — but
 * the seal is computed over the licence key and the exact entitlement string, so
 * a spec cannot fake the cache by writing localStorage. Going through the
 * activation UI is still the only way in, which is why this lives in fixtures/
 * rather than in one spec file.
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
 * A restarted app starts from the cached entitlement a previous spec step
 * activated with a fake key, and start-up revalidation posts that key to the
 * REAL licensing server, which does not know it. So the Pro screen is a race:
 * the active banner until that round-trip lands, the activation form afterwards,
 * and the cached tester flag disappears with it. A spec that guessed either way
 * would be flaky.
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
