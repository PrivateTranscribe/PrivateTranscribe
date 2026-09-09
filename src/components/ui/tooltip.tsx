import React, { useEffect, useId, useRef, useState } from "react";
import { cn } from "../lib/utils";

interface TooltipProps {
  children: React.ReactNode;
  content: string;
  className?: string;
  interactive?: boolean;
}

export const Tooltip = ({ children, content, className, interactive = false }: TooltipProps) => {
  const [isVisible, setIsVisible] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    if (!interactive || !isVisible) return;
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setIsVisible(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [interactive, isVisible]);

  const trigger =
    interactive && React.isValidElement<React.HTMLAttributes<HTMLElement>>(children)
      ? React.cloneElement(children, { "aria-describedby": isVisible ? id : undefined })
      : children;

  return (
    <div
      ref={root}
      className={cn("relative inline-block", className)}
      onMouseEnter={() => setIsVisible(true)}
      onMouseLeave={() => setIsVisible(false)}
      onFocus={interactive ? () => setIsVisible(true) : undefined}
      onBlur={interactive ? () => setIsVisible(false) : undefined}
      onClick={interactive ? () => setIsVisible(true) : undefined}
      onKeyDown={
        interactive
          ? (event) => {
              if (event.key === "Escape") {
                setIsVisible(false);
                event.stopPropagation();
              }
            }
          : undefined
      }
    >
      {trigger}
      {isVisible && (
        <div
          id={id}
          role="tooltip"
          className="absolute bottom-full left-1/2 transform -translate-x-1/2 pb-2 z-10"
        >
          <div className="relative px-2 py-1 text-xs text-popover-foreground bg-popover border border-border rounded-md whitespace-nowrap shadow-lg">
            {content}
            <div className="absolute top-full left-1/2 transform -translate-x-1/2 w-0 h-0 border-l-2 border-r-2 border-t-2 border-transparent border-t-popover"></div>
          </div>
        </div>
      )}
    </div>
  );
};
