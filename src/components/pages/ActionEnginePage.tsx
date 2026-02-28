import { Zap, Lock, Mic, Terminal, Globe, FolderOpen } from "lucide-react";
import { Badge } from "../ui/badge";

const PREVIEW_ACTIONS = [
  {
    icon: Terminal,
    name: "Open Terminal",
    trigger: '"Open terminal"',
    description: "Launch your default terminal application",
  },
  {
    icon: Globe,
    name: "Search Web",
    trigger: '"Search for..."',
    description: "Open a browser search with your spoken query",
  },
  {
    icon: FolderOpen,
    name: "Open Project",
    trigger: '"Open project [name]"',
    description: "Open a project folder in your editor",
  },
  {
    icon: Mic,
    name: "Switch Mode",
    trigger: '"Switch to code mode"',
    description: "Change dictation mode with a voice command",
  },
];

export default function ActionEnginePage() {
  return (
    <div className="p-8 max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-start gap-3 mb-2">
        <Zap size={28} className="text-primary mt-0.5 shrink-0" />
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-3xl font-semibold text-foreground tracking-tight">
              Action Engine
            </h1>
            <Badge variant="outline" className="text-[10px] gap-1">
              <Lock size={10} />
              Pro
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            Trigger commands, shortcuts, and workflows with your voice.
          </p>
        </div>
      </div>

      {/* Feature preview */}
      <div className="rounded-xl border border-border-subtle/50 bg-surface-raised/30 p-6 space-y-4">
        <div>
          <h2 className="text-base font-semibold text-foreground">Example actions</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Define custom voice commands that trigger real actions on your computer.
          </p>
        </div>

        <div className="space-y-2">
          {PREVIEW_ACTIONS.map((action) => (
            <div
              key={action.name}
              className="flex items-center gap-3 rounded-lg border border-border-subtle bg-background/40 px-3 py-2.5 opacity-60"
            >
              <div className="shrink-0 rounded-md bg-primary/10 p-2">
                <action.icon size={16} className="text-primary" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-foreground">{action.name}</span>
                  <span className="font-mono text-xs text-muted-foreground">{action.trigger}</span>
                </div>
                <p className="text-xs text-muted-foreground">{action.description}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Unlock prompt */}
      <div className="rounded-xl border border-primary/20 bg-primary/5 p-6 text-center space-y-3">
        <Lock size={24} className="mx-auto text-primary/60" />
        <h3 className="text-base font-semibold text-foreground">
          Available with Privoca Pro
        </h3>
        <p className="text-sm text-muted-foreground max-w-md mx-auto leading-relaxed">
          Create custom voice commands that launch apps, run scripts, control your editor,
          and automate repetitive workflows — all hands-free.
        </p>
      </div>
    </div>
  );
}
