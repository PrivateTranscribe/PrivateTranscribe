/**
 * Builds the term list handed to Whisper as `initial_prompt`.
 *
 * Whisper's prompt is a context prefix, not an instruction. The model conditions
 * on the tokens it sees; it does not obey phrasing like "use these exact
 * spellings". Instruction filler only burns the ~224-token prompt budget and can
 * leak into the transcript on short or near-silent audio, so we send the bare
 * terms and nothing else.
 *
 * Casing and split-word repair happens after transcription for every term, and
 * genuine mishearings are handled by Correction Memory, not by prompt wording.
 */
export function buildDictionaryPrompt(words: string[] | null | undefined): string | null {
  const terms = Array.from(
    new Set(
      (words || [])
        .filter((word): word is string => typeof word === "string")
        .map((word) => word.trim())
        .filter(Boolean)
    )
  );

  return terms.length ? terms.join(", ") : null;
}
