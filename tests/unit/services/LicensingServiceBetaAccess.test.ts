import { beforeEach, describe, expect, it, vi } from "vitest";

function installBrowserMocks() {
  const store = new Map<string, string>();
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

describe("LicensingService beta entitlement integrity", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("accepts beta access after a successful server activation", async () => {
    installBrowserMocks();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => activationResponse(true))
    );
    const licensing = await import("../../../src/services/LicensingService");

    expect(await licensing.activateLicense("TEST-TEST-TEST-TEST")).toMatchObject({
      success: true,
    });
    expect(licensing.getProStatus().betaAccess).toBe(true);
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
    const licensing = await import("../../../src/services/LicensingService");

    await licensing.activateLicense("PAID-PAID-PAID-PAID");

    expect(dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: licensing.LICENSE_STATUS_EVENT })
    );
  });

  it("does not restore beta access from a forged local entitlement and seal", async () => {
    const { localStorage } = installBrowserMocks();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => activationResponse(false))
    );
    const licensing = await import("../../../src/services/LicensingService");

    await licensing.activateLicense("PAID-PAID-PAID-PAID");

    const forgedEntitlement = JSON.stringify({
      token: "forged-token",
      expiresAt: null,
      betaAccess: true,
    });
    localStorage.setItem("privatetranscribe_entitlement", forgedEntitlement);
    localStorage.setItem(
      "privatetranscribe_seal",
      computeSeal(`PAID-PAID-PAID-PAID|${forgedEntitlement}|${navigator.userAgent.slice(0, 20)}`)
    );

    expect(licensing.getProStatus()).toMatchObject({
      isPro: true,
      betaAccess: false,
    });
  });
});
