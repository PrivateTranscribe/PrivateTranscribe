import { describe, expect, it } from "vitest";
import {
  PARAKEET_ENGINE_V2_KEY,
  markEngineChosen,
  migrateRetiredParakeetSetting,
} from "../../../src/utils/parakeetEngineMigration";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => (data.has(key) ? data.get(key)! : null),
    setItem: (key: string, value: string) => void data.set(key, value),
    data,
  };
}

describe("migrateRetiredParakeetSetting", () => {
  it("turns a stored retired-engine choice into Whisper once", () => {
    const storage = memoryStorage({ localTranscriptionProvider: "nvidia" });
    expect(migrateRetiredParakeetSetting(storage)).toBe(true);
    expect(storage.data.get("localTranscriptionProvider")).toBe("whisper");
    expect(storage.data.get(PARAKEET_ENGINE_V2_KEY)).toBe("1");
  });

  it("leaves a Parakeet choice made in this version alone", () => {
    const storage = memoryStorage({
      localTranscriptionProvider: "nvidia",
      [PARAKEET_ENGINE_V2_KEY]: "1",
    });
    expect(migrateRetiredParakeetSetting(storage)).toBe(false);
    expect(storage.data.get("localTranscriptionProvider")).toBe("nvidia");
  });

  it("runs only on the first load, so a later Parakeet pick survives a restart", () => {
    const storage = memoryStorage({ localTranscriptionProvider: "whisper" });
    expect(migrateRetiredParakeetSetting(storage)).toBe(false);
    storage.setItem("localTranscriptionProvider", "nvidia");
    expect(migrateRetiredParakeetSetting(storage)).toBe(false);
    expect(storage.data.get("localTranscriptionProvider")).toBe("nvidia");
  });

  it("does nothing on a fresh install beyond marking it", () => {
    const storage = memoryStorage();
    expect(migrateRetiredParakeetSetting(storage)).toBe(false);
    expect(storage.data.has("localTranscriptionProvider")).toBe(false);
    expect(storage.data.get(PARAKEET_ENGINE_V2_KEY)).toBe("1");
  });

  it("survives storage that throws or is missing", () => {
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(migrateRetiredParakeetSetting(broken)).toBe(false);
    expect(migrateRetiredParakeetSetting(null)).toBe(false);
    expect(() => markEngineChosen(broken)).not.toThrow();
  });

  it("marks an engine picked through the current UI", () => {
    const storage = memoryStorage({ localTranscriptionProvider: "nvidia" });
    markEngineChosen(storage);
    expect(migrateRetiredParakeetSetting(storage)).toBe(false);
    expect(storage.data.get("localTranscriptionProvider")).toBe("nvidia");
  });
});
