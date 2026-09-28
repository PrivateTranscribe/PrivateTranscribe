import { cn } from "../lib/utils";

/**
 * The way out of a locked beta feature: it opens the Beta features tab in
 * Settings, where the one switch for every beta feature lives.
 */
export function BetaAccessLink({ className }: { className?: string }) {
  return (
    <button
      type="button"
      onClick={() =>
        void window.electronAPI?.openControlPanel?.({ page: "settings", settingsTab: "beta" })
      }
      className={cn(
        "inline-flex items-center text-primary underline-offset-2 transition-colors hover:underline",
        className
      )}
    >
      Turn on beta features
    </button>
  );
}
