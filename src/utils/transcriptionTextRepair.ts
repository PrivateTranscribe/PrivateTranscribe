const MIN_TERM_LENGTH = 4;
const MAX_TERM_LENGTH = 80;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeTerm(value: string): string {
  return value.replace(/\s+/g, "").trim();
}

function shouldUseTerm(term: string): boolean {
  const compact = normalizeTerm(term);
  return compact.length >= MIN_TERM_LENGTH && compact.length <= MAX_TERM_LENGTH;
}

function buildPotentiallySpacedTermRegex(term: string): RegExp | null {
  const compact = normalizeTerm(term);
  if (!shouldUseTerm(compact)) return null;

  const chars = Array.from(compact).map(escapeRegex);
  return new RegExp(`(?<![\\p{L}\\p{N}])${chars.join("\\s*")}(?![\\p{L}\\p{N}])`, "giu");
}

/**
 * Whether a spaced match should be collapsed back into the dictionary term.
 *
 * A term the user capitalised is a name, and it has an ordinary lowercase twin
 * that has to survive: "OpenCode" in the dictionary must not rewrite the English
 * phrase "open code". A capital somewhere in the match is what separates the odd
 * STT fragment "OpenC ode" from that twin.
 *
 * A term the user wrote entirely in lowercase has no such twin to protect, and
 * demanding a capital made this repair unreachable for every language that
 * compounds in lowercase. Danish writes compounds as one word, and Whisper splits
 * them - measured at 5 per 2954 words against 0 in English - so "vildtreservat"
 * is precisely the case this function exists to fix. Adding the term is the
 * user's way of asking for it; removing the term is how they take it back.
 */
function looksLikeAccidentalInternalSplit(value: string, term: string): boolean {
  if (!/\s/.test(value)) return false;
  if (!/\p{Lu}/u.test(term)) return true;
  return /\p{Lu}/u.test(value);
}

export function repairSplitDictionaryTerms(text: string, terms: string[] = []): string {
  if (!text || !Array.isArray(terms) || terms.length === 0) return text;

  let repaired = text;
  const uniqueTerms = Array.from(
    new Map(
      terms
        .filter((term): term is string => typeof term === "string")
        .map((term) => [normalizeTerm(term).toLowerCase(), term.trim()] as const)
        .filter(([key, term]) => key && shouldUseTerm(term))
    ).values()
  ).sort((a, b) => normalizeTerm(b).length - normalizeTerm(a).length);

  for (const term of uniqueTerms) {
    const compact = normalizeTerm(term);
    const regex = buildPotentiallySpacedTermRegex(compact);
    if (!regex) continue;

    repaired = repaired.replace(regex, (match) =>
      looksLikeAccidentalInternalSplit(match, compact) ? compact : match
    );
  }

  return repaired;
}
