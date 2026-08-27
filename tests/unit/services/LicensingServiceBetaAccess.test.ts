import { beforeEach, describe, expect, it, vi } from "vitest";

function installBrowserMocks(seed?: Map<string, string>) {
  const store = seed ?? new Map<string, string>();
  const localStorage = {
    getItem: vi.fn((key: string) => store.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => store.set(key, String(value))),
    removeItem: vi.fn((key: string) => store.delete(key)),
    clear: vi.fn(() => store.clear()),
  };

  vi.stubGlobal("localStorage", localStorage);
  vi.stubGlobal("navigator", { userAgent: "Windows test browser" });
  vi.stubGlobal("window", {
    localStorage,
    electronAPI: {
      getMachineId: vi.fn(async () => ({ id: "test-device" })),
    },
  });

  return { store, localStorage };
}

function computeSeal(data: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < data.length; index += 1) {
    hash ^= data.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function activationResponse(betaAccess: boolean) {
  return {
    ok: true,
    json: vi.fn(async () => ({
      success: true,
      entitlement: {
        token: "signed-token-placeholder",
        expiresAt: "2026-09-08T00:00:00.000Z",
        betaAccess,
      },
    })),
  };
}

function revokedResponse() {
  return {
    ok: false,
    json: vi.fn(async () => ({
      success: false,
      revoked: true,
      error: "This license is no longer active.",
    })),
  };
}

const ENTITLEMENT_KEY = "privatetranscribe_entitlement";
const SEAL_KEY = "privatetranscribe_seal";
const LICENSE_KEY = "privatetranscribe_license_key";

async function importLicensing() {
  return import("../../../src/services/LicensingService");
}

describe("LicensingService beta entitlement integrity", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("accepts beta access after a successful server activation", async () => {
    const { store } = installBrowserMocks();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => activationResponse(true))
    );
    const licensing = await importLicensing();

    expect(await licensing.activateLicense("TEST-TEST-TEST-TEST")).toMatchObject({
      success: true,
    });
    expect(licensing.getProStatus().betaAccess).toBe(true);

    // The flag has to be IN the cached entitlement, not only in module state —
    // that is the whole point of the offline grace.
    expect(JSON.parse(store.get(ENTITLEMENT_KEY)!)).toMatchObject({
      token: "signed-token-placeholder",
      expiresAt: "2026-09-08T00:00:00.000Z",
      betaAccess: true,
    });
  });

  it("notifies the current renderer immediately after activation", async () => {
    installBrowserMocks();
    const dispatchEvent = vi.fn();
    window.dispatchEvent = dispatchEvent;
    vi.stubGlobal(
      "CustomEvent",
      class CustomEvent {
        type: string;
        constructor(type: string) {
          this.type = type;
        }
      }
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => activationResponse(false))
    );
    const licensing = await importLicensing();

    await licensing.activateLicense("PAID-PAID-PAID-PAID");

    expect(dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: licensing.LICENSE_STATUS_EVENT })
    );
  });

  /**
   * The offline-grace gate itself.
   *
   * A second renderer window (and an app restart) is a fresh module instance
   * with `_serverVerifiedBetaAccess` back at false. Resetting the module registry
   * and re-importing against the same storage is exactly that, and the fetch stub
   * throws so the re-import cannot cheat by going back to the server.
   */
  it("restores beta access in a fresh window from the cache, with no network", async () => {
    const { store } = installBrowserMocks();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => activationResponse(true))
    );
    const firstWindow = await importLicensing();
    await firstWindow.activateLicense("TEST-TEST-TEST-TEST");

    vi.resetModules();
    vi.unstubAllGlobals();
    installBrowserMocks(store);
    const offlineFetch = vi.fn(async () => {
      throw new Error("network is down");
    });
    vi.stubGlobal("fetch", offlineFetch);

    const secondWindow = await importLicensing();
    expect(secondWindow.getProStatus()).toMatchObject({ isPro: true, betaAccess: true });
    expect(offlineFetch).not.toHaveBeenCalled();

    // And a start-up revalidation that cannot reach the server keeps it.
    const refreshed = await secondWindow.refreshProStatus();
    expect(offlineFetch).toHaveBeenCalled();
    expect(refreshed).toMatchObject({ isPro: true, betaAccess: true, offlineGrace: true });
  });

  it("does not restore beta access when the entitlement no longer matches its seal", async () => {
    const { store, localStorage } = installBrowserMocks();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => activationResponse(false))
    );
    const licensing = await importLicensing();

    await licensing.activateLicense("PAID-PAID-PAID-PAID");

    // Edit the cached JSON and leave the seal that was written for the old one.
    localStorage.setItem(
      ENTITLEMENT_KEY,
      JSON.stringify({ token: "forged-token", expiresAt: null, betaAccess: true })
    );

    // A broken seal fails closed for everything, not just beta.
    expect(licensing.getProStatus()).toMatchObject({
      isPro: false,
      betaAccess: false,
      error: "License data integrity check failed - please re-activate",
    });
    expect(store.get(SEAL_KEY)).toBeTruthy();
  });

  it("also refuses a tampered entitlement in a fresh window", async () => {
    const { store } = installBrowserMocks();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => activationResponse(false))
    );
    const firstWindow = await importLicensing();
    await firstWindow.activateLicense("PAID-PAID-PAID-PAID");
    store.set(
      ENTITLEMENT_KEY,
      JSON.stringify({ token: "forged-token", expiresAt: null, betaAccess: true })
    );

    vi.resetModules();
    vi.unstubAllGlobals();
    installBrowserMocks(store);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network is down");
      })
    );

    const secondWindow = await importLicensing();
    expect(secondWindow.getProStatus()).toMatchObject({ isPro: false, betaAccess: false });
  });

  it("drops cached beta access when a reachable server says the tester lost it", async () => {
    const { store } = installBrowserMocks();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(activationResponse(true))
      .mockResolvedValueOnce(activationResponse(false));
    vi.stubGlobal("fetch", fetchMock);
    const licensing = await importLicensing();

    await licensing.activateLicense("TEST-TEST-TEST-TEST");
    expect(licensing.getProStatus().betaAccess).toBe(true);

    // Server reachable = server is truth. The OR against the module flag must
    // not keep the stale `true` alive.
    const refreshed = await licensing.refreshProStatus();
    expect(refreshed).toMatchObject({ isPro: true, betaAccess: false });
    expect(JSON.parse(store.get(ENTITLEMENT_KEY)!).betaAccess).toBe(false);
  });

  it("clears everything, cached beta flag included, when the license is revoked", async () => {
    const { store } = installBrowserMocks();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(activationResponse(true))
      .mockResolvedValueOnce(revokedResponse());
    vi.stubGlobal("fetch", fetchMock);
    const licensing = await importLicensing();

    await licensing.activateLicense("TEST-TEST-TEST-TEST");
    expect(licensing.getProStatus().betaAccess).toBe(true);

    expect(await licensing.refreshProStatus()).toMatchObject({ isPro: false, betaAccess: false });
    expect(store.get(ENTITLEMENT_KEY)).toBeUndefined();
    expect(store.get(SEAL_KEY)).toBeUndefined();
    expect(store.get(LICENSE_KEY)).toBeUndefined();

    // And it stays gone for the next window, which has no module state at all.
    vi.resetModules();
    vi.unstubAllGlobals();
    installBrowserMocks(store);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network is down");
      })
    );
    const nextWindow = await importLicensing();
    expect(nextWindow.getProStatus()).toMatchObject({ isPro: false, betaAccess: false });
  });

  it("leaves an entitlement cached by an older build without beta access", async () => {
    // Pre-`betaAccess` shape, sealed the way the old build sealed it.
    const legacyEntitlement = JSON.stringify({ token: "old-token", expiresAt: null });
    const store = new Map<string, string>([
      [LICENSE_KEY, "TEST-TEST-TEST-TEST"],
      [ENTITLEMENT_KEY, legacyEntitlement],
      ["privatetranscribe_pro_status", "active"],
    ]);
    installBrowserMocks(store);
    store.set(
      SEAL_KEY,
      computeSeal(`TEST-TEST-TEST-TEST|${legacyEntitlement}|${navigator.userAgent.slice(0, 20)}`)
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network is down");
      })
    );

    const licensing = await importLicensing();
    // Pro survives, beta does not, until one online validation rewrites the shape.
    expect(licensing.getProStatus()).toMatchObject({ isPro: true, betaAccess: false });
  });
});
