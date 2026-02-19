import { useState, useEffect, useMemo, useCallback } from "react";
import { Search, Trash2, Mic } from "lucide-react";
import { useTranscriptions, initializeTranscriptions } from "../../stores/transcriptionStore";
import TranscriptionItem from "../ui/TranscriptionItem";
import { useToast } from "../ui/Toast";
import { useDialogs } from "../../hooks/useDialogs";
import { ConfirmDialog } from "../ui/dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { useSettings } from "../../hooks/useSettings";
import type { TranscriptionItem as TranscriptionItemType } from "../../types/electron";

// ---------------------------------------------------------------------------
// Date grouping helpers
// ---------------------------------------------------------------------------

type DateGroup = "Today" | "Yesterday" | "This Week" | "Older";

function getDateGroup(timestamp: string): DateGroup {
  const src = timestamp.endsWith("Z") ? timestamp : timestamp + "Z";
  const date = new Date(src);
  if (Number.isNaN(date.getTime())) return "Older";

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const weekAgo = new Date(today);
  weekAgo.setDate(weekAgo.getDate() - 6);

  const itemDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());

  if (itemDay.getTime() >= today.getTime()) return "Today";
  if (itemDay.getTime() >= yesterday.getTime()) return "Yesterday";
  if (itemDay.getTime() >= weekAgo.getTime()) return "This Week";
  return "Older";
}

const GROUP_ORDER: DateGroup[] = ["Today", "Yesterday", "This Week", "Older"];

