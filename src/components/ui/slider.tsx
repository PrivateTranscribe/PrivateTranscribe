import * as React from "react";

import { cn } from "../lib/utils";

/**
 * The one range slider. Native control, consistent track height and accent.
 */
function Slider({ className, ...props }: Omit<React.ComponentProps<"input">, "type">) {
  return (
    <input
      type="range"
      data-slot="slider"
      className={cn(
        "h-1.5 cursor-pointer appearance-none rounded-full bg-surface-raised accent-primary",
        "disabled:cursor-not-allowed disabled:opacity-40",
        className
      )}
      {...props}
    />
  );
}

export { Slider };
