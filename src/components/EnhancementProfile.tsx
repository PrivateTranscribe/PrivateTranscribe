import {
  getWritingStyle,
  PROMPT_PROFILE_KEY,
  WRITING_STYLE_KEY,
  savePromptPreference,
  type PromptProfile,
} from "../config/promptProfiles";
import { usePromptProfile } from "../hooks/usePromptProfile";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Textarea } from "./ui/textarea";
import { SettingsDisclosure } from "./ui/SettingsDisclosure";

export function EnhancementProfile() {
  const { profile } = usePromptProfile();
  return (
    <section
      className="rounded-xl border border-border bg-card p-5 space-y-3"
      aria-labelledby="prompt-profile-title"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="prompt-profile-title" className="text-sm font-semibold text-foreground">
          Dictation prompt
        </h2>
        <Select
          value={profile}
          onValueChange={(value) =>
            savePromptPreference(PROMPT_PROFILE_KEY, value as PromptProfile)
          }
        >
          <SelectTrigger aria-label="Dictation prompt" className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="current">Current prompt</SelectItem>
            <SelectItem value="experimental">Experimental prompt</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <p className="text-xs text-muted-foreground">
        {profile === "current"
          ? "Uses your existing prompt, including any saved customizations."
          : "Keeps one or two words as spoken. For longer text, clarifies messages for an agent and marks suspect wording as [check: word]. Markers can miss errors or flag correct words."}
      </p>
      <SettingsDisclosure
        title="Writing style"
        description="Optional preferences for the experimental prompt only."
      >
        <Textarea
          aria-label="Experimental writing style"
          placeholder="For example: use short sentences and ordinary words. Keep my tone casual."
          rows={3}
          maxLength={2000}
          value={getWritingStyle()}
          onChange={(event) => savePromptPreference(WRITING_STYLE_KEY, event.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          Saved on this PC and included when the experimental prompt runs with your chosen provider.
          The current prompt stays unchanged.
        </p>
      </SettingsDisclosure>
    </section>
  );
}
