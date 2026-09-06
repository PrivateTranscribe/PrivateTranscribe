import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Button } from "./button";
import { Copy, Trash2, ChevronDown, ChevronUp, Check, Loader2 } from "lucide-react";
import type { TranscriptionItem as TranscriptionItemType } from "../../types/electron";

interface TranscriptionItemProps {
  item: TranscriptionItemType;
  index: number;
  total: number;
  searchQuery?: string;
  onCopy: (text: string) => Promise<boolean>;
  onDelete: (id: number) => void;
}

// Splits text into plain/highlighted segments for the given query string.
// Returns the original string when query is empty.
// eslint-disable-next-line react-refresh/only-export-components
export function highlightText(text: string, query: string): ReactNode {
  if (!query) return text;
  const lq = query.toLowerCase();
  const lower = text.toLowerCase();
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  let pos = lower.indexOf(lq);
  while (pos !== -1) {
    if (pos > cursor) parts.push(text.slice(cursor, pos));
    parts.push(
      <mark key={pos} className="bg-primary/25 text-foreground rounded-sm px-0.5 not-italic">
        {text.slice(pos, pos + query.length)}
      </mark>
    );
    cursor = pos + query.length;
    pos = lower.indexOf(lq, cursor);
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts.length ? <>{parts}</> : text;
}

/**
 * How much of a transcript the list shows before offering "Show More".
 *
 * Line-based rather than character-based on purpose. A character cap and a CSS
 * clamp were both applied, so whichever hit first won and the result was
 * unpredictable: at 280 characters the text was sliced mid-word ("bec…") well
 * before three lines were full on a wide window. Clamping alone breaks at a
 * line boundary, and shows more text when there is more room for it.
 *
 * Six lines is roughly a spoken paragraph, which is what most dictations are.
 */
const TEXT_PREVIEW_LINES = 6;

export default function TranscriptionItem({
  item,
  index,
  total,
  searchQuery = "",
  onCopy,
  onDelete,
}: TranscriptionItemProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const textRef = useRef<HTMLParagraphElement>(null);
  const [isCopied, setIsCopied] = useState(false);
  const [isCopying, setIsCopying] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    },
    []
  );

  const copyText = async () => {
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    setIsCopied(false);
    setIsCopying(true);
    try {
      if (await onCopy(item.text)) {
        setIsCopied(true);
        copiedTimer.current = setTimeout(() => setIsCopied(false), 2000);
      }
    } finally {
      setIsCopying(false);
    }
  };

  const timestampSource = item.timestamp.endsWith("Z") ? item.timestamp : `${item.timestamp}Z`;
  const timestampDate = new Date(timestampSource);
  const formattedTimestamp = Number.isNaN(timestampDate.getTime())
    ? item.timestamp
    : timestampDate.toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });

  // When a search is active, show full text so the highlighted match is always
  // visible. The transcript is never sliced now; the clamp decides what fits.
  const isClamped = !isExpanded && !searchQuery;
  const renderedText = highlightText(item.text, searchQuery);

  // Whether the clamp is actually hiding anything, measured rather than guessed
  // from a character count, so the button matches what is on screen at this
  // window width.
  const measureOverflow = useCallback(() => {
    const el = textRef.current;
    if (!el || !isClamped) return;
    setIsOverflowing(el.scrollHeight - el.clientHeight > 1);
  }, [isClamped]);

  useLayoutEffect(measureOverflow, [measureOverflow, item.text, searchQuery]);

  useEffect(() => {
    const el = textRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measureOverflow);
    observer.observe(el);
    return () => observer.disconnect();
  }, [measureOverflow]);

  // Expanding removes the overflow that justified the button, so the toggle
  // has to survive on its own once it is open.
  const canToggle = (isOverflowing || isExpanded) && !searchQuery;

  return (
    <div className="group relative px-6 py-5 transition-all duration-300 hover:bg-primary/5">
      <div className="flex items-start gap-5">
        {/* Number badge - luxury pill with glow */}
        <div className="flex-shrink-0 mt-1">
          <span className="inline-flex items-center justify-center min-w-[40px] h-7 px-2.5 rounded-lg bg-primary/15 text-primary text-xs font-semibold tabular-nums shadow-[0_0_10px_rgba(112,255,186,0.15)]">
            {index + 1}
          </span>
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          {/* Text */}
          <p
            ref={textRef}
            className="text-foreground text-[15px] leading-relaxed break-words"
            style={
              isClamped
                ? {
                    display: "-webkit-box",
                    WebkitBoxOrient: "vertical",
                    WebkitLineClamp: TEXT_PREVIEW_LINES,
                    overflow: "hidden",
                  }
                : undefined
            }
          >
            {renderedText}
          </p>

          {/* Metadata row */}
          <div className="flex items-center gap-3 mt-2.5">
            <span className="text-xs text-muted-foreground tabular-nums">{formattedTimestamp}</span>
            {canToggle && (
              <button
                onClick={() => setIsExpanded(!isExpanded)}
                className="inline-flex items-center gap-1 text-xs text-primary/80 hover:text-primary transition-colors duration-200"
              >
                {isExpanded ? (
                  <>
                    <span>Show Less</span>
                    <ChevronUp size={14} />
                  </>
                ) : (
                  <>
                    <span>Show More</span>
                    <ChevronDown size={14} />
                  </>
                )}
              </button>
            )}
          </div>
        </div>

        {/* Keep actions discoverable with both pointer and keyboard. */}
        <div className="flex items-center gap-1 flex-shrink-0">
          <Button
            size="icon"
            variant="ghost"
            onClick={copyText}
            disabled={isCopying}
            aria-label={isCopied ? "Copied" : isCopying ? "Copying" : "Copy transcription"}
            title={isCopied ? "Copied" : "Copy transcription"}
            className="h-8 w-8 rounded-lg text-muted-foreground hover:text-foreground hover:bg-foreground/10 transition-all duration-200"
          >
            {isCopying ? (
              <Loader2 size={14} className="animate-spin" />
            ) : isCopied ? (
              <Check size={14} className="text-primary" />
            ) : (
              <Copy size={14} />
            )}
          </Button>
          <Button
            size="icon"
            variant="ghost"
            onClick={() => onDelete(item.id)}
            aria-label="Delete transcription"
            title="Delete transcription"
            className="h-8 w-8 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-all duration-200"
          >
            <Trash2 size={14} />
          </Button>
        </div>
      </div>
    </div>
  );
}
