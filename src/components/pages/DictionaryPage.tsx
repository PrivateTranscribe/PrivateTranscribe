import { useState, useCallback } from "react";
import { BookOpen } from "lucide-react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { useSettings } from "../../hooks/useSettings";
import { useDialogs } from "../../hooks/useDialogs";
import { ConfirmDialog } from "../ui/dialog";
import CorrectionMemoryPage from "./CorrectionMemoryPage";

function SettingsPanel({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border-subtle/50 bg-surface-raised/50 backdrop-blur-sm divide-y divide-border-subtle/30 shadow-sm overflow-hidden">
      {children}
    </div>
  );
}

function SettingsPanelRow({ children }: { children: React.ReactNode }) {
  return <div className="px-5 py-4">{children}</div>;
}

export default function DictionaryPage() {
  const { customDictionary, setCustomDictionary } = useSettings();
  const { confirmDialog, showConfirmDialog, hideConfirmDialog } = useDialogs();
  const [newWord, setNewWord] = useState("");
  const [searchFilter, setSearchFilter] = useState("");

  const handleAdd = useCallback(() => {
    const word = newWord.trim();
    if (word && !customDictionary.includes(word)) {
      setCustomDictionary([...customDictionary, word]);
      setNewWord("");
    }
  }, [newWord, customDictionary, setCustomDictionary]);

  const handleRemove = useCallback(
    (wordToRemove: string) => {
      setCustomDictionary(customDictionary.filter((w) => w !== wordToRemove));
    },
    [customDictionary, setCustomDictionary]
  );

  const filteredWords = searchFilter
    ? customDictionary.filter((w) => w.toLowerCase().includes(searchFilter.toLowerCase()))
    : customDictionary;

  return (
    <div className="p-8 max-w-4xl mx-auto">
      <ConfirmDialog
        open={confirmDialog.open}
        onOpenChange={hideConfirmDialog}
        title={confirmDialog.title}
        description={confirmDialog.description}
        onConfirm={confirmDialog.onConfirm}
        variant={confirmDialog.variant}
      />

      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-2">
          <BookOpen size={28} className="text-primary" />
          <h1 className="text-3xl font-semibold text-foreground tracking-tight">Dictionary</h1>
          {customDictionary.length > 0 && (
            <span className="text-sm text-muted-foreground/50 font-mono">
              {customDictionary.length} words
            </span>
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          Names and terms you want spelled the way you spell them.
        </p>
      </div>

      {/* Add word input */}
      <div className="mb-8">
        <SettingsPanel>
          <SettingsPanelRow>
            <div className="space-y-2">
              <p className="text-[12px] font-medium text-foreground">Add a word or phrase</p>
              <div className="flex gap-2">
                <Input
                  placeholder="e.g. PrivateTranscribe, Kubernetes, Dr. Martinez..."
                  value={newWord}
                  onChange={(e) => setNewWord(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleAdd();
                  }}
                  className="flex-1 h-9 text-[13px]"
                />
                <Button onClick={handleAdd} disabled={!newWord.trim()} size="sm" className="h-9">
                  Add
                </Button>
              </div>
              <p className="text-[10px] text-muted-foreground/50">
                Type it exactly how you want it written. Press Enter to add.
              </p>
            </div>
          </SettingsPanelRow>
        </SettingsPanel>
      </div>

      {/* Word list */}
      <div className="mb-8">
        <div className="flex items-center justify-between mb-3">
          <p className="text-[13px] font-medium text-foreground">Your words</p>
          <div className="flex items-center gap-3">
            {customDictionary.length > 5 && (
              <Input
                placeholder="Filter words..."
                value={searchFilter}
                onChange={(e) => setSearchFilter(e.target.value)}
                className="h-7 w-40 text-[11px]"
              />
            )}
            {customDictionary.length > 0 && (
              <button
                onClick={() => {
                  showConfirmDialog({
                    title: "Clear dictionary?",
                    description:
                      "This will remove all words from your custom dictionary. This action cannot be undone.",
                    confirmText: "Clear All",
                    variant: "destructive",
                    onConfirm: () => setCustomDictionary([]),
                  });
                }}
                className="text-[11px] text-muted-foreground/40 hover:text-destructive transition-colors"
              >
                Clear all
              </button>
            )}
          </div>
        </div>

        {filteredWords.length > 0 ? (
          <SettingsPanel>
            <SettingsPanelRow>
              <div className="flex flex-wrap gap-1.5">
                {filteredWords.map((word) => (
                  <span
                    key={word}
                    className="group inline-flex items-center gap-1 pl-2.5 pr-1.5 py-1 bg-primary/10 text-foreground rounded-md text-[12px] border border-border-subtle transition-all hover:border-primary/40 hover:bg-primary/5"
                  >
                    {word}
                    <button
                      onClick={() => handleRemove(word)}
                      className="ml-0.5 p-0.5 rounded-sm text-muted-foreground/40 hover:text-destructive transition-colors"
                      title="Remove word"
                    >
                      <svg
                        width="10"
                        height="10"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                      >
                        <path d="M18 6L6 18M6 6l12 12" />
                      </svg>
                    </button>
                  </span>
                ))}
              </div>
            </SettingsPanelRow>
          </SettingsPanel>
        ) : customDictionary.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border-subtle py-10 flex flex-col items-center justify-center text-center">
            <BookOpen size={32} className="text-muted-foreground/20 mb-3" />
            <p className="text-[12px] text-muted-foreground/50">No words added yet</p>
            <p className="text-[11px] text-muted-foreground/30 mt-1">
              Words you add will appear here
            </p>
          </div>
        ) : (
          <div className="rounded-xl border border-dashed border-border-subtle py-6 text-center">
            <p className="text-[12px] text-muted-foreground/50">No matches for "{searchFilter}"</p>
          </div>
        )}
      </div>

      <div className="mb-8">
        <CorrectionMemoryPage embedded />
      </div>

      {/* How it works */}
      <div className="mt-8">
        <p className="text-[13px] font-medium text-foreground mb-3">How it works</p>
        <SettingsPanel>
          <SettingsPanelRow>
            <p className="text-[12px] text-muted-foreground leading-relaxed">
              Your words are handed to the transcription model before it starts, so it is more
              likely to land on your spelling. Afterwards the text is repaired locally for casing
              and accidental splits, so privatetranscribe becomes PrivateTranscribe and OpenC ode
              becomes OpenCode.
            </p>
          </SettingsPanelRow>
          <SettingsPanelRow>
            <p className="text-[12px] text-muted-foreground leading-relaxed">
              <span className="font-medium text-foreground">
                If a word comes out as something else entirely
              </span>{" "}
              the dictionary cannot fix it, because the repair only corrects words that were already
              heard right. Add the pair under Correction Memory above instead.
            </p>
          </SettingsPanelRow>
          <SettingsPanelRow>
            <p className="text-[12px] text-muted-foreground leading-relaxed">
              <span className="font-medium text-foreground">Local Parakeet</span> does not accept
              hints, so it never sees your words up front. The casing and split repair still runs.
            </p>
          </SettingsPanelRow>
        </SettingsPanel>
      </div>
    </div>
  );
}
