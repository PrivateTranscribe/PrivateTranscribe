import * as React from "react";
import { X, CheckCircle2, AlertCircle, Info } from "lucide-react";
import { cn } from "../lib/utils";
import { getToastDedupeKey, upsertToast } from "./toastState";

export interface ToastProps {
  id?: string;
  title?: string;
  description?: string;
  action?: React.ReactNode;
  variant?: "default" | "destructive" | "success";
  duration?: number;
  onClose?: () => void;
}

export interface ToastContextType {
  toast: (props: Omit<ToastProps, "id">) => void;
  dismiss: (id?: string) => void;
  toastCount: number;
}

const ToastContext = React.createContext<ToastContextType | undefined>(undefined);

// eslint-disable-next-line react-refresh/only-export-components
export const useToast = () => {
  const context = React.useContext(ToastContext);
  if (!context) {
    throw new Error("useToast must be used within a ToastProvider");
  }
  return context;
};

interface ToastState extends ToastProps {
  id: string;
  dedupeKey: string;
  isExiting?: boolean;
  createdAt: number;
}

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = React.useState<ToastState[]>([]);
  const toastsRef = React.useRef<ToastState[]>([]);
  const timersRef = React.useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const exitTimersRef = React.useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const updateToasts = React.useCallback((updater: (current: ToastState[]) => ToastState[]) => {
    const nextToasts = updater(toastsRef.current);
    toastsRef.current = nextToasts;
    setToasts(nextToasts);
  }, []);

  const clearTimer = React.useCallback((id: string) => {
    const timer = timersRef.current[id];
    if (timer) {
      clearTimeout(timer);
      delete timersRef.current[id];
    }
  }, []);

  const clearExitTimer = React.useCallback((id: string) => {
    const timer = exitTimersRef.current[id];
    if (timer) {
      clearTimeout(timer);
      delete exitTimersRef.current[id];
    }
  }, []);

  const startExitAnimation = React.useCallback(
    (id: string) => {
      clearTimer(id);
      clearExitTimer(id);
      updateToasts((current) =>
        current.map((toast) => (toast.id === id ? { ...toast, isExiting: true } : toast))
      );
      // Remove after exit animation completes. Track this separately so a repeated
      // toast can cancel the removal and revive the existing item.
      exitTimersRef.current[id] = setTimeout(() => {
        delete exitTimersRef.current[id];
        updateToasts((current) => current.filter((toast) => toast.id !== id));
      }, 200);
    },
    [clearExitTimer, clearTimer, updateToasts]
  );

  const toast = React.useCallback(
    (props: Omit<ToastProps, "id">) => {
      const incomingToast: ToastState = {
        ...props,
        id: Math.random().toString(36).substring(2, 11),
        dedupeKey: getToastDedupeKey(props),
        isExiting: false,
        createdAt: Date.now(),
      };
      const result = upsertToast(toastsRef.current, incomingToast);
      const id = result.id;

      if (result.replaced) {
        clearTimer(id);
        clearExitTimer(id);
      }
      updateToasts(() => result.toasts);

      const duration = props.duration ?? 3500;
      if (duration > 0) {
        const timer = setTimeout(() => {
          startExitAnimation(id);
        }, duration);
        timersRef.current[id] = timer;
      }

      return id;
    },
    [clearExitTimer, clearTimer, startExitAnimation, updateToasts]
  );

  const dismiss = React.useCallback(
    (id?: string) => {
      if (id) {
        clearTimer(id);
        startExitAnimation(id);
      } else {
        const lastToast = toastsRef.current[toastsRef.current.length - 1];
        if (lastToast) {
          clearTimer(lastToast.id);
          startExitAnimation(lastToast.id);
        }
      }
    },
    [clearTimer, startExitAnimation]
  );

  const pauseTimer = React.useCallback(
    (id: string) => {
      clearTimer(id);
    },
    [clearTimer]
  );

  const resumeTimer = React.useCallback(
    (id: string, remainingTime: number) => {
      if (remainingTime > 0) {
        const timer = setTimeout(() => {
          startExitAnimation(id);
        }, remainingTime);
        timersRef.current[id] = timer;
      }
    },
    [startExitAnimation]
  );

  // Cleanup on unmount
  React.useEffect(() => {
    const timers = timersRef.current;
    const exitTimers = exitTimersRef.current;
    return () => {
      for (const id in timers) {
        clearTimeout(timers[id]);
      }
      for (const id in exitTimers) {
        clearTimeout(exitTimers[id]);
      }
    };
  }, []);

  return (
    <ToastContext.Provider value={{ toast, dismiss, toastCount: toasts.length }}>
      {children}
      <ToastViewport
        toasts={toasts}
        onDismiss={dismiss}
        onPauseTimer={pauseTimer}
        onResumeTimer={resumeTimer}
      />
    </ToastContext.Provider>
  );
};

