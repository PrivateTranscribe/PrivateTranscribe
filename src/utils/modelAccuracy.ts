/**
 * modelAccuracy.ts
 *
 * Accuracy and speed ratings for the local Whisper models, as shown on the
 * model cards.
 *
 * These used to be a single language-blind number, which told a Danish user
 * that Base was a middling choice when it actually gets most of their words
 * wrong. The ratings are now split by language, because the gap between
 * models is far wider outside English than inside it.
 *
 * Measured on FLEURS, 100 utterances per language (reproduce with
 * scripts/benchmark-transcription-accuracy.js):
 *
 *   model    English WER   Danish WER
 *   large        6.5%        14.5%
 *   turbo        6.9%        15.4%
 *   medium       6.7%        24.4%
 *   small        8.1%        37.5%
 *   base        12.2%        62.8%
 *
 * The meter is absolute, not relative to the best model available in that
 * language. Every bar dropping when you switch away from English is the
 * intended reading: the best non-English result is still worse than a
 * mid-tier English one.
 */

export type PerfRating = { speed: number; quality: number };

/**
 * Speed is 1-5 and language-independent.
 *
 * `quality` is the English rating and stays the hand-tuned scale that
 * predates the benchmark. It is deliberately not re-derived from the FLEURS
 * numbers above: that run is clean read speech, and small models degrade
 * further on noisy real-world dictation than a single clean benchmark shows.
 *
 * `qualityNonEnglish` is measured. The Danish cliff is large enough and
 * consistent enough that leaving the optimistic English number in place was
 * actively misleading.
 */
const WHISPER_PERF_RATINGS: Record<
  string,
  { speed: number; quality: number; qualityNonEnglish: number }
> = {
  tiny: { speed: 5, quality: 1, qualityNonEnglish: 1 },
  base: { speed: 4, quality: 2, qualityNonEnglish: 1 },
  small: { speed: 3, quality: 3, qualityNonEnglish: 1 },
  medium: { speed: 2, quality: 4, qualityNonEnglish: 2 },
  large: { speed: 1, quality: 5, qualityNonEnglish: 4 },
  turbo: { speed: 4, quality: 4, qualityNonEnglish: 4 },
};

/**
 * True when we know the user dictates in something other than English.
 *
 * "auto" counts as unknown rather than non-English. We cannot show a language
 * specific rating for a language we have not been told, so auto keeps the
 * general scale; onboarding is where users are asked to pin it.
 */
export function isKnownNonEnglishLanguage(preferredLanguage: string | null | undefined): boolean {
  if (!preferredLanguage) return false;
  const normalized = preferredLanguage.trim().toLowerCase();
  if (!normalized || normalized === "auto") return false;
  // Accept regional tags such as "en-GB" as English.
  return normalized.split("-")[0] !== "en";
}

/**
 * Rating to display for a model, given the language the user dictates in.
 * Returns undefined for models with no rating, so the card omits the meters
 * rather than inventing a value.
 */
export function getWhisperPerfRating(
  modelId: string,
  preferredLanguage?: string | null
): PerfRating | undefined {
  const rating = WHISPER_PERF_RATINGS[modelId];
  if (!rating) return undefined;

  return {
    speed: rating.speed,
    quality: isKnownNonEnglishLanguage(preferredLanguage)
      ? rating.qualityNonEnglish
      : rating.quality,
  };
}

/**
 * The language a model's accuracy should be judged against.
 *
 * A user who speaks Danish and English sits on `preferredLanguage: "auto"`,
 * because there are two languages to detect between. Rating their models as
 * "unknown language" would hide exactly the warning they need — the Danish
 * cliff is what decides whether Base is usable for them at all. Their hardest
 * language is the honest one to rate against, so the first non-English entry
 * in the spoken set wins.
 */
export function resolveRatingLanguage(
  preferredLanguage: string | null | undefined,
  spokenLanguages?: string[] | null
): string | null {
  if (isKnownNonEnglishLanguage(preferredLanguage)) return preferredLanguage ?? null;

  const nonEnglish = (spokenLanguages ?? []).find((code) => isKnownNonEnglishLanguage(code));
  if (nonEnglish) return nonEnglish;

  return preferredLanguage ?? null;
}

/**
 * Models that fall off a cliff outside English, worth warning about when
 * paired with a non-English language. Derived from the same measurements:
 * everything below the turbo/large tier at least doubles the error rate.
 */
export const WEAK_NON_ENGLISH_MODELS = ["tiny", "base", "small", "medium"] as const;

export function isWeakForNonEnglish(modelId: string, preferredLanguage?: string | null): boolean {
  if (!isKnownNonEnglishLanguage(preferredLanguage)) return false;
  return (WEAK_NON_ENGLISH_MODELS as readonly string[]).includes(modelId);
}
