import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/services/LicensingService", () => ({
  getProStatus: vi.fn(() => ({
    isPro: false,
    licenseKey: null,
    expiresAt: null,
    offlineGrace: false,
    error: null,
    _t: 0,
  })),
  refreshProStatus: vi.fn(),
  _verifyToken: vi.fn(() => false),
}));

import { getEffectiveEntitlement, getProPreview } from "../../../src/hooks/useProStatus";

function installLocalStorage() {
  const store = new Map<string, string>();
  const storage = {
    getItem: vi.fn((key: string) => store.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store.set(key, String(value));
    }),
    removeItem: vi.fn((key: string) => {
      store.delete(key);
    }),
    clear: vi.fn(() => {
      store.clear();
    }),
  };

  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("window", {
    localStorage: storage,
    dispatchEvent: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });

  return storage;
}

describe("useProStatus entitlement overrides", () => {
  beforeEach(() => {
    installLocalStorage();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("ignores localStorage Pro preview in production", () => {
    vi.stubEnv("PROD", true);
    vi.stubEnv("DEV", false);

    localStorage.setItem("privatetranscribe_pro_preview", "pro");

    expect(getProPreview()).toBeNull();
    expect(getEffectiveEntitlement()).toBe("free");
  });

  it("ignores PRO_ENFORCEMENT=false in production", () => {
    vi.stubEnv("PROD", true);
    vi.stubEnv("DEV", false);

    localStorage.setItem("PRO_ENFORCEMENT", "false");

    expect(getEffectiveEntitlement()).toBe("free");
  });

  it("still allows preview override in development", () => {
    vi.stubEnv("PROD", false);
    vi.stubEnv("DEV", true);

    localStorage.setItem("privatetranscribe_pro_preview", "free");
    expect(getEffectiveEntitlement()).toBe("free");

    localStorage.setItem("privatetranscribe_pro_preview", "pro");
    expect(getEffectiveEntitlement()).toBe("pro");
  });
});
