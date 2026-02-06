import { Zap } from "lucide-react";
import { Badge } from "../ui/badge";

export default function ActionEnginePage() {
  return (
    <div className="p-8 max-w-5xl mx-auto">
      {/* Page header */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-2">
          <Zap size={28} className="text-primary" />
          <h1 className="text-3xl font-semibold text-foreground tracking-tight">Action Engine</h1>
          <Badge variant="outline" className="text-[10px]">
            Coming Soon
          </Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          Execute commands and automate workflows with voice
        </p>
      </div>

      {/* Skeleton content */}
      <div className="space-y-6 relative">
        {/* Skeleton card 1 - Command list */}
        <div className="rounded-xl border border-border-subtle/50 bg-surface-raised/30 p-6 space-y-4">
          <div className="flex items-center justify-between mb-4">
            <div className="skeleton h-6 w-40" />
            <div className="skeleton h-9 w-28" />
          </div>
          <div className="space-y-3">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="flex items-center gap-4 p-3 rounded-lg bg-surface-1/50">
                <div className="skeleton h-8 w-8 rounded-md" />
                <div className="flex-1 space-y-2">
                  <div className="skeleton h-4 w-48" />
                  <div className="skeleton h-3 w-64" />
                </div>
                <div className="skeleton h-6 w-16" />
              </div>
            ))}
          </div>
        </div>

        {/* Skeleton card 2 - Trigger configuration */}
        <div className="rounded-xl border border-border-subtle/50 bg-surface-raised/30 p-6 space-y-4">
          <div className="skeleton h-6 w-56" />
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-3">
              <div className="skeleton h-4 w-24" />
              <div className="skeleton h-10 w-full" />
            </div>
            <div className="space-y-3">
              <div className="skeleton h-4 w-28" />
              <div className="skeleton h-10 w-full" />
            </div>
          </div>
          <div className="space-y-3">
            <div className="skeleton h-4 w-32" />
            <div className="skeleton h-20 w-full" />
          </div>
        </div>

        {/* Skeleton card 3 - Action cards */}
        <div className="grid grid-cols-2 gap-4">
          <div className="rounded-xl border border-border-subtle/50 bg-surface-raised/30 p-5 space-y-3">
            <div className="flex items-center gap-2">
              <div className="skeleton h-10 w-10 rounded-lg" />
              <div className="skeleton h-5 w-32" />
            </div>
            <div className="space-y-2">
              <div className="skeleton h-3 w-full" />
              <div className="skeleton h-3 w-4/5" />
            </div>
            <div className="skeleton h-8 w-full" />
          </div>
          <div className="rounded-xl border border-border-subtle/50 bg-surface-raised/30 p-5 space-y-3">
            <div className="flex items-center gap-2">
              <div className="skeleton h-10 w-10 rounded-lg" />
              <div className="skeleton h-5 w-40" />
            </div>
            <div className="space-y-2">
              <div className="skeleton h-3 w-full" />
              <div className="skeleton h-3 w-3/5" />
            </div>
            <div className="skeleton h-8 w-full" />
          </div>
        </div>

        {/* Skeleton card 4 - Toggle switches */}
        <div className="rounded-xl border border-border-subtle/50 bg-surface-raised/30 p-6 space-y-4">
          <div className="skeleton h-6 w-44" />
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="flex items-center justify-between">
                <div className="space-y-1.5">
                  <div className="skeleton h-4 w-36" />
                  <div className="skeleton h-3 w-56" />
                </div>
                <div className="skeleton h-6 w-11 rounded-full" />
              </div>
            ))}
          </div>
        </div>

        {/* Coming Soon overlay */}
        <div className="absolute inset-0 bg-background/70 backdrop-blur-[2px] rounded-2xl flex items-center justify-center">
          <div className="text-center max-w-lg px-6">
            <Badge className="mb-4 px-5 py-2 text-base shadow-lg">Coming Soon</Badge>
            <h3 className="text-lg font-semibold text-foreground mb-3">
              Voice-Triggered Automation
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              This feature will allow you to trigger custom actions, shortcuts, and workflows using
              voice commands. Create powerful automation rules that respond to your spoken
              instructions.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
