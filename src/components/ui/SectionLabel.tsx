import * as React from "react";

import { cn } from "../lib/utils";

type SectionLabelProps<T extends React.ElementType> = {
  /** Element to render. Defaults to <p>; use "span" or "label" inside inline rows. */
  as?: T;
} & Omit<React.ComponentPropsWithoutRef<T>, "as">;

/**
 * Small uppercase label above a group of settings, a stat, or a card section.
 *
 * The app previously had five slightly different versions of this (10px/11px/12px,
 * three tracking values, three opacities). This is the one. Do not hand-roll another.
 * Pass className only to adjust spacing or to recolour a semantic variant.
 */
function SectionLabel<T extends React.ElementType = "p">({
  as,
  className,
  ...props
}: SectionLabelProps<T>) {
  const Component = (as ?? "p") as React.ElementType;

  return (
    <Component
      data-slot="section-label"
      className={cn(
        "text-[11px] font-medium uppercase tracking-wider text-muted-foreground",
        className
      )}
      {...props}
    />
  );
}

export { SectionLabel };
