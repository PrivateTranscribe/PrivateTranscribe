import { BookMarked, Trash2, Lock, Pencil } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Toggle } from "../ui/toggle";
import { isBetaFeature, useBetaFeaturesEnabled } from "../../utils/betaFeatures";
import { BetaBadge } from "../ui/BetaBadge";
import { BetaAccessLink } from "../ui/BetaAccessLink";
import { useSettings } from "../../hooks/useSettings";

type CorrectionRow = {
  source: string;
  target: string;
  count: number;
  last_seen_at?: string;
  created_at?: string;
};

type SortKey = "count" | "recent" | "source";

function safeString(v: unknown) {
  return typeof v === "string" ? v : "";
}

function safeNumber(v: unknown) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function toTime(v?: string) {
  if (!v) return 0;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : 0;
}

function formatDate(v?: string) {
  if (!v) return null;
  const d = new Date(v);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function isSingleWord(value: string) {
  return /^\S+$/.test(value.trim());
}

export default function CorrectionMemoryPage({ embedded = false }: { embedded?: boolean }) {
  const [betaOn] = useBetaFeaturesEnabled();
  const isUnlocked = betaOn || !isBetaFeature("correction-memory");
  const {
    enableCorrectionLearning,
    setEnableCorrectionLearning,
    enablePhraseCorrectionLearning,
    setEnablePhraseCorrectionLearning,
  } = useSettings();
  const formRef = useRef<HTMLDivElement>(null);
  const [rows, setRows] = useState<CorrectionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("count");
  const [source, setSource] = useState("");
  const [target, setTarget] = useState("");
  const [saving, setSaving] = useState(false);
  const [deletingSource, setDeletingSource] = useState<string | null>(null);

  const fetchRows = useCallback(async () => {
    if (!isUnlocked) {
      setRows([]);
      setLoading(false);
      return;
    }
    try {
      setLoading(true);
      setError(null);
      const result = await window.electronAPI?.getCorrectionMemory?.(500);
      const list = Array.isArray(result) ? result : [];
      const normalized: CorrectionRow[] = list
        .map((r: any) => ({
          source: safeString(r?.source),
          target: safeString(r?.target),
          count: safeNumber(r?.count) || 1,
          last_seen_at: safeString(r?.last_seen_at),
          created_at: safeString(r?.created_at),
        }))
        .filter((r) => r.source && r.target);
      setRows(normalized);
    } catch (e: any) {
      setError(e?.message || "Failed to load correction memory");
    } finally {
      setLoading(false);
    }
  }, [isUnlocked]);

  useEffect(() => {
    void fetchRows();
  }, [fetchRows]);

  const sorted = useMemo(() => {
    const list = [...rows];
    if (sortKey === "count") {
      list.sort((a, b) => (b.count || 0) - (a.count || 0));
    } else if (sortKey === "recent") {
      list.sort((a, b) => toTime(b.last_seen_at) - toTime(a.last_seen_at));
    } else {
      list.sort((a, b) => a.source.localeCompare(b.source));
    }
    return list;
  }, [rows, sortKey]);

  const existingForSource = useMemo(() => {
    const s = source.trim();
    if (!s) return null;
    return rows.find((r) => r.source === s) || null;
  }, [rows, source]);

  const handleAdd = async () => {
    if (!isUnlocked) return;
    const s = source.trim();
    const t = target.trim();
    if (!s || !t || s === t) return;
    if (!enablePhraseCorrectionLearning && (!isSingleWord(s) || !isSingleWord(t))) {
      setError(
        "Corrections are word-level only unless phrase and sentence rewrites are enabled above."
      );
      return;
    }
    try {
      setSaving(true);
      setError(null);
      await window.electronAPI?.confirmCorrection?.(s, t);
      setSource("");
      setTarget("");
      await fetchRows();
    } catch (e: any) {
      setError(e?.message || "Failed to save correction");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (src: string) => {
    if (!isUnlocked) return;
    try {
      setDeletingSource(src);
      setError(null);
      await window.electronAPI?.deleteCorrection?.(src);
      setRows((prev) => prev.filter((r) => r.source !== src));
    } catch (e: any) {
      setError(e?.message || "Failed to delete correction");
    } finally {
      setDeletingSource(null);
    }
  };

  return (
    <div className={embedded ? "space-y-6" : "p-8 max-w-5xl mx-auto space-y-6"}>
      {/* Header */}
      {!embedded && (
        <div className="flex items-start gap-3 mb-2">
          <BookMarked size={28} className="text-primary mt-0.5 shrink-0" />
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-3xl font-semibold text-foreground tracking-tight">
                Correction Memory
              </h1>
              <BetaBadge locked={!isUnlocked} />
            </div>
            <p className="text-sm text-muted-foreground mt-1">
              Replace repeated mistakes, like cloud → Claude.
            </p>
          </div>
        </div>
      )}

      {!isUnlocked && (
        <div className="rounded-xl border border-primary/20 bg-primary/5 p-6 text-center space-y-3">
          <Lock size={24} className="mx-auto text-primary/60" />
          <h3 className="text-base font-semibold text-foreground">Correction Memory is in beta</h3>
          <p className="text-sm text-muted-foreground max-w-md mx-auto">
            We are still building it, so it can change between updates. Your dictionary works
            without it.
          </p>
          <BetaAccessLink className="text-sm" />
        </div>
      )}

      {isUnlocked && error && (
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          {error}
        </div>
      )}

      {isUnlocked && (
        <>
          <div className="rounded-xl border border-border-subtle/50 bg-surface-raised/30 p-5 space-y-4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <h2 className="text-base font-semibold text-foreground">Learn corrections</h2>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Copy your corrected text within 30 seconds. We ask before saving.
                </p>
              </div>
              <Toggle
                aria-label="Learn corrections"
                checked={enableCorrectionLearning}
                onChange={setEnableCorrectionLearning}
                disabled={!isUnlocked}
              />
            </div>
            <div className="flex items-center justify-between gap-4 border-t border-border-subtle/40 pt-4">
              <div>
                <h3 className="text-sm font-medium text-foreground">
                  Learn phrase and sentence rewrites
                </h3>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Include phrase and sentence changes.
                </p>
              </div>
              <Toggle
                aria-label="Learn phrase and sentence rewrites"
                checked={enablePhraseCorrectionLearning}
                onChange={setEnablePhraseCorrectionLearning}
                disabled={!isUnlocked || !enableCorrectionLearning}
              />
            </div>
          </div>

          {/* Add correction */}
          <div
            ref={formRef}
            className="rounded-xl border border-border-subtle/50 bg-surface-raised/30 p-6 space-y-3"
          >
            <div>
              <h2 className="text-base font-semibold text-foreground">Add a correction</h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                Manually teach PrivateTranscribe an exact replacement.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <Input
                placeholder={
                  enablePhraseCorrectionLearning
                    ? "Source word or phrase - e.g. please write an email"
                    : "Source word - e.g. cloud"
                }
                value={source}
                onChange={(e) => setSource(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleAdd()}
              />
              <Input
                placeholder={
                  enablePhraseCorrectionLearning
                    ? "Replacement word or phrase - e.g. Hey team, quick update."
                    : "Replacement word - e.g. Claude"
                }
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleAdd()}
              />
            </div>

            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="text-xs text-muted-foreground">
                {existingForSource && target.trim() && existingForSource.target !== target.trim()
                  ? `Updating “${existingForSource.source}” will overwrite the current target.`
                  : null}
              </div>
              <Button
                onClick={handleAdd}
                disabled={
                  saving ||
                  !source.trim() ||
                  !target.trim() ||
                  (!enablePhraseCorrectionLearning &&
                    (!isSingleWord(source) || !isSingleWord(target)))
                }
              >
                {saving ? "Saving…" : existingForSource ? "Update correction" : "Add correction"}
              </Button>
            </div>
          </div>

          {/* List */}
          <div className="rounded-xl border border-border-subtle/50 bg-surface-raised/30 p-6 space-y-4">
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div>
                <h2 className="text-base font-semibold text-foreground">Learned corrections</h2>
                <p className="text-xs text-muted-foreground">
                  {loading
                    ? "Loading…"
                    : `${sorted.length} ${sorted.length === 1 ? "entry" : "entries"}`}
                </p>
              </div>

              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">Sort</span>
                <Select value={sortKey} onValueChange={(val) => setSortKey(val as SortKey)}>
                  <SelectTrigger className="w-[160px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="count">Most frequent</SelectItem>
                    <SelectItem value="recent">Most recent</SelectItem>
                    <SelectItem value="source">Source (A→Z)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {loading ? (
              <div className="space-y-2">
                <div className="skeleton h-10 w-full" />
                <div className="skeleton h-10 w-full" />
                <div className="skeleton h-10 w-full" />
              </div>
            ) : sorted.length === 0 ? (
              <div className="text-sm text-muted-foreground">
                No corrections yet. Enable learning in Settings or add one manually above.
              </div>
            ) : (
              <div className="space-y-2">
                {sorted.slice(0, 200).map((r, idx) => (
                  <div
                    key={`${r.source}=>${r.target}-${idx}`}
                    className="flex items-center justify-between gap-3 rounded-lg border border-border-subtle bg-background/40 px-3 py-2"
                  >
                    {/* Source → Target */}
                    <div className="min-w-0 flex-1">
                      <span className="font-mono text-sm text-foreground">{r.source}</span>
                      <span className="text-sm text-muted-foreground mx-2">→</span>
                      <span className="font-mono text-sm text-primary">{r.target}</span>
                    </div>

                    {/* Count + date + delete */}
                    <div className="flex items-center gap-2 shrink-0">
                      <Badge variant="secondary" className="text-[10px]">
                        ×{r.count}
                        {r.last_seen_at && formatDate(r.last_seen_at)
                          ? ` · ${formatDate(r.last_seen_at)}`
                          : ""}
                      </Badge>
                      <button
                        onClick={() => {
                          setSource(r.source);
                          setTarget(r.target);
                          formRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
                        }}
                        className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted/30 transition-colors"
                        title="Edit correction"
                      >
                        <Pencil size={14} />
                      </button>

                      <button
                        onClick={() => handleDelete(r.source)}
                        disabled={deletingSource === r.source}
                        className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-40"
                        title="Remove correction"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {sorted.length > 200 && (
              <div className="text-[10px] text-muted-foreground">Showing first 200 entries.</div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
