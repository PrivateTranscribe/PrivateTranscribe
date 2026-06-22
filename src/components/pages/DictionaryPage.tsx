import { useState, useCallback } from "react";
import { BookOpen } from "lucide-react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { useSettings } from "../../hooks/useSettings";
import { useDialogs } from "../../hooks/useDialogs";
import { ConfirmDialog } from "../ui/dialog";
import CorrectionMemoryPage from "./CorrectionMemoryPage";
import {
  DEFAULT_DICTIONARY_ENTRY_MODE,
  DICTIONARY_ENTRY_MODES,
  getDictionaryEntryMode,
  type DictionaryEntryMode,
} from "../../utils/dictionaryEntryModes";

const MODE_LABELS: Record<DictionaryEntryMode, string> = {
  hint: "Hint",
  exact: "Exact",
  priority: "Priority",
};

const MODE_DESCRIPTIONS: Record<DictionaryEntryMode, string> = {
  hint: "Prompt hint only.",
  exact: "Prompt hint plus exact spelling repair.",
  priority: "Extra prompt emphasis plus exact spelling repair.",
};

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
  const { customDictionary, dictionaryEntryModes, setCustomDictionary, setDictionaryEntryModes } =
    useSettings();
  const { confirmDialog, showConfirmDialog, hideConfirmDialog } = useDialogs();
  const [newWord, setNewWord] = useState("");
  const [newMode, setNewMode] = useState<DictionaryEntryMode>(DEFAULT_DICTIONARY_ENTRY_MODE);
  const [searchFilter, setSearchFilter] = useState("");

  const handleAdd = useCallback(() => {
    const word = newWord.trim();
    if (word && !customDictionary.includes(word)) {
      setCustomDictionary([...customDictionary, word]);
      setDictionaryEntryModes({ ...dictionaryEntryModes, [word]: newMode });
      setNewWord("");
    }
  }, [
    newWord,
    newMode,
    customDictionary,
    dictionaryEntryModes,
    setCustomDictionary,
    setDictionaryEntryModes,
  ]);

  const handleRemove = useCallback(
    (wordToRemove: string) => {
      setCustomDictionary(customDictionary.filter((w) => w !== wordToRemove));
    },
    [customDictionary, setCustomDictionary]
  );

  const handleModeChange = useCallback(
    (word: string, mode: DictionaryEntryMode) => {
      setDictionaryEntryModes({ ...dictionaryEntryModes, [word]: mode });
    },
    [dictionaryEntryModes, setDictionaryEntryModes]
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
          Tell the transcription pipeline which terms should be hinted, repaired, or emphasized.
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
                <Select
                  value={newMode}
                  onValueChange={(value) => setNewMode(value as DictionaryEntryMode)}
                >
                  <SelectTrigger className="h-9 w-[92px] px-2.5 text-[12px] border-border bg-background">
                    <SelectValue placeholder="Mode" />
                  </SelectTrigger>
                  <SelectContent>
                    {DICTIONARY_ENTRY_MODES.map((mode) => (
                      <SelectItem key={mode} value={mode} className="text-xs">
                        {MODE_LABELS[mode]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button onClick={handleAdd} disabled={!newWord.trim()} size="sm" className="h-9">
                  Add
                </Button>
              </div>
              <p className="text-[10px] text-muted-foreground/50">
                {MODE_DESCRIPTIONS[newMode]} Press Enter to add.
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
                    className="group inline-flex items-center gap-1 pl-2.5 pr-1.5 py-1 bg-primary/10 text-foreground rounded-md text-[12px] border border-border-subtle transition-all hover:border-destructive/40 hover:bg-destructive/5"
                  >
                    {word}
                    <Select
                      value={getDictionaryEntryMode(dictionaryEntryModes, word)}
                      onValueChange={(value) =>
                        handleModeChange(word, value as DictionaryEntryMode)
                      }
                    >
                      <SelectTrigger
                        className="ml-1 h-5 w-auto min-w-[56px] px-1.5 border-border-subtle bg-background/80 text-[10px] text-muted-foreground"
                        aria-label={
                          MODE_DESCRIPTIONS[getDictionaryEntryMode(dictionaryEntryModes, word)]
                        }
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {DICTIONARY_ENTRY_MODES.map((mode) => (
                          <SelectItem key={mode} value={mode} className="text-xs">
                            {MODE_LABELS[mode]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
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
      <div>
        <p className="text-[13px] font-medium text-foreground mb-3">How it works</p>
        <SettingsPanel>
          <SettingsPanelRow>
            <p className="text-[12px] text-muted-foreground leading-relaxed">
              Hint entries are sent only as transcription context. Exact entries also allow local
              casing and split-word repair. Priority entries add stronger prompt emphasis for terms
              Whisper keeps ignoring.
            </p>
          </SettingsPanelRow>
          <SettingsPanelRow>
            <p className="text-[12px] text-muted-foreground leading-relaxed">
              <span className="font-medium text-foreground">Tip</span> - Use Priority only for terms
              that are often wrong. It is still a model hint, not a hard speech-recognition rule.
            </p>
          </SettingsPanelRow>
        </SettingsPanel>
      </div>
    </div>
  );
}
