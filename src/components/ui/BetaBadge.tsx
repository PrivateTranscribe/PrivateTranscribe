import { Lock } from "lucide-react";
import { Badge } from "./badge";
import { cn } from "../lib/utils";

/**
 * The pill used wherever an unfinished, tester-only workflow appears.
 *
 * One component and one word on purpose. The app previously said "Beta" in the
 * sidebar, "Tester" on page headers, and "Beta - approved tester access is
 * required" inside settings descriptions, for a state the user experiences as
 * a single thing. The word says what the feature is; the lock icon says
 * whether this particular user can turn it on.
 *
 * Without it, a disabled control with its reason buried in small description
 * text reads as broken rather than locked, and a control that looks broken is
 * a support email.
 */
export function BetaBadge({ locked = false, className }: { locked?: boolean; className?: string }) {
  return (
    <Badge
      variant={locked ? "pro" : "outline"}
      className={cn(
        "gap-1 rounded px-1.5 py-px text-[9px] font-semibold tracking-[0.02em]",
        className
      )}
    >
      {locked && <Lock size={9} aria-hidden />}
      Beta
    </Badge>
  );
}