const ToastViewport: React.FC<{
  toasts: ToastState[];
  onDismiss: (id: string) => void;
  onPauseTimer: (id: string) => void;
  onResumeTimer: (id: string, remainingTime: number) => void;
}> = ({ toasts, onDismiss, onPauseTimer, onResumeTimer }) => {
  const viewportRef = React.useRef<HTMLDivElement>(null);
  // Detect if we're in the dictation panel (minimal overlay with mic button)
  const isDictationPanel = React.useMemo(() => {
    return (
      window.location.pathname.indexOf("control") === -1 &&
      window.location.search.indexOf("panel=true") === -1
    );
  }, []);

  // In the dictation overlay the window is a fixed 400×500 transparent container.
  // The button sits at bottom:58px (button top edge at 102px from window bottom).
  // Position the toast at bottom:110px so it clears the button with an 8px gap.
  // Near the right screen edge, expand to the left of center instead of the right.
  const toastOnLeft = isDictationPanel && window.screenX + 380 > window.screen.width;

  React.useLayoutEffect(() => {
    if (!isDictationPanel) {
      return;
    }

    const regions = Array.from(
      viewportRef.current?.querySelectorAll<HTMLElement>("[data-overlay-toast]") ?? []
    ).map((element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    });

    void window.electronAPI?.setMainWindowInteractiveRegions?.("overlay-toasts", regions);
  }, [isDictationPanel, toasts]);

  React.useEffect(() => {
    if (!isDictationPanel) {
      return;
    }
    return () => {
      void window.electronAPI?.setMainWindowInteractiveRegions?.("overlay-toasts", []);
    };
  }, [isDictationPanel]);

  if (toasts.length === 0) return null;

  return (
    <div
      ref={viewportRef}
      className={cn(
        "fixed z-50 flex flex-col gap-1.5 pointer-events-none",
        isDictationPanel
          ? toastOnLeft
            ? "bottom-[110px] left-6 items-start"
            : "bottom-[110px] right-6 items-end"
          : "bottom-5 right-5" // Standard position in control panel
      )}
    >
      {toasts.map((toast) => (
        <Toast
          key={toast.id}
          {...toast}
          onClose={() => onDismiss(toast.id)}
          onPauseTimer={() => onPauseTimer(toast.id)}
          onResumeTimer={(remaining) => onResumeTimer(toast.id, remaining)}
        />
      ))}
    </div>
  );
};

const variantConfig = {
  default: {
    icon: Info,
    containerClass: cn("bg-surface-2/95", "border border-border-subtle", "shadow-elevated"),
    iconClass: "text-muted-foreground",
    titleClass: "text-foreground",
    descClass: "text-muted-foreground",
    progressClass: "bg-muted-foreground/30",
  },
  destructive: {
    icon: AlertCircle,
    containerClass: cn("bg-destructive/10", "border border-destructive/20", "shadow-elevated"),
    iconClass: "text-destructive",
    titleClass: "text-destructive",
    descClass: "text-destructive/80",
    progressClass: "bg-destructive/40",
  },
  success: {
    icon: CheckCircle2,
    containerClass: cn("bg-primary/10", "border border-primary/20", "shadow-elevated"),
    iconClass: "text-primary",
    titleClass: "text-primary",
    descClass: "text-primary/80",
    progressClass: "bg-primary/40",
  },
};

