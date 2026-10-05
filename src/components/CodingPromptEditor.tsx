import { useState } from "react";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import { SettingsDisclosure } from "./ui/SettingsDisclosure";
import {
  CODING_PROMPT_STORAGE_KEY,
  DEFAULT_CODING_PROMPT,
  getCodingPrompt,
} from "../config/codingPrompt";

export function CodingPromptEditor() {
  const [saved, setSaved] = useState(getCodingPrompt);
  const [draft, setDraft] = useState(saved);
  const [feedback, setFeedback] = useState("");
  const [storageError, setStorageError] = useState("");

  const save = (reset = false) => {
    const value = reset ? DEFAULT_CODING_PROMPT : draft;
    try {
      if (reset) localStorage.removeItem(CODING_PROMPT_STORAGE_KEY);
      else localStorage.setItem(CODING_PROMPT_STORAGE_KEY, JSON.stringify(value));
      setSaved(value);
      setDraft(value);
      setStorageError("");
      setFeedback(reset ? "Default coding instructions restored." : "Coding instructions saved.");
    } catch {
      setFeedback("");
      setStorageError("Could not save your instructions. Try again.");
    }
  };

  return (
    <SettingsDisclosure
      title="Coding prompt instructions"
      description="Edit how your words are cleaned up."
      status={saved === DEFAULT_CODING_PROMPT ? "Default" : "Custom"}
    >
      <div className="space-y-3">
        <label htmlFor="coding-prompt-instructions" className="text-xs text-muted-foreground block">
          Used only for the Coding prompt style. Save, then try your text below.
        </label>
        <Textarea
          id="coding-prompt-instructions"
          aria-label="Coding prompt instructions"
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            setFeedback("");
            setStorageError("");
          }}
          rows={12}
          className="text-xs leading-relaxed"
        />
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" onClick={() => save()} disabled={!draft.trim() || draft === saved}>
            Save coding instructions
          </Button>
          <Button size="sm" variant="outline" onClick={() => save(true)}>
            Restore default
          </Button>
          <span role="status" className="text-xs text-muted-foreground">
            {feedback || (draft !== saved ? "Unsaved changes" : "")}
          </span>
        </div>
        {storageError && (
          <p role="alert" className="text-xs text-destructive">
            {storageError}
          </p>
        )}
      </div>
    </SettingsDisclosure>
  );
}
