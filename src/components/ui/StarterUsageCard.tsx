import { useCallback, useEffect, useState } from "react";
import { CalendarClock } from "lucide-react";
import { readStarterUsage, STARTER_USAGE_KEY } from "../../utils/starterUsage";
import { getEffectiveEntitlement } from "../../hooks/useProStatus";

// Custom event dispatched by the Pro Preview toggle (see useProStatus.ts)
const PRO_PREVIEW_EVENT = "privatetranscribe-pro-preview-changed";

interface StarterUsageCardProps {
  /**
   * Bump this to force a re-read (e.g. the transcription store version).
   * Dictation happens in the overlay window, so the card also listens for
   * cross-window `storage` events and refreshes periodically for the
   * midnight rollover.
   */
  refreshToken?: number;
}

export default function StarterUsageCard({ refreshToken }: StarterUsageCardProps) {
  const [usage, setUsage] = useState(() => readStarterUsage());
  const [isPro, setIsPro] = useState(() => getEffectiveEntitlement() === "pro");

  const refresh = useCallback(() => {
    setUsage(readStarterUsage());
    setIsPro(getEffectiveEntitlement() === "pro");
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh, refreshToken]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      // key === null means storage was cleared
      if (event.key === null || event.key === STARTER_USAGE_KEY) {
        refresh();
      }
    };
    // Re-read every minute so the counter resets when the local day rolls over.
    const rolloverTimer = window.setInterval(refresh, 60_000);
    window.addEventListener("storage", onStorage);
    window.addEventListener("focus", refresh);
    window.addEventListener(PRO_PREVIEW_EVENT, refresh);
    return () => {
      window.clearInterval(rolloverTimer);
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("focus", refresh);
      window.removeEventListener(PRO_PREVIEW_EVENT, refresh);
    };
  }, [refresh]);

  if (isPro) {
    return null;
  }

  const wordsUsed = Math.min(usage.wordsUsed, usage.limit);
  const percentUsed = Math.min(100, (usage.wordsUsed / usage.limit) * 100);
  const limitReached = usage.wordsUsed >= usage.limit;
  const nearLimit = !limitReached && percentUsed >= 90;

  const barColor = limitReached || nearLimit ? "bg-amber-400" : "bg-primary";

  return (
    <div className="rounded-2xl border border-border-subtle bg-surface-1 px-8 py-5">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        {/* Label */}
        <div className="flex items-center gap-2.5">
          <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <CalendarClock size={14} />
          </div>
          <div className="flex flex-col">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
              Starter plan
            </span>
            <span className="text-sm font-semibold text-foreground tabular-nums whitespace-nowrap">
              {wordsUsed.toLocaleString("en-US")} of {usage.limit.toLocaleString("en-US")} words
              today
            </span>
          </div>
        </div>

        {/* Bar */}
        <div className="flex-1 min-w-[160px]">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-raised border border-border-subtle">
            <div
              className={`h-full rounded-full ${barColor} transition-all duration-300`}
              style={{ width: `${percentUsed}%` }}
            />
          </div>
        </div>

        {/* Status note */}
        <span
          className={`text-xs whitespace-nowrap ${
            limitReached ? "text-amber-400 font-medium" : "text-muted-foreground"
          }`}
        >
          {limitReached
            ? "Daily limit reached · resets at midnight"
            : `${Math.max(0, usage.limit - usage.wordsUsed).toLocaleString("en-US")} words left · resets at midnight`}
        </span>
      </div>
    </div>
  );
}