const Toast: React.FC<
  ToastState & {
    onClose?: () => void;
    onPauseTimer: () => void;
    onResumeTimer: (remaining: number) => void;
  }
> = ({
  title,
  description,
  action,
  variant = "default",
  duration = 3500,
  isExiting,
  createdAt,
  onClose,
  onPauseTimer,
  onResumeTimer,
}) => {
  const config = variantConfig[variant];
  const Icon = config.icon;
  const pausedAtRef = React.useRef<number | null>(null);

  const handleMouseEnter = () => {
    pausedAtRef.current = Date.now();
    onPauseTimer();
  };

  const handleMouseLeave = () => {
    if (pausedAtRef.current && duration > 0) {
      const elapsed = pausedAtRef.current - createdAt;
      const remaining = Math.max(duration - elapsed, 500);
      onResumeTimer(remaining);
    }
    pausedAtRef.current = null;
  };

  return (
    <div
      data-overlay-toast
      className={cn(
        // Layout - fixed ideal width but responsive so it can't overflow a narrow window
        // (relevant in the dictation overlay where the window may be narrower than 320px)
        "pointer-events-auto relative flex items-start gap-2.5 w-[320px] max-w-[min(320px,calc(100vw-24px))]",
        "px-3 py-2.5 pr-8 overflow-hidden",
        // Tight radius matching buttons
        "rounded-[6px]",
        // Glass blur
        "backdrop-blur-xl",
        // Animation states
        "transition-all duration-200 ease-out",
        isExiting
          ? "opacity-0 translate-x-2 scale-[0.98]"
          : "opacity-100 translate-x-0 scale-100 animate-in slide-in-from-right-4 fade-in-0 duration-300",
        // Variant styling
        config.containerClass
      )}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {/* Status Icon */}
      <Icon className={cn("size-4 shrink-0 mt-0.5", config.iconClass)} />

      {/* Content */}
      <div className="flex-1 min-w-0">
        {title && (
          <div className={cn("text-[13px] font-medium leading-tight", config.titleClass)}>
            {title}
          </div>
        )}
        {description && (
          <div className={cn("text-[12px] leading-snug mt-0.5", config.descClass)}>
            {description}
          </div>
        )}
      </div>

      {/* Action slot */}
      {action && <div className="shrink-0 self-center">{action}</div>}

      {/* Close button */}
      {onClose && (
        <button
          onClick={onClose}
          className={cn(
            "absolute right-1.5 top-1.5 p-1 rounded-[4px]",
            "opacity-50 hover:opacity-100",
            "hover:bg-white/10",
            "transition-all duration-150",
            "focus:outline-none focus-visible:ring-1 focus-visible:ring-ring/40",
            config.iconClass
          )}
        >
          <X className="size-3.5" />
          <span className="sr-only">Close</span>
        </button>
      )}

      {/* Progress indicator - subtle bottom bar */}
      {duration > 0 && !isExiting && (
        <div className="absolute bottom-0 left-0 right-0 h-[2px] overflow-hidden">
          <div
            key={createdAt}
            className={cn("h-full", config.progressClass)}
            style={{
              animation: `toast-progress ${duration}ms linear forwards`,
            }}
          />
        </div>
      )}
    </div>
  );
};

// Helper function for common toast patterns
// eslint-disable-next-line react-refresh/only-export-components
export const toast = {
  success: (message: string) => ({
    title: "Success",
    description: message,
    variant: "success" as const,
  }),
  error: (message: string) => ({
    title: "Error",
    description: message,
    variant: "destructive" as const,
  }),
  info: (message: string) => ({
    description: message,
    variant: "default" as const,
  }),
};
