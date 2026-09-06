import { ArrowUpRight } from "lucide-react";
import { BETA_ACCESS_URL, openExternalLink } from "../../utils/externalLinks";
import { cn } from "../lib/utils";

/**
 * The way out of a locked beta feature.
 *
 * A control that is locked with no path forward is worse than one that is
 * hidden: it tells the user what they are missing and then leaves them
 * nowhere to go. Every locked surface gets the same exit.
 */
export function BetaAccessLink({ className }: { className?: string }) {
  return (
    <button
      type="button"
      onClick={() => openExternalLink(BETA_ACCESS_URL)}
      className={cn(
        "inline-flex items-center gap-0.5 text-primary underline-offset-2 transition-colors hover:underline",
        className
      )}
    >
      Apply for beta access
      <ArrowUpRight className="h-3 w-3" aria-hidden />
    </button>
  );
}
