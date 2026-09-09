import { useLocalStorage } from "./useLocalStorage";

export function useEnhancementPreferences() {
  const [writingStyle, setWritingStyle] = useLocalStorage<"clean" | "coding">(
    "enhancementWritingStyle",
    "clean",
    {
      serialize: String,
      deserialize: (value) => (value === "coding" ? "coding" : "clean"),
    }
  );
  // Keep saved shortcuts on their existing Claude Code connection until the
  // user explicitly chooses to share ordinary dictation's connection.
  const [useSharedConnection, setUseSharedConnection] = useLocalStorage(
    "codingPromptUseSharedConnection",
    false,
    {
      serialize: String,
      deserialize: (value) => value === "true",
    }
  );
  return { writingStyle, setWritingStyle, useSharedConnection, setUseSharedConnection };
}
