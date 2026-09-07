import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/services/LicensingService", () => ({
  getProStatus: vi.fn(() => ({
    isPro: false,
    betaAccess: false,
    licenseKey: null,
    expiresAt: null,
    offlineGrace: false,
    error: null,
    _t: 0,
  })),
  refreshProStatus: vi.fn(),
  _verifyToken: vi.fn(() => false),
}));

import { _verifyToken, getProStatus } from "../../../src/services/LicensingService";
import {
  getEffectiveEntitlement,
  getProPreview,
  isFeatureUnlocked,
  shouldShowProBadge,
} from "../../../src/hooks/useProStatus";

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

  it("uses a direct Vite production constant so packaged builds do not fall back to dev-unlocked mode", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const source = fs.readFileSync(
      path.join(process.cwd(), "src", "hooks", "useProStatus.ts"),
      "utf8"
    );

    expect(source).toContain("return import.meta.env.PROD === true");
    expect(source).not.toContain("const meta = import.meta");
  });

  it("still allows preview override in development", () => {
    vi.stubEnv("PROD", false);
    vi.stubEnv("DEV", true);

    localStorage.setItem("privatetranscribe_pro_preview", "free");
    expect(getEffectiveEntitlement()).toBe("free");

    localStorage.setItem("privatetranscribe_pro_preview", "pro");
    expect(getEffectiveEntitlement()).toBe("pro");
  });

  it("keeps beta features locked by default in development", () => {
    vi.stubEnv("PROD", false);
    vi.stubEnv("DEV", true);

    expect(getEffectiveEntitlement()).toBe("pro");
    expect(isFeatureUnlocked("ai-enhancement")).toBe(false);
    expect(isFeatureUnlocked("action-engine")).toBe(false);

    localStorage.setItem("privatetranscribe_pro_preview", "tester");
    expect(isFeatureUnlocked("ai-enhancement")).toBe(true);
  });

  it("keeps beta workflow features locked for a regular paid Pro license", () => {
    vi.stubEnv("PROD", true);
    vi.mocked(_verifyToken).mockReturnValue(true);
    vi.mocked(getProStatus).mockReturnValue({
      isPro: true,
      betaAccess: false,
      licenseKey: "PAID-PAID-PAID-PAID",
      expiresAt: null,
      offlineGrace: false,
      error: null,
      _t: Math.floor(Date.now() / 60000) * 7 + 42,
    });

    expect(getEffectiveEntitlement()).toBe("pro");
    expect(isFeatureUnlocked("ai-enhancement")).toBe(false);
    expect(isFeatureUnlocked("correction-memory")).toBe(false);
  });

  it("unlocks beta workflow features only for an approved tester entitlement", () => {
    vi.stubEnv("PROD", true);
    vi.mocked(_verifyToken).mockReturnValue(true);
    vi.mocked(getProStatus).mockReturnValue({
      isPro: true,
      betaAccess: true,
      licenseKey: "TEST-TEST-TEST-TEST",
      expiresAt: null,
      offlineGrace: false,
      error: null,
      _t: Math.floor(Date.now() / 60000) * 7 + 42,
    });

    expect(isFeatureUnlocked("ai-enhancement")).toBe(true);
    expect(isFeatureUnlocked("action-engine")).toBe(true);
  });
});

describe("Converse is a Pro feature", () => {
  beforeEach(() => {
    installLocalStorage();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  function stubLicense({ isPro, betaAccess }: { isPro: boolean; betaAccess: boolean }) {
    vi.mocked(_verifyToken).mockReturnValue(true);
    vi.mocked(getProStatus).mockReturnValue({
      isPro,
      betaAccess,
      licenseKey: isPro ? "PAID-PAID-PAID-PAID" : null,
      expiresAt: null,
      offlineGrace: false,
      error: null,
      _t: Math.floor(Date.now() / 60000) * 7 + 42,
    });
  }

  it("unlocks for a regular paid Pro license without tester access", () => {
    vi.stubEnv("PROD", true);
    stubLicense({ isPro: true, betaAccess: false });

    expect(isFeatureUnlocked("converse")).toBe(true);
    expect(shouldShowProBadge("converse")).toBe(false);
  });

  it("does not widen the tester gate for the other beta workflows", () => {
    vi.stubEnv("PROD", true);
    stubLicense({ isPro: true, betaAccess: false });

    expect(isFeatureUnlocked("ai-enhancement")).toBe(false);
  });

  it("stays locked and badged on a free install", () => {
    vi.stubEnv("PROD", true);
    stubLicense({ isPro: false, betaAccess: false });

    expect(getEffectiveEntitlement()).toBe("free");
    expect(isFeatureUnlocked("converse")).toBe(false);
    expect(shouldShowProBadge("converse")).toBe(true);
  });

  it("leaves Read Aloud open on a free install, with no badge", () => {
    vi.stubEnv("PROD", true);
    stubLicense({ isPro: false, betaAccess: false });

    expect(isFeatureUnlocked("read-aloud")).toBe(true);
    expect(shouldShowProBadge("read-aloud")).toBe(false);
  });

  it("unlocks for an approved tester", () => {
    vi.stubEnv("PROD", true);
    stubLicense({ isPro: true, betaAccess: true });

    expect(isFeatureUnlocked("converse")).toBe(true);
    expect(shouldShowProBadge("converse")).toBe(false);
  });

  it("locks under the Starter Pro Preview override", () => {
    vi.stubEnv("PROD", false);
    vi.stubEnv("DEV", true);
    stubLicense({ isPro: true, betaAccess: true });

    localStorage.setItem("privatetranscribe_pro_preview", "free");

    expect(isFeatureUnlocked("converse")).toBe(false);
    expect(shouldShowProBadge("converse")).toBe(true);
  });
});
