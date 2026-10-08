/**
 * "nvidia" stored before the Parakeet engine came back belongs to the retired
 * sherpa-onnx WebSocket engine. On the first load of this version it becomes
 * Whisper, once; the marker then tells a new Parakeet choice from an old one.
 */

export const PARAKEET_ENGINE_V2_KEY = "parakeetEngineV2";
const PROVIDER_KEY = "localTranscriptionProvider";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * Must run before anything records: audioManager reads localStorage directly,
 * and useLocalStorage only writes a key that is missing. Returns true when it
 * rewrote a retired value.
 */
export function migrateRetiredParakeetSetting(
  storage: StorageLike | null = defaultStorage()
): boolean {
  if (!storage) return false;
  try {
    if (storage.getItem(PARAKEET_ENGINE_V2_KEY) !== null) return false;
    const retired = storage.getItem(PROVIDER_KEY) === "nvidia";
    if (retired) storage.setItem(PROVIDER_KEY, "whisper");
    storage.setItem(PARAKEET_ENGINE_V2_KEY, "1");
    return retired;
  } catch {
    return false;
  }
}

/** Called whenever the user or setup picks an engine through the current UI. */
export function markEngineChosen(storage: StorageLike | null = defaultStorage()): void {
  try {
    storage?.setItem(PARAKEET_ENGINE_V2_KEY, "1");
  } catch {
    // Storage unavailable: the migration has nothing to protect either.
  }
}
