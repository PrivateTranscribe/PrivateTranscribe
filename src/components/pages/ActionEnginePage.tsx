import { useCallback, useEffect, useRef, useState } from "react";
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
  CheckCircle2,
  XCircle,
  History,
  Search,
  ChevronDown,
  ChevronUp,
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
// AppActionFields — config UI for the "Open application" action type
// ─────────────────────────────────────────────────────────────────────────────

interface InstalledApp {
  name: string;
  path: string;
}

function AppActionFields({
  actionConfig,
  onChange,
}: {
  actionConfig: ActionConfig;
  onChange: (config: ActionConfig) => void;
}) {
  const platform = window.electronAPI?.getPlatform?.() ?? "linux";
  const placeholder =
    platform === "darwin"
      ? "/Applications/Terminal.app"
      : platform === "win32"
        ? "C:\\Program Files\\app\\app.exe"
        : "/usr/bin/code";
  const helpText =
    platform === "darwin"
      ? "Path to a .app bundle. Choose from installed apps below, browse, or type directly."
      : platform === "win32"
        ? "Path to an .exe or .lnk file. Choose from installed apps below, browse, or type directly."
        : "Full path to the executable. Choose from installed apps below, browse, or type directly.";

  const [apps, setApps] = useState<InstalledApp[]>([]);
  const [loadingApps, setLoadingApps] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState("");
  const loadedRef = useRef(false);

  const loadApps = useCallback(async () => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    setLoadingApps(true);
    try {
      const res = await window.electronAPI?.actionEngineListApps?.();
      if (res?.success && res.apps) {
        setApps(res.apps);
      }
    } finally {
      setLoadingApps(false);
    }
  }, []);

  const togglePicker = () => {
    const next = !pickerOpen;
    setPickerOpen(next);
    if (next) loadApps();
  };

  const handleBrowse = async () => {
    const filters =
      platform === "win32"
        ? [
            { name: "Applications", extensions: ["exe", "lnk", "bat"] },
            { name: "All Files", extensions: ["*"] },
          ]
        : platform === "darwin"
          ? [
              { name: "Applications", extensions: ["app"] },
              { name: "All Files", extensions: ["*"] },
            ]
          : [{ name: "All Files", extensions: ["*"] }];
    const result = await window.electronAPI?.showOpenDialog?.({
      title: "Select application",
      properties: ["openFile"],
      filters,
    });
    if (result && !result.canceled && result.filePaths[0]) {
      onChange({ ...actionConfig, appPath: result.filePaths[0] });
    }
  };

  const queryLower = query.trim().toLowerCase();
  const filtered =
    queryLower.length === 0
      ? apps
      : apps.filter((a) => a.name.toLowerCase().includes(queryLower));

  return (
    <div className="space-y-2">
      <Label className="text-xs text-muted-foreground">Application path</Label>
      <div className="flex gap-2">
        <Input
          placeholder={placeholder}
          value={actionConfig.appPath ?? ""}
          onChange={(e) => onChange({ ...actionConfig, appPath: e.target.value })}
          className="flex-1"
        />
        <Button type="button" variant="outline" size="sm" onClick={handleBrowse}>
          Browse…
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground">{helpText}</p>

      {/* Installed app picker */}
      <div className="rounded-md border border-border">
        <button
          type="button"
          onClick={togglePicker}
          className="flex w-full items-center justify-between px-3 py-2 text-xs font-medium text-foreground hover:bg-muted/50 rounded-md"
        >
          <span className="flex items-center gap-1.5">
            <FolderOpen size={13} />
            {loadingApps ? "Scanning installed apps…" : "Choose from installed apps"}
            {apps.length > 0 && !loadingApps && (
              <span className="text-muted-foreground font-normal">({apps.length} found)</span>
            )}
          </span>
          {pickerOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        </button>

        {pickerOpen && (
          <div className="border-t border-border px-2 pb-2 pt-1.5">
            {/* Search input */}
            <div className="relative mb-1.5">
              <Search
                size={12}
                className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
              />
              <Input
                className="h-7 pl-7 text-xs"
                placeholder="Filter apps…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                autoFocus
              />
            </div>

            {/* App list */}
            <div className="max-h-52 overflow-y-auto rounded-sm">
              {loadingApps ? (
                <p className="py-4 text-center text-xs text-muted-foreground">
                  Scanning…
                </p>
              ) : filtered.length === 0 ? (
                <p className="py-4 text-center text-xs text-muted-foreground">
                  {apps.length === 0 ? "No installed apps found." : "No apps match your search."}
                </p>
              ) : (
                filtered.map((app) => {
                  const selected = actionConfig.appPath === app.path;
                  return (
                    <button
                      key={app.path}
                      type="button"
                      onClick={() => {
                        onChange({ ...actionConfig, appPath: app.path });
                        setPickerOpen(false);
                        setQuery("");
                      }}
                      className={`flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-xs hover:bg-muted/60 ${
                        selected ? "bg-muted font-medium" : ""
                      }`}
                    >
                      <span className="truncate">{app.name}</span>
                      {selected && <CheckCircle2 size={11} className="ml-1 shrink-0 text-primary" />}
                    </button>
                  );
                })
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

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
          <p className="text-[11px] text-muted-foreground">
            http:// or https:// URL. If you omit the protocol, https:// is added automatically.
          </p>
        </div>
      );

    case "app":
      return <AppActionFields actionConfig={actionConfig} onChange={onChange} />;

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

const RETENTION_OPTIONS: { value: number; label: string }[] = [
  { value: 50, label: "Keep 50" },
  { value: 100, label: "Keep 100" },
  { value: 200, label: "Keep 200" },
  { value: 500, label: "Keep 500" },
  { value: 0, label: "Keep all" },
];

interface RunHistoryPanelProps {
  runs: ActionRun[];
  runsLoading: boolean;
  onClear: () => Promise<void>;
  retentionLimit: number;
  onRetentionChange: (limit: number) => void;
}

function RunHistoryPanel({
  runs,
  runsLoading,
  onClear,
  retentionLimit,
  onRetentionChange,
}: RunHistoryPanelProps) {
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
      {/* Header */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="flex items-center gap-2 text-sm font-medium text-foreground">
          <History size={14} className="text-muted-foreground" />
          Run history
        </p>
        <div className="flex items-center gap-2">
          <Select
            value={String(retentionLimit)}
            onValueChange={(v) => onRetentionChange(Number(v))}
          >
            <SelectTrigger className="h-6 w-[90px] text-xs px-2 py-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {RETENTION_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={String(opt.value)} className="text-xs">
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-xs text-muted-foreground">
            {runsLoading
              ? "Loading…"
              : runs.length === 0
                ? "No runs yet"
                : `${runs.length} recent ${runs.length === 1 ? "run" : "runs"}`}
          </span>
          {runs.length > 0 && (
            <Button
              size="sm"
              variant="ghost"
              onClick={handleClear}
              disabled={clearing}
              className="h-6 px-2 text-xs text-muted-foreground hover:text-red-400 hover:bg-red-500/10"
            >
              {clearing ? "Clearing…" : "Clear"}
            </Button>
          )}
        </div>
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
          <p className="text-xs text-muted-foreground">Run an action to see its history here.</p>
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
                  <XCircle size={13} className="mt-0.5 shrink-0 text-red-400" aria-label="Failed" />
                )}

                {/* Main info */}
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="flex items-center gap-1.5">
                    <Icon size={11} className="shrink-0 text-muted-foreground" />
                    <span className="font-medium text-foreground truncate">{run.actionName}</span>
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
    globalEnabled,
    setGlobalEnabled,
    createAction,
    updateAction,
    deleteAction,
    toggleEnabled,
    executeAction,
    runs,
    runsLoading,
    loadRuns,
    clearRuns,
    runsRetentionLimit,
    setRunsRetentionLimit,
  } = useActionEngine();

  // Dialog state
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Action | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Action | null>(null);

  // Load run history on mount so the panel is populated immediately.
  // Use the retention limit (or 200 if unlimited) so we don't over-fetch.
  useEffect(() => {
    void loadRuns(runsRetentionLimit > 0 ? runsRetentionLimit : 200);
  }, [loadRuns, runsRetentionLimit]);

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
    // Refresh run history so the new run appears immediately.
    void loadRuns(runsRetentionLimit > 0 ? runsRetentionLimit : 200);
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

          {/* Global kill switch */}
          <div
            className={`rounded-xl border p-4 flex items-center justify-between gap-4 transition-colors ${
              globalEnabled
                ? "border-border-subtle/50 bg-surface-raised/30"
                : "border-amber-500/30 bg-amber-500/5"
            }`}
          >
            <div>
              <p className="text-sm font-medium text-foreground">
                Action Engine {globalEnabled ? "active" : "paused"}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {globalEnabled
                  ? "Voice commands are being matched and executed during dictation."
                  : "Voice command matching is suspended. Dictation will paste text as usual."}
              </p>
            </div>
            <button
              type="button"
              aria-label={globalEnabled ? "Disable Action Engine" : "Enable Action Engine"}
              onClick={() => setGlobalEnabled(!globalEnabled)}
              className="shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded"
            >
              {globalEnabled ? (
                <ToggleRight size={32} className="text-primary" />
              ) : (
                <ToggleLeft size={32} className="text-muted-foreground" />
              )}
            </button>
          </div>

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
            <p className="text-sm font-medium text-foreground">How triggers work</p>
            <div className="space-y-2 text-xs text-muted-foreground leading-relaxed">
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
            runs={runs}
            runsLoading={runsLoading}
            onClear={async () => {
              await clearRuns();
            }}
            retentionLimit={runsRetentionLimit}
            onRetentionChange={(limit) => void setRunsRetentionLimit(limit)}
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

      {/* Edit dialog — key forces remount when target changes, ensuring form is hydrated */}
      <ActionFormDialog
        key={editTarget?.id ?? "__edit__"}
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
