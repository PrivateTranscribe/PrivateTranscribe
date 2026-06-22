export const DICTIONARY_ENTRY_MODES = ["hint", "exact", "priority"] as const;

export type DictionaryEntryMode = (typeof DICTIONARY_ENTRY_MODES)[number];
export type DictionaryEntryModeMap = Record<string, DictionaryEntryMode>;

export const DEFAULT_DICTIONARY_ENTRY_MODE: DictionaryEntryMode = "exact";

export function isDictionaryEntryMode(value: unknown): value is DictionaryEntryMode {
  return typeof value === "string" && DICTIONARY_ENTRY_MODES.includes(value as DictionaryEntryMode);
}

export function getDictionaryEntryMode(
  modes: DictionaryEntryModeMap | null | undefined,
  word: string
): DictionaryEntryMode {
  const mode = modes?.[word];
  return isDictionaryEntryMode(mode) ? mode : DEFAULT_DICTIONARY_ENTRY_MODE;
}

export function parseDictionaryEntryModes(raw: string | null): DictionaryEntryModeMap {
  try {
    const parsed = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, DictionaryEntryMode] =>
        isDictionaryEntryMode(entry[1])
      )
    );
  } catch {
    return {};
  }
}

export function pruneDictionaryEntryModes(
  modes: DictionaryEntryModeMap,
  words: string[]
): DictionaryEntryModeMap {
  const wordSet = new Set(words);
  return Object.fromEntries(Object.entries(modes).filter(([word]) => wordSet.has(word)));
}

export function buildDictionaryPrompt(
  words: string[],
  modes: DictionaryEntryModeMap | null | undefined = {}
): string | null {
  const groups: Record<DictionaryEntryMode, string[]> = {
    hint: [],
    exact: [],
    priority: [],
  };

  for (const word of words) {
    if (!word || typeof word !== "string") continue;
    groups[getDictionaryEntryMode(modes, word)].push(word);
  }

  const parts = [];
  if (groups.hint.length) parts.push(`Vocabulary hints: ${groups.hint.join(", ")}`);
  if (groups.exact.length) {
    parts.push(`Use these exact spellings when they appear: ${groups.exact.join(", ")}`);
  }
  if (groups.priority.length) {
    const terms = groups.priority.join(", ");
    parts.push(
      `Priority exact spellings: ${terms}. Prefer these spellings over similar words: ${terms}`
    );
  }

  return parts.length ? parts.join(". ") : null;
}

export function getDictionaryRepairTerms(
  words: string[],
  modes: DictionaryEntryModeMap | null | undefined = {}
): string[] {
  return words.filter((word) => getDictionaryEntryMode(modes, word) !== "hint");
}
