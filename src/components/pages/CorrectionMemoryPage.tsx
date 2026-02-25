import { BookMarked, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

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

export default function CorrectionMemoryPage() {
  const [rows, setRows] = useState<CorrectionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [sortKey, setSortKey] = useState<SortKey>("count");

  const [source, setSource] = useState("");
  const [target, setTarget] = useState("");
  const [saving, setSaving] = useState(false);

  const fetchRows = async () => {
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
  };

  useEffect(() => {
    void fetchRows();
  }, []);

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

  const handleAdd = async () => {
    const s = source.trim();
    const t = target.trim();
    if (!s || !t || s === t) return;

    try {
      setSaving(true);
      setError(null);
      await window.electronAPI?.upsertCorrection?.(s, t);
      setSource("");
      setTarget("");
      await fetchRows();
    } catch (e: any) {
      setError(e?.message || "Failed to save correction");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="p-8 max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <BookMarked size={28} className="text-primary" />
            <h1 className="text-3xl font-semibold text-foreground tracking-tight">
              Correction Memory
            </h1>
            <Badge variant="outline" className="text-[10px]">
              Local
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            Privoca learns mappings like <span className="font-mono">foo bar</span> →{" "}
            <span className="font-mono">fooBar</span> and snaps future dictations automatically.
          </p>
        </div>

        <Button variant="outline" onClick={fetchRows} disabled={loading}>
          <RefreshCw className="h-4 w-4 mr-2" />
          Refresh
        </Button>
      </div>

      {error && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* Add correction */}
      <div className="rounded-xl border border-border-subtle/50 bg-surface-raised/30 p-6 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-foreground">Add a correction</h2>
            <p className="text-xs text-muted-foreground">
              Example: source "is login error" → target "isLoginError"
            </p>
          </div>
          <Badge variant="outline" className="text-[10px]">
            Manual
          </Badge>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Input
            placeholder="Source (what you tend to say / what STT outputs)"
            value={source}
            onChange={(e) => setSource(e.target.value)}
          />
          <Input
            placeholder="Target (what you want inserted)"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          />
        </div>

        <div className="flex justify-end">
          <Button onClick={handleAdd} disabled={saving || !source.trim() || !target.trim()}>
            {saving ? "Saving..." : "Add correction"}
          </Button>
        </div>
      </div>

      {/* List */}
      <div className="rounded-xl border border-border-subtle/50 bg-surface-raised/30 p-6 space-y-4">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h2 className="text-base font-semibold text-foreground">Learned corrections</h2>
            <p className="text-xs text-muted-foreground">
              {loading ? "Loading…" : `${sorted.length} entries`}
            </p>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Sort:</span>
            <select
              value={sortKey}
              onChange={(e) => setSortKey(e.target.value as SortKey)}
              className="h-9 px-3 rounded-lg bg-surface-raised border border-border-subtle text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 transition-all"
            >
              <option value="count">Most frequent</option>
              <option value="recent">Most recent</option>
              <option value="source">Source (A→Z)</option>
            </select>
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
                <div className="min-w-0">
                  <div className="text-sm text-foreground truncate">
                    <span className="font-mono">{r.source}</span>
                    <span className="text-muted-foreground"> → </span>
                    <span className="font-mono text-primary">{r.target}</span>
                  </div>
                  {r.last_seen_at && (
                    <div className="text-[10px] text-muted-foreground">
                      Last seen: {r.last_seen_at}
                    </div>
                  )}
                </div>

                <Badge variant="secondary" className="text-[10px] shrink-0">
                  ×{r.count}
                </Badge>
              </div>
            ))}
          </div>
        )}

        {sorted.length > 200 && (
          <div className="text-[10px] text-muted-foreground">
            Showing first 200 entries.
          </div>
        )}
      </div>
    </div>
  );
}
