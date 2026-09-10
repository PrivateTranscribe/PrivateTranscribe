export interface DownloadProgress {
  percentage: number;
  downloadedBytes: number;
  totalBytes: number;
  speed?: number;
  eta?: number;
}

export type ModelType = "whisper" | "llm" | "parakeet" | "kokoro";

interface DownloadState {
  downloadingModel: string | null;
  downloadProgress: DownloadProgress;
  isCancelling: boolean;
  isInstalling: boolean;
  failedModel: string | null;
  lastError: string | null;
  completionVersion: number;
}

function createSession() {
  let state: DownloadState = {
    downloadingModel: null,
    downloadProgress: { percentage: 0, downloadedBytes: 0, totalBytes: 0 },
    isCancelling: false,
    isInstalling: false,
    failedModel: null,
    lastError: null,
    completionVersion: 0,
  };
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    update: (patch: Partial<DownloadState>) => {
      state = { ...state, ...patch };
      listeners.forEach((listener) => listener());
    },
    isCancellingRef: { current: false },
    cancelRequestPendingRef: { current: false },
    lastProgressUpdateRef: { current: 0 },
    lastSelectAfterDownloadRef: { current: undefined as ((id: string) => void) | undefined },
  };
}

// A renderer owns its requests across page navigation. Keep one session per
// engine, like transcriptionStore, rather than tying jobs to mounted pickers.
const sessions = new Map<ModelType, ReturnType<typeof createSession>>();
export function getModelDownloadSession(type: ModelType) {
  let session = sessions.get(type);
  if (!session) {
    session = createSession();
    sessions.set(type, session);
  }
  return session;
}
