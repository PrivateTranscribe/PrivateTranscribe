import * as React from "react";

import { cn } from "../lib/utils";

/**
 * The one checkbox. Built on the native control so it stays accessible and
 * keyboard-operable for free — the component exists to keep the size, radius
 * and accent colour identical everywhere.
 */
function Checkbox({ className, ...props }: Omit<React.ComponentProps<"input">, "type">) {
  return (
    <input
      type="checkbox"
      data-slot="checkbox"
      className={cn(
        "h-4 w-4 shrink-0 cursor-pointer accent-primary",
        "disabled:cursor-not-allowed disabled:opacity-40",
        className
      )}
      {...props}
    />
  );
}

interface CheckboxFieldProps extends Omit<React.ComponentProps<"input">, "type"> {
  label: React.ReactNode;
  description?: React.ReactNode;
}

/**
 * Checkbox with a bold label and optional description underneath — the shape
 * used by settings toggles that need an explanation.
 */
function CheckboxField({ id, label, description, className, ...props }: CheckboxFieldProps) {
  const generatedId = React.useId();
  const inputId = id ?? generatedId;

  return (
    <div className={cn("flex items-start gap-3", className)}>
      <Checkbox id={inputId} className="mt-0.5" {...props} />
      <label htmlFor={inputId} className="cursor-pointer select-none">
        <span className="text-sm font-medium text-foreground">{label}</span>
        {description ? <p className="mt-0.5 text-xs text-muted-foreground">{description}</p> : null}
      </label>
    </div>
  );
}

export { Checkbox, CheckboxField };
