import { useEffect } from "react";

export function useTheme() {
  useEffect(() => {
    // PrivateTranscribe is dark-only - always apply dark class
    document.documentElement.classList.add("dark");
    document.body.classList.add("dark");
  }, []);

  return { theme: "dark" as const, setTheme: (_: string) => {} };
}