function groupTranscriptions(
  items: TranscriptionItemType[]
): { label: DateGroup; items: TranscriptionItemType[] }[] {
  const buckets = new Map<DateGroup, TranscriptionItemType[]>();
  for (const item of items) {
    const group = getDateGroup(item.timestamp);
    const arr = buckets.get(group) ?? [];
    arr.push(item);
    buckets.set(group, arr);
  }

  return GROUP_ORDER.filter((g) => buckets.has(g)).map((g) => ({
    label: g,
    items: buckets.get(g)!,
  }));
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function HistoryPage() {
  const transcriptions = useTranscriptions();
  const { toast } = useToast();
  const {
    confirmDialog,
    showConfirmDialog,
    hideConfirmDialog,
  } = useDialogs();
  const { historyLimit } = useSettings();

  const [searchQuery, setSearchQuery] = useState("");

  // Initialise store on mount, respecting the user's history limit setting
  useEffect(() => {
    initializeTranscriptions(historyLimit);
  }, [historyLimit]);

  // ------- Filtered + grouped data -------
  const filtered = useMemo(() => {
    if (!searchQuery.trim()) return transcriptions;
    const q = searchQuery.toLowerCase();
    return transcriptions.filter((t) => t.text.toLowerCase().includes(q));
  }, [transcriptions, searchQuery]);

  const groups = useMemo(() => groupTranscriptions(filtered), [filtered]);

  // ------- Actions -------
  const handleCopy = useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text);
        toast({ title: "Copied", description: "Transcription copied to clipboard", variant: "success" });
      } catch {
        toast({ title: "Error", description: "Failed to copy to clipboard", variant: "destructive" });
      }
    },
    [toast]
  );

  const handleDelete = useCallback(
    (id: number) => {
      showConfirmDialog({
        title: "Delete transcription",
        description: "This transcription will be permanently removed. This action cannot be undone.",
        confirmText: "Delete",
        variant: "destructive",
        onConfirm: async () => {
          try {
            await window.electronAPI?.deleteTranscription?.(id);
            toast({ title: "Deleted", description: "Transcription removed", variant: "success" });
          } catch {
            toast({ title: "Error", description: "Failed to delete transcription", variant: "destructive" });
          }
        },
      });
    },
    [showConfirmDialog, toast]
  );

  const handleClearAll = useCallback(() => {
    showConfirmDialog({
      title: "Clear all history",
      description:
        "This will permanently delete all transcriptions. This action cannot be undone.",
      confirmText: "Clear All",
      variant: "destructive",
      onConfirm: async () => {
        try {
          await window.electronAPI?.clearTranscriptions?.();
          toast({
            title: "History cleared",
            description: "All transcriptions have been removed",
            variant: "success",
          });
        } catch {
          toast({
            title: "Error",
            description: "Failed to clear history",
            variant: "destructive",
          });
        }
      },
    });
  }, [showConfirmDialog, toast]);

  // ------- Render -------
  const isEmpty = transcriptions.length === 0;
  const noResults = !isEmpty && filtered.length === 0;

  return (
    <div className="flex flex-col h-full p-8 gap-6 overflow-hidden">
      {/* ---- Header ---- */}
      <div className="flex items-center justify-between flex-shrink-0">
        <div className="flex items-baseline gap-3">
          <h1 className="text-3xl font-semibold text-foreground brand-heading tracking-tight">
            History
          </h1>
          {transcriptions.length > 0 && (
            <span className="text-sm text-muted-foreground tabular-nums">
              {transcriptions.length}{" "}
              {transcriptions.length === 1 ? "transcription" : "transcriptions"}
            </span>
          )}
        </div>

        {transcriptions.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            onClick={handleClearAll}
            className="text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-all duration-200 gap-1.5"
          >
            <Trash2 size={14} />
            Clear All
          </Button>
        )}
      </div>

      {/* ---- Search bar ---- */}
      {!isEmpty && (
        <div className="relative flex-shrink-0">
          <Search
            size={16}
            className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
          />
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search transcriptions..."
            className="pl-10 bg-surface-1/60 backdrop-blur-sm border-border-subtle focus-visible:border-primary/50 focus-visible:ring-1 focus-visible:ring-primary/15"
          />
        </div>
      )}

      {/* ---- Content area ---- */}
      <div className="flex-1 overflow-y-auto min-h-0 -mx-8 px-8">
        {/* Empty state */}
        {isEmpty && (
          <div className="flex flex-col items-center justify-center h-full gap-4 select-none">
            <div className="flex items-center justify-center w-16 h-16 rounded-2xl bg-primary/10 shadow-[0_0_30px_rgba(112,255,186,0.08)]">
              <Mic size={28} className="text-primary/60" />
            </div>
            <div className="text-center space-y-1.5">
              <p className="text-lg font-medium text-foreground">
                No transcriptions yet
              </p>
              <p className="text-sm text-muted-foreground max-w-xs">
                Start dictating to see your history here
              </p>
            </div>
          </div>
        )}

        {/* No search results */}
        {noResults && (
          <div className="flex flex-col items-center justify-center h-48 gap-3 select-none">
            <Search size={24} className="text-muted-foreground/40" />
            <div className="text-center space-y-1">
              <p className="text-sm font-medium text-muted-foreground">
                No matches found
              </p>
              <p className="text-xs text-muted-foreground/60">
                Try a different search term
              </p>
            </div>
          </div>
        )}

        {/* Grouped list */}
        {groups.length > 0 && (
          <div className="space-y-6 pb-4">
            {groups.map((group) => (
              <div key={group.label}>
                {/* Group header */}
                <div className="sticky top-0 z-10 flex items-center gap-3 py-2 mb-1 bg-background/80 backdrop-blur-md">
                  <span className="text-xs font-semibold uppercase tracking-wider text-primary/80">
                    {group.label}
                  </span>
                  <div className="flex-1 h-px bg-border-subtle/60" />
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {group.items.length}
                  </span>
                </div>

                {/* Items panel */}
                <div className="rounded-xl border border-border-subtle bg-surface-1/40 overflow-hidden">
                  {group.items.map((item, idx) => (
                    <div key={item.id}>
                      {idx > 0 && (
                        <div className="mx-6 h-px bg-border-subtle/50" />
                      )}
                      <TranscriptionItem
                        item={item}
                        index={
                          transcriptions.findIndex((t) => t.id === item.id)
                        }
                        total={transcriptions.length}
                        onCopy={handleCopy}
                        onDelete={handleDelete}
                      />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ---- Confirm dialog ---- */}
      <ConfirmDialog
        open={confirmDialog.open}
        onOpenChange={(open) => {
          if (!open) hideConfirmDialog();
        }}
        title={confirmDialog.title}
        description={confirmDialog.description}
        confirmText={confirmDialog.confirmText}
        cancelText={confirmDialog.cancelText}
        onConfirm={confirmDialog.onConfirm}
        variant={confirmDialog.variant}
      />
    </div>
  );
}
