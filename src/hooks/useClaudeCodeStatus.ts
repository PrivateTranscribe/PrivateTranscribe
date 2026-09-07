import { useCallback, useEffect, useState } from "react";

export function useClaudeCodeStatus() {
  const [status, setStatus] = useState<{ available: boolean; reason?: string } | null>(null);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    let active = true;
    const check = async () => {
      try {
        const result = await window.electronAPI?.agentModeRewriteStatus?.(revision > 0);
        if (active) setStatus(result || { available: false, reason: "unavailable" });
      } catch {
        if (active) setStatus({ available: false, reason: "unavailable" });
      }
    };
    void check();
    window.addEventListener("focus", check);
    return () => {
      active = false;
      window.removeEventListener("focus", check);
    };
  }, [revision]);
  return { status, refresh };
}
