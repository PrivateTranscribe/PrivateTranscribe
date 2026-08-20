/**
 * spokenLanguages.ts
 *
 * The set of languages the user actually speaks, and the rules that turn it
 * into the two things the rest of the app consumes.
 *
 * Two settings work together, and keeping them distinct is what lets the whole
 * feature exist without a mode switch:
 *
 *   `spokenLanguages`   - the languages this user speaks. A stable fact about
 *                         the person, set once during onboarding.
 *   `preferredLanguage` - what to do on the next dictation: a specific code
 *                         means "decode as this, do not detect", and "auto"
 *                         means "detect, but only from the spoken set".
 *
 * Every existing reader of `preferredLanguage` keeps working untouched: it
 * still holds either a language code or "auto", exactly as before. The spoken
 * set only adds the constraint that auto-detect now has a shortlist.
 */

import { LANGUAGE_OPTIONS } from "./languages";

export const SPOKEN_LANGUAGES_KEY = "spokenLanguages";

/**
 * Upper bound on the spoken set.
 *
 * Two reasons, both concrete: the overlay's quick-switch submenu can show
 * seven rows before it overflows the menu window, and a shortlist that covers
 * a third of Whisper's languages has stopped being a shortlist — the whole
 * point is to make close neighbours like Danish and Norwegian mutually
 * exclusive, which only works while the set stays small.
 */
export const MAX_SPOKEN_LANGUAGES = 5;

const KNOWN_LANGUAGE_CODES = new Set(
  LANGUAGE_OPTIONS.map((option) => option.value).filter((value) => value !== "auto")
);

/** True for a code the picker knows about. "auto" is a mode, not a language. */
export function isSelectableLanguage(code: unknown): code is string {
  return typeof code === "string" && KNOWN_LANGUAGE_CODES.has(code.trim().toLowerCase());
}

/**
 * Coerces anything that might have been stored under `spokenLanguages` into a
 * clean list: known codes only, no duplicates, no "auto", capped.
 *
 * Accepts the raw JSON string as well as an already-parsed array, because the
 * renderer reads this through useLocalStorage while audioManager and the
 * overlay read localStorage directly.
 */
export function normalizeSpokenLanguages(raw: unknown): string[] {
  let source: unknown = raw;

  if (typeof source === "string") {
    try {
      source = JSON.parse(source);
    } catch {
      // A bare code ("da") is a plausible hand-edit; treat it as a set of one.
      source = [source];
    }
  }

  if (!Array.isArray(source)) return [];

  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of source) {
    if (!isSelectableLanguage(entry)) continue;
    const code = entry.trim().toLowerCase();
    if (seen.has(code)) continue;
    seen.add(code);
    result.push(code);
    if (result.length >= MAX_SPOKEN_LANGUAGES) break;
  }
  return result;
}

/**
 * The `preferredLanguage` that should accompany a given spoken set.
 *
 * One language means there is nothing to detect, so it is pinned explicitly —
 * that is the single biggest accuracy win available, and it costs the user
 * nothing because they already told us.
 *
 * Two or more always means "auto", which is now constrained to the set and so
 * can no longer answer with a language the user does not speak.
 *
 * This deliberately does NOT preserve an existing pin that happens to be in
 * the new set. It used to, on the reasoning that a deliberate choice should
 * survive. In practice the pin is not deliberate at all: choosing one language
 * sets it, so the ordinary path of picking Danish and then adding English kept
 * everything pinned to Danish and transcribed English speech as Danish, while
 * the screen said it was detecting between the two. Naming a second language
 * means "detect between them" and nothing else.
 *
 * Pinning one of your languages for a single session is still available, from
 * the overlay's quick-switch menu, where it is an explicit act with a toast
 * rather than a silent side effect of editing this list.
 */
export function derivePreferredLanguage(
  spokenLanguages: string[],
  currentPreferred?: string | null
): string {
  const normalized = normalizeSpokenLanguages(spokenLanguages);
  if (normalized.length === 0) return currentPreferred || "auto";
  if (normalized.length === 1) return normalized[0];
  return "auto";
}

/**
 * The effective spoken set, given what is stored and the language already in
 * use.
 *
 * An install that predates this setting has an empty set and a
 * `preferredLanguage` the user chose deliberately. Reading that as "no
 * languages named" would both drop the constraint and show them an empty
 * picker for a question they already answered, so the existing choice stands
 * in as a set of one until they say otherwise.
 *
 * Every reader goes through here so the UI and the decoder can never disagree
 * about which languages are in play.
 */
export function resolveSpokenLanguages(
  stored: unknown,
  preferredLanguage?: string | null
): string[] {
  const normalized = normalizeSpokenLanguages(stored);
  if (normalized.length > 0) return normalized;
  return isSelectableLanguage(preferredLanguage) ? [preferredLanguage.trim().toLowerCase()] : [];
}

/** Reads the effective spoken set from localStorage, for callers with no hook. */
export function readSpokenLanguages(): string[] {
  if (typeof localStorage === "undefined") return [];

  try {
    return resolveSpokenLanguages(
      localStorage.getItem(SPOKEN_LANGUAGES_KEY),
      localStorage.getItem("preferredLanguage")
    );
  } catch {
    return [];
  }
}

/**
 * The ordered list for the overlay's quick-switch submenu: "Auto" first, then
 * the languages the user speaks.
 *
 * `currentLanguage` is included even when it is not in the spoken set, so a
 * one-off choice made from Settings stays visible (and reversible) in the menu
 * instead of disappearing the moment the menu reopens.
 */
export function buildQuickLanguageCodes(
  spokenLanguages: string[],
  currentLanguage?: string | null
): string[] {
  const normalized = normalizeSpokenLanguages(spokenLanguages);
  const codes = ["auto", ...normalized];
  if (isSelectableLanguage(currentLanguage) && !codes.includes(currentLanguage)) {
    codes.push(currentLanguage);
  }
  return codes;
}
