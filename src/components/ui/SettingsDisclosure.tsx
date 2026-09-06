import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";

export function SettingsDisclosure({
  title,
  description,
  status,
  settingsLabel,
  children,
}: {
  title: string;
  description?: string;
  status?: ReactNode;
  settingsLabel?: string;
  children: ReactNode;
}) {
  return (
    <details className="group/disclosure rounded-xl border border-border-subtle/50">
      <summary
        data-settings-label={settingsLabel}
        className="flex cursor-pointer list-none items-center gap-3 rounded-xl px-5 py-4 hover:bg-surface-raised/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary [&::-webkit-details-marker]:hidden"
      >
        <ChevronRight
          size={16}
          aria-hidden
          className="shrink-0 text-muted-foreground group-open/disclosure:rotate-90"
        />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-foreground">{title}</span>
          {description && (
            <span className="mt-1 block text-xs text-muted-foreground">{description}</span>
          )}
        </span>
        {status && <span className="shrink-0 text-xs text-muted-foreground">{status}</span>}
      </summary>
      <div className="space-y-6 border-t border-border-subtle/30 p-5">{children}</div>
    </details>
  );
}
