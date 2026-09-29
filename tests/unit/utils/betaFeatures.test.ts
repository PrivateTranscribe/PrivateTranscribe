import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BETA_FEATURES_KEY,
  areBetaFeaturesEnabled,
  isBetaFeature,
  isFeatureUnlocked,
} from "../../../src/utils/betaFeatures";

const BETA_IDS = ["ai-enhancement", "correction-memory", "smart-context", "action-engine"];

// Shipped features. The switch must never be what stands between a user and these.
const SHIPPED_IDS = ["converse", "read-aloud"];

function seedStorage(values: Record<string, string>) {
  const store = new Map(Object.entries(values));
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  });
}

describe("beta features switch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps every beta feature off on a new install", () => {
    seedStorage({});

    expect(areBetaFeaturesEnabled()).toBe(false);
    for (const id of BETA_IDS) expect(isFeatureUnlocked(id), id).toBe(false);
  });

  it("turns all four beta features on together", () => {
    seedStorage({ [BETA_FEATURES_KEY]: "true" });

    expect(areBetaFeaturesEnabled()).toBe(true);
    for (const id of BETA_IDS) expect(isFeatureUnlocked(id), id).toBe(true);
  });

  it.each(["false", "TRUE", "1", "yes", "on", ""])('reads "%s" as off', (value) => {
    seedStorage({ [BETA_FEATURES_KEY]: value });

    expect(areBetaFeaturesEnabled()).toBe(false);
    for (const id of BETA_IDS) expect(isFeatureUnlocked(id), id).toBe(false);
  });

  it("does not treat an old tester licence as the switch", () => {
    // What the licence client cached for an approved tester. Turning that into
    // the switch is a one-time startup job; the gate itself reads only the switch.
    seedStorage({
      privatetranscribe_license_key: "TEST-TEST-TEST-TEST",
      privatetranscribe_entitlement: JSON.stringify({ token: "t", betaAccess: true }),
      privatetranscribe_pro_status: JSON.stringify({ isPro: true, betaAccess: true }),
      privatetranscribe_pro_preview: "tester",
      PRO_ENFORCEMENT: "false",
    });

    for (const id of BETA_IDS) expect(isFeatureUnlocked(id), id).toBe(false);
  });

  it("leaves shipped features open whatever the switch says", () => {
    for (const value of [null, "false", "true"]) {
      seedStorage(value === null ? {} : { [BETA_FEATURES_KEY]: value });

      for (const id of SHIPPED_IDS) {
        expect(isFeatureUnlocked(id), `${id} with the switch at ${value}`).toBe(true);
      }
    }
  });

  it("fails closed when localStorage throws", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("SecurityError: access denied");
      },
    });

    expect(areBetaFeaturesEnabled()).toBe(false);
    for (const id of BETA_IDS) expect(isFeatureUnlocked(id), id).toBe(false);
    for (const id of SHIPPED_IDS) expect(isFeatureUnlocked(id), id).toBe(true);
  });

  it("fails closed when there is no localStorage at all", () => {
    vi.stubGlobal("localStorage", undefined);

    expect(areBetaFeaturesEnabled()).toBe(false);
    for (const id of BETA_IDS) expect(isFeatureUnlocked(id), id).toBe(false);
  });

  it("counts exactly the four unfinished features as beta", () => {
    for (const id of BETA_IDS) expect(isBetaFeature(id), id).toBe(true);
    for (const id of SHIPPED_IDS) expect(isBetaFeature(id), id).toBe(false);
  });
});
