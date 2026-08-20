import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Plus, Search, X } from "lucide-react";
import { LANGUAGE_OPTIONS, getLanguageLabel } from "../../utils/languages";
import { MAX_SPOKEN_LANGUAGES, normalizeSpokenLanguages } from "../../utils/spokenLanguages";
import { cn } from "../lib/utils";

interface SpokenLanguagesSelectorProps {
  value: string[];
  onChange: (value: string[]) => void;
  className?: string;
}

/**
 * Picker for the languages the user speaks.
 *
 * The search panel expands **inline** rather than floating over the page.
 * An absolutely positioned dropdown is clipped to nothing here: SettingsPanel
 * sets overflow-hidden to keep its rounded corners and row dividers, so the
 * floating list was cut off after its first entry and the other 57 languages
 * could not be reached at all. Growing the row costs some vertical space and
 * cannot be clipped by any ancestor.
 *
 * The selection is a chip list rather than a closed dropdown because it is
 * short by design, and getting it wrong quietly degrades every dictation, so
 * the answer should be readable without opening anything.
 */
export default function SpokenLanguagesSelector({
  value,
  onChange,
  className = "",
}: SpokenLanguagesSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);

  const selected = useMemo(() => normalizeSpokenLanguages(value), [value]);
  const isFull = selected.length >= MAX_SPOKEN_LANGUAGES;

  const filteredLanguages = useMemo(
    () =>
      LANGUAGE_OPTIONS.filter((lang) => lang.value !== "auto").filter(
        (lang) =>
          lang.label.toLowerCase().includes(searchQuery.toLowerCase()) ||
          lang.value.toLowerCase().includes(searchQuery.toLowerCase())
      ),
    [searchQuery]
  );

  useEffect(() => {
    if (isOpen && searchInputRef.current) searchInputRef.current.focus();
  }, [isOpen]);

  const toggleLanguage = (code: string) => {
    if (selected.includes(code)) {
      onChange(selected.filter((entry) => entry !== code));
      return;
    }
    if (isFull) return;
    onChange([...selected, code]);
    setSearchQuery("");
  };

  const closePanel = () => {
    setIsOpen(false);
    setSearchQuery("");
  };

  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex flex-wrap items-center gap-1.5">
        {/* Auto-detect is a real state, not the absence of one. Without a chip
            for it the row sat empty while the copy talked about auto-detect
            being on, and nothing on screen agreed. */}
        {selected.length === 0 && (
          <span className="inline-flex items-center rounded-full border border-dashed border-border-hover px-2.5 py-1 text-xs font-medium text-muted-foreground">
            Auto-detect
          </span>
        )}

        {selected.map((code) => (
          <span
            key={code}
            className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 py-1 pl-2.5 pr-1 text-xs font-medium text-primary"
          >
            {getLanguageLabel(code)}
            <button
              type="button"
              onClick={() => toggleLanguage(code)}
              className="rounded-full p-0.5 text-primary/70 transition-colors hover:bg-primary/20 hover:text-primary"
              aria-label={`Remove ${getLanguageLabel(code)}`}
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}

        {/* Deliberately still clickable at the cap. Disabling it left a dead
            button whose only explanation lived inside the panel it refused to
            open, so the user could not find out why. Opening shows the cap
            notice and lets them untick one. */}
        <button
          type="button"
          onClick={() => (isOpen ? closePanel() : setIsOpen(true))}
          className={cn(
            "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
            isOpen
              ? "border-primary/40 bg-primary/10 text-primary"
              : "border-border-hover text-foreground hover:border-primary/40 hover:text-primary"
          )}
        >
          {isOpen ? <X className="h-3 w-3" /> : <Plus className="h-3 w-3" />}
          {isOpen ? "Done" : selected.length === 0 ? "Add a language" : "Add another"}
        </button>
      </div>

      {isOpen && (
        <div className="rounded-lg border border-border-subtle bg-surface-1">
          <div className="border-b border-border-subtle p-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                ref={searchInputRef}
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    closePanel();
                  }
                  if (e.key === "Enter" && filteredLanguages[0]) {
                    e.preventDefault();
                    toggleLanguage(filteredLanguages[0].value);
                  }
                }}
                placeholder="Search languages..."
                className="w-full rounded-md border border-border-subtle bg-surface-2 py-1.5 pl-8 pr-3 text-sm text-foreground placeholder:text-muted-foreground/50 focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/20"
              />
            </div>
          </div>

          {/* Tall enough to show the list continues, short enough that opening
              it does not take over the settings page. */}
          <div className="max-h-52 overflow-y-auto p-1" role="listbox" aria-multiselectable>
            {filteredLanguages.length === 0 ? (
              <p className="px-3 py-2 text-sm text-muted-foreground">No languages found</p>
            ) : (
              filteredLanguages.map((language) => {
                const isSelected = selected.includes(language.value);
                return (
                  <button
                    key={language.value}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    disabled={!isSelected && isFull}
                    onClick={() => toggleLanguage(language.value)}
                    className={cn(
                      "flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-sm transition-colors",
                      isSelected
                        ? "bg-primary/15 font-medium text-primary"
                        : "text-foreground hover:bg-surface-raised",
                      !isSelected && isFull && "cursor-not-allowed opacity-40 hover:bg-transparent"
                    )}
                  >
                    {language.label}
                    {isSelected && <Check className="h-3.5 w-3.5 shrink-0" />}
                  </button>
                );
              })
            )}
          </div>

          {isFull && (
            <p className="border-t border-border-subtle px-3 py-2 text-xs text-muted-foreground">
              Up to {MAX_SPOKEN_LANGUAGES} languages. Remove one to add another.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * One plain sentence describing what will actually happen on the next
 * dictation, so the screen and the behaviour cannot disagree.
 */
export function describeSpokenLanguages(spokenLanguages: string[]): string {
  const selected = normalizeSpokenLanguages(spokenLanguages);

  if (selected.length === 0) {
    return "Auto-detect is on. Whisper guesses from every language it knows, so close neighbours like Danish and Norwegian get mixed up.";
  }
  if (selected.length === 1) {
    return `Set to ${getLanguageLabel(selected[0])}. Nothing is detected, so nothing can be guessed wrong.`;
  }

  const labels = selected.map(getLanguageLabel);
  const last = labels[labels.length - 1];
  return `Detecting between ${labels.slice(0, -1).join(", ")} and ${last}. No other language can be picked.`;
}
