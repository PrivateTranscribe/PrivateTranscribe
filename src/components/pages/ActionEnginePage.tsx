import { useEffect, useState } from "react";
import {
  Zap,
  Lock,
  Plus,
  Trash2,
  Pencil,
  Play,
  Terminal,
  Globe,
  FolderOpen,
  Mic,
  ToggleLeft,
  ToggleRight,
  ChevronDown,
  CheckCircle2,
  XCircle,
  History,
} from "lucide-react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  ConfirmDialog,
} from "../ui/dialog";
import { isFeatureUnlocked } from "../../hooks/useProStatus";
import { useActionEngine } from "../../hooks/useActionEngine";
import type {
  Action,
  ActionConfig,
  ActionCreatePayload,
  ActionRun,
  ActionType,
  TriggerMode,
} from "../../types/actionEngine";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const TRIGGER_MODE_LABELS: Record<TriggerMode, string> = {
  exact: "Exact match",
  prefix: "Starts with",
  contains: "Contains",
  regex: "Regex",
};

const ACTION_TYPE_LABELS: Record<ActionType, string> = {
  shell: "Shell command",
  url: "Open URL",
  app: "Open application",
  "dictation-mode": "Switch dictation mode",
};

const ACTION_TYPE_ICONS: Record<
  ActionType,
  React.ComponentType<{ size?: number; className?: string }>
> = {
  shell: Terminal,
  url: Globe,
  app: FolderOpen,
  "dictation-mode": Mic,
};

// ─────────────────────────────────────────────────────────────────────────────
// Local types
// ─────────────────────────────────────────────────────────────────────────────

interface ActionFormState {
  name: string;
  description: string;
  triggerPhrase: string;
  triggerMode: TriggerMode;
  actionType: ActionType;
  actionConfig: ActionConfig;
  enabled: boolean;
}

const EMPTY_FORM: ActionFormState = {
  name: "",
  description: "",
  triggerPhrase: "",
  triggerMode: "contains",
  actionType: "shell",
  actionConfig: { command: "" },
  enabled: true,
};

const DEFAULT_CONFIG_FOR_TYPE: Record<ActionType, ActionConfig> = {
  shell: { command: "" },
  url: { url: "" },
  app: { appPath: "" },
  "dictation-mode": { mode: "" },
};

// ─────────────────────────────────────────────────────────────────────────────
// ActionConfigFields — dynamic config inputs per action type
// ─────────────────────────────────────────────────────────────────────────────

