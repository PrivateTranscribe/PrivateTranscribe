import promptData from "./promptData.json";

export type PromptProfile = "current" | "experimental";
export const PROMPT_PROFILE_KEY = "enhancementPromptProfile";
export const WRITING_STYLE_KEY = "enhancementWritingStyle";
export const EXPERIMENTAL_PROMPT_KEY = "experimentalUnifiedPrompt";
export const PROMPT_CHANGE_EVENT = "privatetranscribe-prompt-change";

// Keep the existing prompt intact as the comparison baseline. The experiment
// replaces only the filler-only rule that conflicts with short dictation.
export const EXPERIMENTAL_SYSTEM_PROMPT =
  promptData.UNIFIED_SYSTEM_PROMPT.replace(
    "Empty or filler-only input produces empty output.",
    "Empty input produces empty output."
  ) +
  `

EXPERIMENTAL EDITING PROFILE - apply these specific rules when they refine the cleanup rules above:

SHORT DICTATION:
One or two words are valid dictation, including a name, number, acknowledgement, or sentence fragment. Preserve them even when they could be fillers in a longer sentence. "Okay", "Thank you", "Not yet", "year", and "Maren" must survive. Keep a short input short; output its words with only clear spelling or punctuation corrections. Never discard it for lacking context or a complete sentence.

CLEAR MESSAGES FOR AN AGENT:
Lead with the speaker's main request or question, then group related details they supplied. Preserve whether they are exploring an idea, asking for advice, or requesting action. "Maybe we should try profiles" remains a suggestion, not an instruction to implement them. Preserve unresolved choices and references to earlier conversation. Leave missing project context for the receiving agent to resolve. Use plain, direct language and natural wording. Apply writing preferences only to expression, while preserving facts, intent, uncertainty, and technical details.

ENDINGS:
End with the speaker's last meaningful content. Remove trailing fillers or abandoned fragments in longer dictation only when they contribute no meaning. Preserve meaningful qualifications and intentional greetings or closings. Every output statement must be supported by the transcript; leave unfinished thoughts unfinished. Add no sign-off or continuation that the speaker did not supply. A disconnected trailing word is not automatically an error.

REVIEW MARKERS:
Correct a transcription error normally only when the intended wording is clear. When the surrounding text gives concrete evidence of a transcription error but no clear replacement, preserve the exact suspect wording inside [check: original wording]. Mark only the smallest affected span. Unfamiliar names, technical terms, unusual opinions, short fragments, and the speaker's own uncertainty are not evidence of an error. Use [unclear] only for an explicitly indicated missing word, never to invent a gap. Preserve existing [check: ...], [unclear], and [... missing section ...] markers. These are review suggestions, not verified errors. Output only the edited text with any necessary inline markers.`;

function read(key: string): string | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function getPromptProfile(): PromptProfile {
  return read(PROMPT_PROFILE_KEY) === "experimental" ? "experimental" : "current";
}

export function getWritingStyle(): string {
  return read(WRITING_STYLE_KEY) || "";
}

export function getPromptStorageKey(profile: PromptProfile): string {
  return profile === "experimental" ? EXPERIMENTAL_PROMPT_KEY : "customUnifiedPrompt";
}

export function getDefaultProfilePrompt(profile: PromptProfile): string {
  return profile === "experimental" ? EXPERIMENTAL_SYSTEM_PROMPT : promptData.UNIFIED_SYSTEM_PROMPT;
}

export function getProfilePrompt(profile: PromptProfile = getPromptProfile()): string {
  try {
    // Legacy prompts still work before PromptStudio has ever been opened.
    const saved = read(getPromptStorageKey(profile));
    const parsed = saved ? JSON.parse(saved) : null;
    if (typeof parsed === "string" && parsed.trim()) return parsed;
    if (profile === "current" && !saved) {
      const legacy = JSON.parse(read("customPrompts") || "null");
      if (typeof legacy?.agent === "string" && legacy.agent.trim()) return legacy.agent;
    }
  } catch {
    // Malformed saved preferences fall back to the built-in profile.
  }
  return getDefaultProfilePrompt(profile);
}

export function getProfileTemplate(profile: PromptProfile = getPromptProfile()): string {
  return withWritingStyle(getProfilePrompt(profile), profile);
}

export function withWritingStyle(prompt: string, profile: PromptProfile): string {
  const style = getWritingStyle().trim();
  return profile === "experimental" && style
    ? `${prompt}\n\nWRITING PREFERENCES (expression only; preserve the transcript's meaning and intent):\n${style}`
    : prompt;
}

export function savePromptPreference(key: string, value: string | null) {
  if (value === null) window.localStorage.removeItem(key);
  else window.localStorage.setItem(key, value);
  window.dispatchEvent(new Event(PROMPT_CHANGE_EVENT));
}
