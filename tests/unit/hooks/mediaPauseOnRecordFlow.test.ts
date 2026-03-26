import { describe, it, expect, vi, beforeEach } from "vitest";

interface MockElectronAPI {
  duckSystemAudio?: (options: { mode: string; duckLevel: number }) => void;
  restoreSystemAudio?: () => void;
  mediaPause?: () => void;
  mediaResume?: () => void;
}

interface MockAudioManager {
  getState: () => {
    isRecording: boolean;
    isProcessing: boolean;
    isStartingRecording: boolean;
  };
  startRecording: () => Promise<boolean>;
  stopRecording: () => boolean;
}

async function startRecordingFlow(
  manager: MockAudioManager,
  electronAPI: MockElectronAPI,
  storage: Storage
) {
  const currentState = manager.getState();
  if (currentState.isRecording || currentState.isProcessing || currentState.isStartingRecording) {
    return false;
  }

  const mode = storage.getItem("musicDuckingMode") || "off";
  if (mode !== "off") {
    const duckLevel = parseFloat(storage.getItem("musicDuckLevel") || "0.2");
    electronAPI.duckSystemAudio?.({ mode, duckLevel });
  }

  const pauseSetting = storage.getItem("pauseMediaOnRecord");
  if (pauseSetting === "true" || pauseSetting === "1" || pauseSetting === "on") {
    electronAPI.mediaPause?.();
  }

  return await manager.startRecording();
}

function stopRecordingFlow(manager: MockAudioManager, electronAPI: MockElectronAPI) {
  const currentState = manager.getState();
  if (!currentState.isRecording && !currentState.isStartingRecording) {
    electronAPI.restoreSystemAudio?.();
    electronAPI.mediaResume?.();
    return false;
  }

  const stopped = manager.stopRecording();
  electronAPI.restoreSystemAudio?.();
  electronAPI.mediaResume?.();
  return stopped;
}

function createStorage(initial: Record<string, string> = {}): Storage {
  const store = new Map(Object.entries(initial));
  return {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, value);
    },
  };
}

describe("media pause on record flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("pauses media and ducks audio before starting when enabled", async () => {
    const storage = createStorage({
      pauseMediaOnRecord: "true",
      musicDuckingMode: "duck",
      musicDuckLevel: "0.35",
    });

    const electronAPI: MockElectronAPI = {
      duckSystemAudio: vi.fn(),
      mediaPause: vi.fn(),
    };
    const manager: MockAudioManager = {
      getState: () => ({ isRecording: false, isProcessing: false, isStartingRecording: false }),
      startRecording: vi.fn().mockResolvedValue(true),
      stopRecording: vi.fn().mockReturnValue(true),
    };

    const started = await startRecordingFlow(manager, electronAPI, storage);

    expect(started).toBe(true);
    expect(electronAPI.duckSystemAudio).toHaveBeenCalledWith({ mode: "duck", duckLevel: 0.35 });
    expect(electronAPI.mediaPause).toHaveBeenCalledOnce();
    expect(manager.startRecording).toHaveBeenCalledOnce();
  });

  it("accepts legacy truthy pause settings from localStorage", async () => {
    const storage = createStorage({ pauseMediaOnRecord: "1" });

    const electronAPI: MockElectronAPI = {
      mediaPause: vi.fn(),
    };
    const manager: MockAudioManager = {
      getState: () => ({ isRecording: false, isProcessing: false, isStartingRecording: false }),
      startRecording: vi.fn().mockResolvedValue(true),
      stopRecording: vi.fn().mockReturnValue(true),
    };

    await startRecordingFlow(manager, electronAPI, storage);

    expect(electronAPI.mediaPause).toHaveBeenCalledOnce();
  });

  it("restores audio and resumes media when stopping an active recording", () => {
    const electronAPI: MockElectronAPI = {
      restoreSystemAudio: vi.fn(),
      mediaResume: vi.fn(),
    };
    const manager: MockAudioManager = {
      getState: () => ({ isRecording: true, isProcessing: false, isStartingRecording: false }),
      startRecording: vi.fn().mockResolvedValue(true),
      stopRecording: vi.fn().mockReturnValue(true),
    };

    const stopped = stopRecordingFlow(manager, electronAPI);

    expect(stopped).toBe(true);
    expect(manager.stopRecording).toHaveBeenCalledOnce();
    expect(electronAPI.restoreSystemAudio).toHaveBeenCalledOnce();
    expect(electronAPI.mediaResume).toHaveBeenCalledOnce();
  });
});
