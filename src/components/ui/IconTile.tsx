import * as React from "react";

import { cn } from "../lib/utils";

const sizes = {
  sm: "h-7 w-7",
  md: "h-8 w-8",
  lg: "h-10 w-10",
} as const;

const tones = {
  primary: "bg-primary/10 text-primary",
  warning: "bg-warning/10 text-warning",
  destructive: "bg-destructive/10 text-destructive",
  success: "bg-success/10 text-success",
  muted: "bg-surface-raised text-muted-foreground",
} as const;

interface IconTileProps extends React.ComponentProps<"div"> {
  size?: keyof typeof sizes;
  tone?: keyof typeof tones;
}

/**
 * Tinted rounded square that holds a lucide icon. Used beside section headings
 * and list rows. Keeps the size, radius and tint consistent instead of each
 * call site picking its own.
 */
function IconTile({ size = "sm", tone = "primary", className, children, ...props }: IconTileProps) {
  return (
    <div
      data-slot="icon-tile"
      className={cn(
        "flex shrink-0 items-center justify-center rounded-lg",
        sizes[size],
        tones[tone],
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export { IconTile };
