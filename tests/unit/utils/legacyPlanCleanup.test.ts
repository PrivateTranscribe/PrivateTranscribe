import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LEGACY_PLAN_CLEANUP_KEY,
  cleanUpLegacyPlanState,
} from "../../../src/utils/legacyPlanCleanup";
import { BETA_FEATURES_KEY } from "../../../src/utils/betaFeatures";

function memoryStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    keys: () => [...store.keys()],
  };
}

/** What an approved tester's install cached after activating their licence. */
const TESTER_STATE = {
  privatetranscribe_license_key: "ABCD-EFGH-IJKL-MNOP",
  privatetranscribe_entitlement: JSON.stringify({ token: "t", expiresAt: null, betaAccess: true }),
  privatetranscribe_pro_status: "active",
  privatetranscribe_seal: "1x2y3z",
  privatetranscribe_ts: "1790000000000",
};

/** Every key the licence client, the Pro preview and the daily caps wrote. */
const LEGACY_KEYS = [
  "privatetranscribe_license_key",
  "privatetranscribe_entitlement",
  "privatetranscribe_pro_status",
  "privatetranscribe_seal",
  "privatetranscribe_ts",
  "privatetranscribe_device_id",
  "privatetranscribe_pro_preview",
  "PRO_ENFORCEMENT",
  "privatetranscribe_starter_usage_v1",
  "privatetranscribe_agent_mode_usage_v1",
];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("cleanUpLegacyPlanState", () => {
  it("turns beta features on for an approved tester, even over a stored default", () => {
    // useLocalStorage persists its default, so "false" may never have been a choice.
    const storage = memoryStorage({ ...TESTER_STATE, [BETA_FEATURES_KEY]: "false" });

    cleanUpLegacyPlanState(storage);

    expect(storage.getItem(BETA_FEATURES_KEY)).toBe("true");
  });

  it("leaves beta features off for a paid licence without tester access", () => {
    const storage = memoryStorage({
      ...TESTER_STATE,
      privatetranscribe_entitlement: JSON.stringify({ token: "t", betaAccess: false }),
    });

    cleanUpLegacyPlanState(storage);

    expect(storage.getItem(BETA_FEATURES_KEY)).toBeNull();
  });

  it("ignores a tester flag on a licence that is not active", () => {
    const inactive: Record<string, string> = { ...TESTER_STATE, [BETA_FEATURES_KEY]: "false" };
    delete inactive.privatetranscribe_pro_status;
    const storage = memoryStorage(inactive);

    cleanUpLegacyPlanState(storage);

    expect(storage.getItem(BETA_FEATURES_KEY)).toBe("false");
  });

  it("removes every key the paid plan left and nothing else", () => {
    const storage = memoryStorage({
      ...Object.fromEntries(LEGACY_KEYS.map((key) => [key, "left behind"])),
      dictationKey: "`",
      [BETA_FEATURES_KEY]: "false",
    });

    cleanUpLegacyPlanState(storage);

    for (const key of LEGACY_KEYS) expect(storage.getItem(key), key).toBeNull();
    expect(storage.keys().sort()).toEqual(
      [BETA_FEATURES_KEY, "dictationKey", LEGACY_PLAN_CLEANUP_KEY].sort()
    );
  });

  it("runs once, so a later start keeps the user's own choice", () => {
    const storage = memoryStorage(TESTER_STATE);
    cleanUpLegacyPlanState(storage);
    expect(storage.getItem(LEGACY_PLAN_CLEANUP_KEY)).toBe("true");

    // The tester turns the switch off, then restarts the app.
    storage.setItem(BETA_FEATURES_KEY, "false");
    const setItem = vi.spyOn(storage, "setItem");
    const removeItem = vi.spyOn(storage, "removeItem");

    cleanUpLegacyPlanState(storage);

    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
    expect(storage.getItem(BETA_FEATURES_KEY)).toBe("false");
  });

  it("ends in the same state when a second window runs it before seeing the marker", () => {
    const storage = memoryStorage({ ...TESTER_STATE, privatetranscribe_device_id: "id" });
    cleanUpLegacyPlanState(storage);
    const afterFirst = Object.fromEntries(storage.keys().map((key) => [key, storage.getItem(key)]));

    // The other window read the marker before this one wrote it.
    storage.removeItem(LEGACY_PLAN_CLEANUP_KEY);
    cleanUpLegacyPlanState(storage);

    const afterSecond = Object.fromEntries(
      storage.keys().map((key) => [key, storage.getItem(key)])
    );
    expect(afterSecond).toEqual(afterFirst);
    expect(afterSecond[BETA_FEATURES_KEY]).toBe("true");
  });

  it("does not throw on a corrupt cached entitlement, and still cleans up", () => {
    const storage = memoryStorage({ ...TESTER_STATE, privatetranscribe_entitlement: "{not json" });

    expect(() => cleanUpLegacyPlanState(storage)).not.toThrow();

    expect(storage.getItem(BETA_FEATURES_KEY)).toBeNull();
    expect(storage.getItem("privatetranscribe_entitlement")).toBeNull();
    expect(storage.getItem(LEGACY_PLAN_CLEANUP_KEY)).toBe("true");
  });

  it("does not throw when storage itself fails", () => {
    const denied = () => {
      throw new Error("Access is denied for this document.");
    };

    expect(() =>
      cleanUpLegacyPlanState({ getItem: denied, setItem: denied, removeItem: denied })
    ).not.toThrow();
  });

  it("works on the window's localStorage when given no storage", () => {
    const storage = memoryStorage(TESTER_STATE);
    vi.stubGlobal("localStorage", storage);

    cleanUpLegacyPlanState();

    expect(storage.getItem(BETA_FEATURES_KEY)).toBe("true");
    expect(storage.getItem("privatetranscribe_license_key")).toBeNull();
  });
});
