import React, { useEffect, useMemo, useRef, useState } from "react";
import { Check, Plus, Search, X } from "lucide-react";
import { LANGUAGE_OPTIONS, getLanguageLabel } from "../../utils/languages";
import { MAX_SPOKEN_LANGUAGES, normalizeSpokenLanguages } from "../../utils/spokenLanguages";
import { selectContentClass, selectItemClass } from "./selectStyles";
import { cn } from "../lib/utils";

interface SpokenLanguagesSelectorProps {
  value: string[];
  onChange: (value: string[]) => void;
  className?: string;
}

/**
 * Picker for the languages the user speaks.
 *
 * Deliberately a chip list rather than a multi-select dropdown: the selection
 * is short by design, and the answer stays readable at a glance instead of
 * hiding behind a closed control. Removing is a single click on the chip,
 * which matters because getting this wrong quietly degrades every dictation.
 */
export default function SpokenLanguagesSelector({
  value,
  onChange,
  className = "",
}: SpokenLanguagesSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const dropdownRef = useRef<HTMLDivElement>(null);
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

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
        setSearchQuery("");
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const toggleLanguage = (code: string) => {
    if (selected.includes(code)) {
      onChange(selected.filter((entry) => entry !== code));
      return;
    }
    if (isFull) return;
    onChange([...selected, code]);
    setSearchQuery("");
  };

  return (
    <div className={cn("relative", className)} ref={dropdownRef}>
      <div className="flex flex-wrap items-center gap-1.5">
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

        <button
          type="button"
          onClick={() => setIsOpen((open) => !open)}
          disabled={isFull}
          className={cn(
            "inline-flex items-center gap-1 rounded-full border border-dashed border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors",
            isFull
              ? "cursor-not-allowed opacity-50"
              : "hover:border-border-hover hover:text-foreground"
          )}
        >
          <Plus className="h-3 w-3" />
          {selected.length === 0 ? "Add a language" : "Add another"}
        </button>
      </div>

      {isOpen && (
        <div className={cn(selectContentClass, "absolute top-full z-20 mt-1.5 w-full max-h-60")}>
          <div className="border-b border-border-subtle p-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                ref={searchInputRef}
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search languages..."
                className="w-full rounded-lg border border-border-subtle bg-surface-1 py-1.5 pl-8 pr-3 text-sm text-foreground placeholder:text-muted-foreground/50 focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/20"
              />
            </div>
          </div>
          <div className="max-h-44 overflow-y-auto">
            {filteredLanguages.length === 0 ? (
              <div className="px-3 py-2 text-sm text-muted-foreground">No languages found</div>
            ) : (
              <div role="listbox" aria-multiselectable className="p-1">
                {filteredLanguages.map((language) => {
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
                        selectItemClass,
                        "text-left",
                        isSelected && "bg-primary/15 font-medium text-primary",
                        !isSelected && isFull && "cursor-not-allowed opacity-40"
                      )}
                    >
                      {language.label}
                      {isSelected && (
                        <span className="absolute right-2 flex h-3.5 w-3.5 items-center justify-center">
                          <Check className="h-4 w-4" />
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {isFull && (
        <p className="mt-1.5 text-xs text-muted-foreground">
          Up to {MAX_SPOKEN_LANGUAGES} languages. Remove one to add another.
        </p>
      )}
    </div>
  );
}
