import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

/**
 * Licensing and the update feed must live on ONE hostname.
 *
 * A refunded license is only revoked when the app can reach the licensing
 * endpoint, so a user who blocks that endpoint keeps Pro. That trade is only
 * acceptable while blocking it also costs them every future update. The moment
 * these two hostnames diverge, blocking licensing becomes free again and the
 * deterrent silently disappears - with nothing failing to signal it.
 */
function hostOf(url: string): string {
  return new URL(url).host;
}

const licensingSource = fs.readFileSync(
  path.join(process.cwd(), "src", "services", "LicensingService.ts"),
  "utf8"
);
const updaterSource = fs.readFileSync(
  path.join(process.cwd(), "src", "updater.js"),
  "utf8"
);

describe("licensing and update feed share a hostname", () => {
  const licensingUrl = licensingSource.match(
    /VITE_LICENSING_BASE_URL\s*\|\|\s*\n?\s*"([^"]+)"/
  )?.[1];
  const updateUrl = updaterSource.match(
    /UPDATE_FEED_URL\s*=\s*"([^"]+)"/
  )?.[1];

  it("finds both URLs", () => {
    expect(licensingUrl, "licensing default base URL").toBeTruthy();
    expect(updateUrl, "updater feed URL").toBeTruthy();
  });

  it("serves licensing from the update hostname", () => {
    expect(hostOf(licensingUrl!)).toBe(hostOf(updateUrl!));
  });

  it("no longer points licensing straight at supabase", () => {
    expect(licensingUrl).not.toMatch(/supabase\.co/);
  });

  it("uses https for both", () => {
    expect(new URL(licensingUrl!).protocol).toBe("https:");
    expect(new URL(updateUrl!).protocol).toBe("https:");
  });
});
