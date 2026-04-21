import React from "react";
import { Check, LucideIcon } from "lucide-react";

interface Step {
  title: string;
  icon: LucideIcon;
}

interface StepProgressProps {
  steps: Step[];
  currentStep: number;
  className?: string;
}

export default function StepProgress({ steps, currentStep, className = "" }: StepProgressProps) {
  return (
    <div className={`flex items-center justify-center gap-1 ${className}`}>
      {steps.map((step, index) => {
        const Icon = step.icon;
        const isActive = index === currentStep;
        const isCompleted = index < currentStep;

        return (
          <React.Fragment key={index}>
            <div
              className={`flex items-center gap-1.5 px-2 py-1 rounded-full transition-all duration-200 ${
                isActive
                  ? "bg-primary/15 text-primary"
                  : isCompleted
                    ? "text-primary"
                    : "text-muted-foreground/50"
              }`}
            >
              <div
                className={`w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 transition-all duration-200 ${
                  isActive
                    ? "border-2 border-primary bg-background text-primary shadow-[0_0_8px_rgba(112,255,186,0.3)]"
                    : isCompleted
                      ? "bg-primary/20 text-primary"
                      : "bg-white/5 text-muted-foreground/50"
                }`}
              >
                {isCompleted ? (
                  <Check className="w-3 h-3" strokeWidth={2.5} />
                ) : (
                  <Icon className="w-3 h-3" />
                )}
              </div>
              <span
                className={`text-[11px] font-medium hidden sm:block ${
                  isActive
                    ? "text-primary"
                    : isCompleted
                      ? "text-primary"
                      : "text-muted-foreground/50"
                }`}
              >
                {step.title}
              </span>
            </div>
            {index < steps.length - 1 && (
              <div
                className={`w-4 h-px transition-colors duration-200 ${
                  isCompleted ? "bg-primary/50" : "bg-white/10"
                }`}
              />
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}
