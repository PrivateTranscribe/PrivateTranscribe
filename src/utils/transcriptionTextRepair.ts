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

function looksLikeAccidentalInternalSplit(value: string): boolean {
  if (!/\s/.test(value)) return false;

  // Do not collapse ordinary all-lowercase phrases like "open code" just because
  // the custom dictionary contains a CamelCase term. This repair is only for
  // odd STT fragments such as "OpenC ode" where the model appears to have split
  // a single known term internally.
  return /[A-ZÆØÅ]/.test(value);
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
      looksLikeAccidentalInternalSplit(match) ? compact : match
    );
  }

  return repaired;
}
