import { expect, test } from "./fixtures/electron-app";
import { unlockTesterAccess } from "./fixtures/tester-access";
import type { Page } from "@playwright/test";

/**
 * Ledger gate `beta-access-offline-grace`: an approved tester who is offline
 * keeps their beta features.
 *
 * Before this, the tester flag was module state in one window, set only by a
 * successful `/licensing/activate` response. A tester with no connection kept
 * cached Pro but lost every beta gate, silently — the Correction Memory page
 * still listed their corrections while the pipeline had stopped applying them.
 *
 * What this spec proves is narrow and load-bearing: after a reload in which
 * every licensing request FAILS, the beta gate is still open. The stub rejects
 * rather than answering, so a pass cannot come from a lucky round-trip, and the
 * rejection counter is asserted to have fired — otherwise "unlocked" would be
 * consistent with "the code never even tried to validate".
 *
 * The overlay window is deliberately not part of the proof. It has no
 * observable beta surface to assert on (its lock state only shows up in what a
 * completed dictation does downstream, which is the 40-second real-whisper
 * territory of correction-memory.spec.ts). Both windows read the same
 * localStorage through the same LicensingService, so the control panel reload
 * is the honest, cheap proof for the gate; the overlay path is covered where it
 * can actually be observed.
 */

type LicensingProbe = {
  /** Licensing requests the stub refused to let out. */
  rejected: number;
  /** Licensing requests that came back with a usable response. Must stay 0. */
  succeeded: number;
};

declare global {
  interface Window {
    __licensingProbe?: LicensingProbe;
  }
}

/**
 * Simulate the network being down for licensing, from before app code runs.
 *
 * An init script is what makes this a real offline test: it is installed on the
 * page and applies to the NEXT navigation, so the stub is in place before
 * main.jsx fires its start-up `refreshProStatus()`. Only licensing is cut off —
 * everything else the renderer loads keeps working, so the app is not being
 * tested in some other broken state.
 */
async function goOfflineForLicensing(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.__licensingProbe = { rejected: 0, succeeded: 0 };
    const realFetch = window.fetch.bind(window);
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/licensing/")) {
        window.__licensingProbe!.rejected += 1;
        throw new TypeError("Failed to fetch");
      }
      return realFetch(input, init);
    };
  });
}

const readProbe = (page: Page): Promise<LicensingProbe> =>
  page.evaluate(() => window.__licensingProbe ?? { rejected: 0, succeeded: 0 });

test.describe("beta access offline", () => {
  // Both renderer windows share one localStorage and both revalidate on start.
  // The overlay would post this spec's fake key to the REAL licensing server,
  // be told it is not a licence, and wipe the shared cache mid-test. Nothing
  // here needs the overlay.
  test.use({ appEnv: { PRIVATETRANSCRIBE_DIAG_DISABLE_OVERLAY_WINDOW: "1" } });

  test("keeps a beta page unlocked when every licensing call fails", async ({ controlPanel }) => {
    await unlockTesterAccess(controlPanel);

    // Baseline: unlocked while the stubbed server is still answering. The
    // sidebar drops the "Beta" badge exactly when the gate opens, so the button
    // name is the gate's own read-out rather than a proxy for it.
    await expect(
      controlPanel.getByRole("button", { name: "AI Enhancement", exact: true })
    ).toBeVisible();

    // The cached entitlement is what has to carry the flag across the reload.
    const cached = await controlPanel.evaluate(() =>
      JSON.parse(localStorage.getItem("privatetranscribe_entitlement") ?? "{}")
    );
    expect(cached.betaAccess, "activation did not persist betaAccess into the cache").toBe(true);

    // ------------------------------------------------- the network goes away
    await goOfflineForLicensing(controlPanel);
    await controlPanel.reload({ waitUntil: "domcontentloaded" });

    // Start-up revalidation runs on a microtask after mount; wait for the
    // failure rather than racing it, so "unlocked" is measured after the code
    // that used to clear the flag has had its turn.
    await expect
      .poll(() => readProbe(controlPanel).then((probe) => probe.rejected), { timeout: 20_000 })
      .toBeGreaterThan(0);

    // ---------------------------------------------------- still a tester
    // The gate is read during render, not subscribed to, so the sidebar painted
    // at mount could predate the failed round-trip. Navigating re-renders it,
    // which makes every assertion below a fresh read taken AFTER the failure.
    await controlPanel.getByRole("button", { name: "Home", exact: true }).click();

    await expect(
      controlPanel.getByRole("button", { name: "AI Enhancement", exact: true })
    ).toBeVisible();
    await expect(controlPanel.getByRole("button", { name: "AI Enhancement Beta" })).toHaveCount(0);

    await controlPanel.getByRole("button", { name: "AI Enhancement", exact: true }).click();
    await expect(controlPanel.getByRole("heading", { name: "AI Enhancement" })).toBeVisible();

    // The locked page renders this instead of the real controls.
    await expect(controlPanel.getByText("This beta requires approved tester access.")).toHaveCount(
      0
    );
    // ...and the real control is present, so the assertion above is not passing
    // because the page failed to render at all.
    await expect(controlPanel.getByTestId("agent-name-input")).toBeVisible();

    const probe = await readProbe(controlPanel);
    expect(probe.rejected, "the offline stub never intercepted a licensing call").toBeGreaterThan(0);
    expect(probe.succeeded, "a licensing round-trip succeeded; this was not an offline run").toBe(
      0
    );

    await controlPanel.screenshot({
      path: "test-results/e2e/beta-offline-ai-enhancement.png",
      fullPage: true,
    });
  });

  /**
   * The other half of the policy: reachable server wins.
   *
   * Offline grace must not become "once a tester, always a tester". With the
   * server answering, a `betaAccess: false` entitlement has to re-lock the page
   * even though the cache said true a moment ago.
   */
  test("re-locks when a reachable server downgrades the tester", async ({ controlPanel }) => {
    await unlockTesterAccess(controlPanel);
    await expect(
      controlPanel.getByRole("button", { name: "AI Enhancement", exact: true })
    ).toBeVisible();

    await controlPanel.addInitScript(() => {
      window.__licensingProbe = { rejected: 0, succeeded: 0 };
      const realFetch = window.fetch.bind(window);
      window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/licensing/activate")) {
          window.__licensingProbe!.succeeded += 1;
          return new Response(
            JSON.stringify({
              success: true,
              entitlement: { token: "e2e-token", expiresAt: null, betaAccess: false },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        return realFetch(input, init);
      };
    });
    await controlPanel.reload({ waitUntil: "domcontentloaded" });

    await expect
      .poll(() => readProbe(controlPanel).then((probe) => probe.succeeded), { timeout: 20_000 })
      .toBeGreaterThan(0);

    // The server's answer has to land in the cache, or the next offline start
    // would resurrect the access it just took away. This is also what keeps the
    // `_serverVerifiedBetaAccess || cached` OR safe: both halves are now false.
    expect(
      await controlPanel.evaluate(
        () => JSON.parse(localStorage.getItem("privatetranscribe_entitlement") ?? "{}").betaAccess
      )
    ).toBe(false);

    // Same re-render note as above: the badge is read at render time.
    await controlPanel.getByRole("button", { name: "Home", exact: true }).click();
    await expect(controlPanel.getByRole("button", { name: "AI Enhancement Beta" })).toBeVisible();
  });
});
