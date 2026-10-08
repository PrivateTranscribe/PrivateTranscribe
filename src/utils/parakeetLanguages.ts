/**
 * parakeetLanguages.ts
 *
 * Pure rules for whether Parakeet suits this PC and this user, shared by setup,
 * the Dictation page picker and the one-time offer card.
 */

import { getParakeetModelInfo } from "../models/ModelRegistry";
import { getLanguageLabel } from "./languages";
import type { HardwareRecommendations } from "../types/electron";

export const PARAKEET_MODEL_ID = "parakeet-tdt-0.6b-v3";

/** The archive is 487 MB; the registry's sizeMb is the unpacked size on disk. */
export const PARAKEET_DOWNLOAD_MB = 487;

export const PARAKEET_LANGUAGES: readonly string[] =
  getParakeetModelInfo(PARAKEET_MODEL_ID)?.supportedLanguages ?? [];

/** "da-DK" -> "da". Returns "" for anything without a language part. */
export function baseLanguage(locale: string | null | undefined): string {
  if (typeof locale !== "string") return "";
  return locale.trim().toLowerCase().split(/[-_]/)[0] || "";
}

/**
 * The languages Parakeet has to cover. An empty spoken set means auto-detect,
 * so the UI locale's language stands in: it is the best guess at what this
 * user speaks when they have not said.
 */
export function languagesToCheck(
  spokenLanguages: readonly string[],
  uiLocale: string | null | undefined
): { codes: string[]; fromLocale: boolean } {
  const spoken = spokenLanguages.map(baseLanguage).filter(Boolean);
  if (spoken.length > 0) return { codes: [...new Set(spoken)], fromLocale: false };
  const locale = baseLanguage(uiLocale);
  return { codes: locale ? [locale] : [], fromLocale: true };
}

/** Languages from the list Parakeet was not trained on. */
export function unsupportedParakeetLanguages(codes: readonly string[]): string[] {
  return codes.filter((code) => !PARAKEET_LANGUAGES.includes(code));
}

export interface ParakeetFit {
  /** Cores, AVX2 and memory pass. Without this Parakeet cannot be picked. */
  hardwareEligible: boolean;
  hardwareReasons: string[];
  /** NVIDIA CUDA PCs run Whisper on the GPU, so Parakeet is never their default. */
  isCudaPc: boolean;
  unsupportedLanguages: string[];
  languagesFromLocale: boolean;
  /** Passes every check, so Parakeet is the default or the one-time offer. */
  qualifies: boolean;
}

export function evaluateParakeetFit(
  recommendations: HardwareRecommendations | null | undefined,
  spokenLanguages: readonly string[],
  uiLocale: string | null | undefined
): ParakeetFit {
  const hardware = recommendations?.parakeetHardware;
  const hardwareEligible = hardware?.eligible === true;
  const isCudaPc = recommendations?.gpuCategory === "nvidia_cuda";
  const { codes, fromLocale } = languagesToCheck(spokenLanguages, uiLocale);
  const unsupportedLanguages = unsupportedParakeetLanguages(codes);
  return {
    hardwareEligible,
    hardwareReasons: hardware?.reasons ?? [],
    isCudaPc,
    unsupportedLanguages,
    languagesFromLocale: fromLocale,
    qualifies: hardwareEligible && !isCudaPc && unsupportedLanguages.length === 0,
  };
}

/** "Japanese", "Japanese and Korean", "Japanese, Korean and Thai". */
export function joinLanguageNames(codes: readonly string[]): string {
  const names = codes.map((code) => getLanguageLabel(code));
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export function describeUnsupportedLanguages(fit: ParakeetFit): string | null {
  if (fit.unsupportedLanguages.length === 0) return null;
  const names = joinLanguageNames(fit.unsupportedLanguages);
  return fit.languagesFromLocale
    ? `Parakeet does not support ${names}, the language this PC is set to. Whisper does.`
    : `Parakeet does not support ${names}. Whisper does.`;
}

export interface SpeedTestOutcome {
  success: boolean;
  decodeMs?: number;
  audioSec?: number;
  passed?: boolean;
}

/** Keep Parakeet only on a completed test that met the bar; anything else is Whisper. */
export function speedTestKeepsParakeet(result: SpeedTestOutcome | null | undefined): boolean {
  return Boolean(result?.success && result.passed === true);
}

function formatSeconds(seconds: number): string {
  const rounded = seconds >= 10 ? Math.round(seconds) : Math.round(seconds * 10) / 10;
  return String(rounded === 0 && seconds > 0 ? 0.1 : rounded);
}

/** "10 s of speech in 0.2 s on this PC" */
export function formatSpeedTestResult(result: SpeedTestOutcome | null | undefined): string | null {
  if (!result?.success || typeof result.decodeMs !== "number") return null;
  const audio = typeof result.audioSec === "number" ? result.audioSec : 10;
  return `${formatSeconds(audio)} s of speech in ${formatSeconds(result.decodeMs / 1000)} s on this PC`;
}