function ActionConfigFields({
  actionType,
  actionConfig,
  onChange,
}: {
  actionType: ActionType;
  actionConfig: ActionConfig;
  onChange: (config: ActionConfig) => void;
}) {
  switch (actionType) {
    case "shell":
      return (
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Command</Label>
          <Input
            placeholder='e.g. open -a "Visual Studio Code"'
            value={actionConfig.command ?? ""}
            onChange={(e) => onChange({ ...actionConfig, command: e.target.value })}
          />
          <p className="text-[11px] text-muted-foreground">
            Executed with execFile (no shell expansion). Quote arguments containing spaces.
          </p>
        </div>
      );

    case "url":
      return (
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">URL</Label>
          <Input
            placeholder="https://example.com"
            value={actionConfig.url ?? ""}
            onChange={(e) => onChange({ ...actionConfig, url: e.target.value })}
          />
          <p className="text-[11px] text-muted-foreground">Must be an http:// or https:// URL.</p>
        </div>
      );

    case "app":
      return (
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Application path</Label>
          <Input
            placeholder="/Applications/Terminal.app"
            value={actionConfig.appPath ?? ""}
            onChange={(e) => onChange({ ...actionConfig, appPath: e.target.value })}
          />
        </div>
      );

    case "dictation-mode":
      return (
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Mode name</Label>
          <Input
            placeholder='e.g. "code" or "prose"'
            value={actionConfig.mode ?? ""}
            onChange={(e) => onChange({ ...actionConfig, mode: e.target.value })}
          />
          <p className="text-[11px] text-muted-foreground">
            Sends an internal event to switch the active dictation profile.
          </p>
        </div>
      );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ActionFormDialog — create / edit modal
// ─────────────────────────────────────────────────────────────────────────────

interface ActionFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial?: ActionFormState;
  title: string;
  submitLabel: string;
  onSubmit: (form: ActionFormState) => Promise<void>;
}

function ActionFormDialog({
  open,
  onOpenChange,
  initial = EMPTY_FORM,
  title,
  submitLabel,
  onSubmit,
}: ActionFormDialogProps) {
  const [form, setForm] = useState<ActionFormState>(initial);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const handleOpenChange = (next: boolean) => {
    if (next) {
      setForm(initial);
      setFormError(null);
    }
    onOpenChange(next);
  };

  const patch = (delta: Partial<ActionFormState>) => setForm((prev) => ({ ...prev, ...delta }));

  const handleActionTypeChange = (type: ActionType) => {
    patch({ actionType: type, actionConfig: DEFAULT_CONFIG_FOR_TYPE[type] });
  };

  const handleSubmit = async () => {
    try {
      setSaving(true);
      setFormError(null);
      await onSubmit(form);
      onOpenChange(false);
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : "An error occurred.");
    } finally {
      setSaving(false);
    }
  };

  const canSubmit = form.name.trim().length > 0 && form.triggerPhrase.trim().length > 0;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-1">
          {/* Name */}
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Name</Label>
            <Input
              placeholder="Open Terminal"
              value={form.name}
              onChange={(e) => patch({ name: e.target.value })}
            />
          </div>

          {/* Description */}
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Description (optional)</Label>
            <Input
              placeholder="Brief description of what this action does"
              value={form.description}
              onChange={(e) => patch({ description: e.target.value })}
            />
          </div>

          {/* Trigger phrase + mode */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Trigger phrase</Label>
              <Input
                placeholder="open terminal"
                value={form.triggerPhrase}
                onChange={(e) => patch({ triggerPhrase: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Match mode</Label>
              <Select
                value={form.triggerMode}
                onValueChange={(v) => patch({ triggerMode: v as TriggerMode })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(TRIGGER_MODE_LABELS) as TriggerMode[]).map((m) => (
                    <SelectItem key={m} value={m}>
                      {TRIGGER_MODE_LABELS[m]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Action type */}
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Action type</Label>
            <Select
              value={form.actionType}
              onValueChange={(v) => handleActionTypeChange(v as ActionType)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(ACTION_TYPE_LABELS) as ActionType[]).map((t) => (
                  <SelectItem key={t} value={t}>
                    {ACTION_TYPE_LABELS[t]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Dynamic config fields */}
          <ActionConfigFields
            actionType={form.actionType}
            actionConfig={form.actionConfig}
            onChange={(config) => patch({ actionConfig: config })}
          />

          {/* Enabled toggle */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => patch({ enabled: !form.enabled })}
              className="text-muted-foreground hover:text-foreground transition-colors"
              aria-label={form.enabled ? "Disable action" : "Enable action"}
            >
              {form.enabled ? (
                <ToggleRight size={22} className="text-primary" />
              ) : (
                <ToggleLeft size={22} />
              )}
            </button>
            <span className="text-sm text-muted-foreground">
              {form.enabled ? "Enabled" : "Disabled"}
            </span>
          </div>

          {formError && (
            <p className="text-sm text-red-400 rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2">
              {formError}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={saving || !canSubmit}>
            {saving ? "Saving…" : submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ActionRow — single list item
// ─────────────────────────────────────────────────────────────────────────────

interface RunResult {
  id: string;
  success: boolean;
  message: string;
}

interface ActionRowProps {
  action: Action;
  onEdit: (action: Action) => void;
  onDelete: (action: Action) => void;
  onToggle: (action: Action) => void;
  onRun: (action: Action) => void;
  runningId: string | null;
  lastResult: RunResult | null;
}

function ActionRow({
  action,
  onEdit,
  onDelete,
  onToggle,
  onRun,
  runningId,
  lastResult,
}: ActionRowProps) {
  const Icon = ACTION_TYPE_ICONS[action.actionType] ?? Zap;
  const isRunning = runningId === action.id;
  const myResult = lastResult?.id === action.id ? lastResult : null;

  return (
    <div
      className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 transition-opacity ${
        action.enabled
          ? "border-border-subtle bg-background/40"
          : "border-border-subtle/40 bg-background/20 opacity-60"
      }`}
    >
      {/* Icon */}
      <div className="shrink-0 rounded-md bg-primary/10 p-2">
        <Icon size={15} className="text-primary" />
      </div>

      {/* Info */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium text-foreground">{action.name}</span>
          <span className="font-mono text-[11px] text-muted-foreground">
            {TRIGGER_MODE_LABELS[action.triggerMode]}: &ldquo;{action.triggerPhrase}&rdquo;
          </span>
          <Badge variant="secondary" className="text-[10px]">
            {ACTION_TYPE_LABELS[action.actionType]}
          </Badge>
        </div>
        {action.description && (
          <p className="text-xs text-muted-foreground mt-0.5">{action.description}</p>
        )}
        {myResult && (
          <p
            className={`text-[11px] mt-0.5 ${myResult.success ? "text-green-400" : "text-red-400"}`}
          >
            {myResult.success ? "✓ " : "✗ "}
            {myResult.message}
          </p>
        )}
      </div>

      {/* Controls */}
      <div className="flex items-center gap-1 shrink-0">
        <button
          onClick={() => onToggle(action)}
          className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted/30 transition-colors"
          title={action.enabled ? "Disable" : "Enable"}
        >
          {action.enabled ? (
            <ToggleRight size={16} className="text-primary" />
          ) : (
            <ToggleLeft size={16} />
          )}
        </button>

        <button
          onClick={() => onRun(action)}
          disabled={isRunning || !action.enabled}
          className="p-1.5 rounded text-muted-foreground hover:text-green-400 hover:bg-green-500/10 transition-colors disabled:opacity-40"
          title="Test this action now"
        >
          <Play size={14} />
        </button>

        <button
          onClick={() => onEdit(action)}
          className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted/30 transition-colors"
          title="Edit action"
        >
          <Pencil size={14} />
        </button>

        <button
          onClick={() => onDelete(action)}
          className="p-1.5 rounded text-muted-foreground hover:text-red-400 hover:bg-red-500/10 transition-colors"
          title="Delete action"
        >
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// RunHistoryPanel
// ─────────────────────────────────────────────────────────────────────────────

/** Format an ISO timestamp as a short relative or absolute string. */
function formatRunTime(isoStr: string): string {
  const date = new Date(isoStr);
  if (Number.isNaN(date.getTime())) return isoStr;

  const diffMs = Date.now() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

const ACTION_TYPE_ICON_SMALL: Record<
  string,
  React.ComponentType<{ size?: number; className?: string }>
> = {
  shell: Terminal,
  url: Globe,
  app: FolderOpen,
  "dictation-mode": Mic,
};

interface RunHistoryPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  runs: ActionRun[];
  runsLoading: boolean;
  onClear: () => Promise<void>;
}

function RunHistoryPanel({ open, onOpenChange, runs, runsLoading, onClear }: RunHistoryPanelProps) {
  const [clearing, setClearing] = useState(false);

  const handleClear = async () => {
    setClearing(true);
    try {
      await onClear();
    } finally {
      setClearing(false);
    }
  };

  return (
    <div className="rounded-xl border border-border-subtle/50 bg-surface-raised/30 p-5 space-y-3">
      <button
        className="w-full flex items-center justify-between text-sm font-medium text-foreground"
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
      >
        <span className="flex items-center gap-2">
          <History size={14} className="text-muted-foreground" />
          Run history
        </span>
        <ChevronDown
          size={14}
          className={`text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div className="space-y-3">
          {/* Header row */}
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              {runsLoading
                ? "Loading…"
                : runs.length === 0
                  ? "No runs recorded yet."
                  : `${runs.length} recent ${runs.length === 1 ? "run" : "runs"}`}
            </p>
            {runs.length > 0 && (
              <Button
                size="sm"
                variant="ghost"
                onClick={handleClear}
                disabled={clearing}
                className="h-6 px-2 text-xs text-muted-foreground hover:text-red-400 hover:bg-red-500/10"
              >
                {clearing ? "Clearing…" : "Clear history"}
              </Button>
            )}
          </div>

          {/* Run list */}
          {runsLoading ? (
            <div className="space-y-1.5">
              {[1, 2, 3].map((i) => (
                <div key={i} className="skeleton h-10 w-full rounded-lg" />
              ))}
            </div>
          ) : runs.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-6 text-center">
              <History size={24} className="text-muted-foreground/30" />
              <p className="text-xs text-muted-foreground">
                Run an action to see its history here.
              </p>
            </div>
          ) : (
            <div className="space-y-1.5 max-h-72 overflow-y-auto">
              {runs.map((run) => {
                const Icon = ACTION_TYPE_ICON_SMALL[run.actionType] ?? Zap;
                return (
                  <div
                    key={run.id}
                    className="flex items-start gap-2.5 rounded-lg border border-border-subtle/50 bg-background/40 px-3 py-2 text-xs"
                  >
                    {/* Status icon */}
                    {run.success ? (
                      <CheckCircle2
                        size={13}
                        className="mt-0.5 shrink-0 text-green-500"
                        aria-label="Success"
                      />
                    ) : (
                      <XCircle
                        size={13}
                        className="mt-0.5 shrink-0 text-red-400"
                        aria-label="Failed"
                      />
                    )}

                    {/* Main info */}
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <div className="flex items-center gap-1.5">
                        <Icon size={11} className="shrink-0 text-muted-foreground" />
                        <span className="font-medium text-foreground truncate">
                          {run.actionName}
                        </span>
                        <span
                          className={`ml-auto shrink-0 rounded px-1 py-px font-mono text-[10px] ${
                            run.triggeredBy === "transcript"
                              ? "bg-primary/10 text-primary"
                              : "bg-muted text-muted-foreground"
                          }`}
                        >
                          {run.triggeredBy === "transcript" ? "voice" : "manual"}
                        </span>
                      </div>

                      {/* Trigger text or error */}
                      {run.triggerText && (
                        <p className="text-muted-foreground truncate">
                          &ldquo;{run.triggerText}&rdquo;
                        </p>
                      )}
                      {!run.success && run.error && (
                        <p className="text-red-400/80 truncate">{run.error}</p>
                      )}
                      {run.success && run.output && (
                        <p className="text-muted-foreground truncate font-mono">{run.output}</p>
                      )}
                    </div>

                    {/* Meta: duration + time */}
                    <div className="shrink-0 text-right text-muted-foreground space-y-0.5">
                      <p>{formatRunTime(run.triggeredAt)}</p>
                      <p className="font-mono">{run.durationMs}ms</p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ActionEnginePage
// ─────────────────────────────────────────────────────────────────────────────

export default function ActionEnginePage() {
  const isUnlocked = isFeatureUnlocked("action-engine");
  const {
    actions,
    loading,
    error,
    createAction,
    updateAction,
    deleteAction,
    toggleEnabled,
    executeAction,
    runs,
    runsLoading,
    loadRuns,
    clearRuns,
  } = useActionEngine();

  // Dialog state
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Action | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Action | null>(null);

  // Run history panel state
  const [runsOpen, setRunsOpen] = useState(false);

  // Load runs when the panel is first opened
  useEffect(() => {
    if (runsOpen) void loadRuns(50);
  }, [runsOpen, loadRuns]);

  // Run feedback
  const [runningId, setRunningId] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<RunResult | null>(null);

  const handleCreate = async (form: ActionFormState) => {
    const created = await createAction(form as ActionCreatePayload);
    if (!created) throw new Error("Failed to create action — check the form fields and try again.");
  };

  const handleUpdate = async (form: ActionFormState) => {
    if (!editTarget) return;
    const updated = await updateAction(editTarget.id, form);
    if (!updated) throw new Error("Failed to update action — check the form fields and try again.");
  };

  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return;
    await deleteAction(deleteTarget.id);
    setDeleteTarget(null);
  };

  const handleToggle = (action: Action) => {
    void toggleEnabled(action.id, !action.enabled);
  };

  const handleRun = async (action: Action) => {
    setRunningId(action.id);
    setLastResult(null);
    const result = await executeAction(action.id);
    const resultEntry: RunResult = {
      id: action.id,
      success: result.success,
      message: result.success
        ? (result.output ?? "Action executed successfully.")
        : (result.error ?? "Action failed."),
    };
    setLastResult(resultEntry);
    setRunningId(null);
    setTimeout(() => setLastResult((prev) => (prev?.id === action.id ? null : prev)), 4_000);
    // Refresh run history if the panel is open so the new run appears immediately.
    if (runsOpen) void loadRuns(50);
  };

  return (
    <div className="p-8 max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-start gap-3 mb-2">
        <Zap size={28} className="text-primary mt-0.5 shrink-0" />
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-3xl font-semibold text-foreground tracking-tight">Action Engine</h1>
            {!isUnlocked && (
              <Badge variant="outline" className="text-[10px] gap-1">
                <Lock size={10} />
                Pro
              </Badge>
            )}
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            Trigger commands, shortcuts, and workflows with your voice.
          </p>
        </div>
      </div>

      {/* ── Locked (Pro preview) ── */}
      {!isUnlocked && (
        <>
          <div className="rounded-xl border border-border-subtle/50 bg-surface-raised/30 p-6 space-y-4">
            <div>
              <h2 className="text-base font-semibold text-foreground">Example actions</h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                Define custom voice commands that trigger real actions on your computer.
              </p>
            </div>
            <div className="space-y-2">
              {[
                {
                  Icon: Terminal,
                  name: "Open Terminal",
                  trigger: '"open terminal"',
                  desc: "Launch your default terminal application",
                },
                {
                  Icon: Globe,
                  name: "Search Web",
                  trigger: '"search for…"',
                  desc: "Open a browser search with your spoken query",
                },
                {
                  Icon: FolderOpen,
                  name: "Open Project",
                  trigger: '"open project [name]"',
                  desc: "Open a project folder in your editor",
                },
                {
                  Icon: Mic,
                  name: "Switch Mode",
                  trigger: '"switch to code mode"',
                  desc: "Change dictation mode with a voice command",
                },
              ].map(({ Icon, name, trigger, desc }) => (
                <div
                  key={name}
                  className="flex items-center gap-3 rounded-lg border border-border-subtle bg-background/40 px-3 py-2.5 opacity-60"
                >
                  <div className="shrink-0 rounded-md bg-primary/10 p-2">
                    <Icon size={16} className="text-primary" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-foreground">{name}</span>
                      <span className="font-mono text-xs text-muted-foreground">{trigger}</span>
                    </div>
                    <p className="text-xs text-muted-foreground">{desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-xl border border-primary/20 bg-primary/5 p-6 text-center space-y-3">
            <Lock size={24} className="mx-auto text-primary/60" />
            <h3 className="text-base font-semibold text-foreground">Available with Privoca Pro</h3>
            <p className="text-sm text-muted-foreground max-w-md mx-auto leading-relaxed">
              Create custom voice commands that launch apps, run scripts, control your editor, and
              automate repetitive workflows — all hands-free.
            </p>
          </div>
        </>
      )}

      {/* ── Unlocked ── */}
      {isUnlocked && (
        <>
          {error && (
            <div className="rounded-xl border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-400">
              {error}
            </div>
          )}

          {/* Action list */}
          <div className="rounded-xl border border-border-subtle/50 bg-surface-raised/30 p-6 space-y-4">
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div>
                <h2 className="text-base font-semibold text-foreground">Your actions</h2>
                <p className="text-xs text-muted-foreground">
                  {loading
                    ? "Loading…"
                    : `${actions.length} ${actions.length === 1 ? "action" : "actions"} defined`}
                </p>
              </div>
              <Button size="sm" onClick={() => setCreateOpen(true)} className="gap-1.5">
                <Plus size={14} />
                Add action
              </Button>
            </div>

            {loading ? (
              <div className="space-y-2">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="skeleton h-14 w-full rounded-lg" />
                ))}
              </div>
            ) : actions.length === 0 ? (
              <div className="flex flex-col items-center gap-3 py-10 text-center">
                <Zap size={32} className="text-muted-foreground/30" />
                <p className="text-sm text-muted-foreground">No actions yet.</p>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setCreateOpen(true)}
                  className="gap-1.5"
                >
                  <Plus size={14} />
                  Create your first action
                </Button>
              </div>
            ) : (
              <div className="space-y-2">
                {actions.map((action) => (
                  <ActionRow
                    key={action.id}
                    action={action}
                    onEdit={setEditTarget}
                    onDelete={setDeleteTarget}
                    onToggle={handleToggle}
                    onRun={handleRun}
                    runningId={runningId}
                    lastResult={lastResult}
                  />
                ))}
              </div>
            )}
          </div>

          {/* How it works */}
          <div className="rounded-xl border border-border-subtle/50 bg-surface-raised/30 p-5 space-y-3">
            <button
              className="w-full flex items-center justify-between text-sm font-medium text-foreground"
              onClick={(e) => {
                const next = e.currentTarget.nextElementSibling as HTMLElement | null;
                next?.classList.toggle("hidden");
              }}
            >
              <span>How triggers work</span>
              <ChevronDown size={14} className="text-muted-foreground" />
            </button>
            <div className="hidden space-y-2 text-xs text-muted-foreground leading-relaxed">
              <p>
                <strong className="text-foreground">Contains</strong> — matches if the transcribed
                text includes the trigger phrase anywhere (case-insensitive). Best for natural
                commands.
              </p>
              <p>
                <strong className="text-foreground">Exact</strong> — the entire transcript must
                equal the trigger phrase. Useful to avoid accidental triggers.
              </p>
              <p>
                <strong className="text-foreground">Starts with</strong> — matches if the transcript
                begins with the trigger phrase. Suitable for command prefixes.
              </p>
              <p>
                <strong className="text-foreground">Regex</strong> — full JavaScript regular
                expression (case-insensitive). For advanced use cases.
              </p>
              <p className="pt-1 border-t border-border-subtle">
                Use the <Play size={11} className="inline" /> button to manually test any action at
                any time.
              </p>
            </div>
          </div>

          {/* Run History */}
          <RunHistoryPanel
            open={runsOpen}
            onOpenChange={setRunsOpen}
            runs={runs}
            runsLoading={runsLoading}
            onClear={async () => {
              await clearRuns();
            }}
          />
        </>
      )}

      {/* Create dialog */}
      <ActionFormDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        title="New action"
        submitLabel="Create action"
        onSubmit={handleCreate}
      />

      {/* Edit dialog */}
      <ActionFormDialog
        open={editTarget !== null}
        onOpenChange={(open) => {
          if (!open) setEditTarget(null);
        }}
        initial={
          editTarget
            ? {
                name: editTarget.name,
                description: editTarget.description,
                triggerPhrase: editTarget.triggerPhrase,
                triggerMode: editTarget.triggerMode,
                actionType: editTarget.actionType,
                actionConfig: editTarget.actionConfig,
                enabled: editTarget.enabled,
              }
            : EMPTY_FORM
        }
        title="Edit action"
        submitLabel="Save changes"
        onSubmit={handleUpdate}
      />

      {/* Delete confirmation */}
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title="Delete action"
        description={`"${deleteTarget?.name}" will be permanently removed.`}
        confirmText="Delete"
        variant="destructive"
        onConfirm={handleDeleteConfirm}
      />
    </div>
  );
}
