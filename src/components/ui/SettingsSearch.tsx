import { useEffect, useMemo, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import {
  SETTINGS_SEARCH_INDEX,
  searchSettings,
  type SettingsSearchEntry,
} from "../../config/settingsSearchIndex";

const MAX_RESULTS = 8;

interface SettingsSearchProps {
  /** Called with the chosen row. The caller switches tab or page, then scrolls. */
  onSelect: (entry: SettingsSearchEntry) => void;
}

/**
 * Find a setting by name when you do not know which tab it lives under.
 *
 * Half of what people call "settings" is not on the Settings page at all - the
 * Read Aloud voice and the Converse agent have their own pages - so the index
 * spans pages and each result says where it is going. Landing on the right tab
 * is only half the job, so the caller also scrolls to the row.
 */
export default function SettingsSearch({ onSelect }: SettingsSearchProps) {
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const results = useMemo(
    () => searchSettings(query, SETTINGS_SEARCH_INDEX).slice(0, MAX_RESULTS),
    [query]
  );

  useEffect(() => setHighlighted(0), [query]);

  // Ctrl/Cmd+F is what people press to find something on a page, and the
  // browser's own find is useless here - it cannot see a row on another tab.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const choose = (entry: SettingsSearchEntry) => {
    setQuery("");
    inputRef.current?.blur();
    onSelect(entry);
  };

  const onInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (results.length === 0) {
      if (event.key === "Escape") setQuery("");
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlighted((current) => (current + 1) % results.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlighted((current) => (current - 1 + results.length) % results.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(results[highlighted]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setQuery("");
    }
  };

  const showResults = query.trim().length > 0;

  return (
    <div className="relative">
      <div className="relative">
        <Search
          size={15}
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
        />
        <input
          ref={inputRef}
          type="text"
          role="searchbox"
          aria-label="Search settings"
          placeholder="Search settings"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onInputKeyDown}
          className="w-full rounded-lg border border-border-subtle bg-surface-1 py-2 pl-9 pr-9 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
        />
        {query && (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => {
              setQuery("");
              inputRef.current?.focus();
            }}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
          >
            <X size={14} />
          </button>
        )}
      </div>

      {showResults && (
        <div className="absolute z-20 mt-1.5 w-full overflow-hidden rounded-lg border border-border-subtle bg-card shadow-(--shadow-card)">
          {results.length === 0 ? (
            // Naming the miss beats an empty box: it says the search ran and
            // found nothing, rather than looking broken.
            <p className="px-3 py-3 text-[13px] text-muted-foreground">
              No setting matches “{query.trim()}”.
            </p>
          ) : (
            <ul role="listbox" aria-label="Settings search results">
              {results.map((entry, index) => (
                <li key={`${entry.page}-${entry.section || ""}-${entry.label}`}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={index === highlighted}
                    onMouseEnter={() => setHighlighted(index)}
                    onClick={() => choose(entry)}
                    className={`flex w-full items-baseline justify-between gap-3 px-3 py-2 text-left ${
                      index === highlighted ? "bg-surface-1" : ""
                    }`}
                  >
                    <span className="truncate text-sm text-foreground">{entry.label}</span>
                    <span className="shrink-0 text-[12px] text-muted-foreground">
                      {entry.group}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
