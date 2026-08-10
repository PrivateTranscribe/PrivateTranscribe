/**
 * Single source of truth for dropdown styling.
 *
 * Every select-like control in the app must consume these classes, including bespoke
 * ones that Radix cannot express (e.g. the searchable LanguageSelector). Change the
 * look here, never at the call site, so all dropdowns stay visually identical.
 */

export const selectTriggerClass =
  "flex h-10 w-full items-center justify-between rounded-md border border-border-subtle bg-surface-1 px-3.5 py-2 text-sm shadow-none ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/15 focus:border-primary/50 disabled:cursor-not-allowed disabled:opacity-40 [&>span]:line-clamp-1";

export const selectContentClass =
  "relative z-50 max-h-96 min-w-[8rem] overflow-hidden rounded-lg border border-border-hover bg-popover text-popover-foreground shadow-elevated";

export const selectItemClass =
  "relative flex w-full cursor-pointer select-none items-center rounded-md py-2 pl-3 pr-8 text-sm outline-none transition-colors " +
  "hover:bg-primary/15 focus:bg-primary/15 data-highlighted:bg-primary/15 data-[state=checked]:bg-primary/15 " +
  "data-[state=checked]:text-primary data-[state=checked]:font-medium " +
  "data-disabled:pointer-events-none data-disabled:opacity-40";
