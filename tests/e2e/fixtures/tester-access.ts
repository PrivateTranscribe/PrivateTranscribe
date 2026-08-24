import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

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

  await controlPanel.getByRole("button", { name: "Settings", exact: true }).click();
  await controlPanel.getByRole("button", { name: "PrivateTranscribe Pro", exact: true }).click();
  await controlPanel.getByPlaceholder("XXXX-XXXX-XXXX-XXXX").fill("E2EETEST00000000");
  await controlPanel.getByRole("button", { name: "Activate", exact: true }).click();

  await expect(controlPanel.getByText("PrivateTranscribe Pro - Active")).toBeVisible();
  // The activation toast covers the top-right of the window for 4s; a
  // screenshot taken under it would be judged with a toast in it.
  await expect(controlPanel.getByText("License activated!")).toHaveCount(0, { timeout: 10_000 });
}
