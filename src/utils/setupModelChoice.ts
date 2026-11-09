/**
 * The Whisper model setup recommends, from the engine it will run on and the
 * language the user speaks.
 *
 * The hardware detector picks by hardware alone, which hands a Danish speaker
 * on a CPU-only laptop Whisper Base: quick, and wrong on most Danish words
 * (62.8% WER against Turbo's 15.4%, see modelAccuracy.ts). Setup asks for the
 * spoken languages after the hardware step, so the pick is redone here once
 * the language is known, and again if the GPU engine fails and setup falls
 * back to the processor.
 *
 * Parakeet is decided before this runs (useParakeetSetup): when it qualifies
 * for the PC and every spoken language, it wins on the CPU and this is not
 * consulted.
 */

import { isKnownNonEnglishLanguage, isWeakForNonEnglish } from "./modelAccuracy";
import { getLanguageLabel } from "./languages";

export type SetupEngine = "gpu" | "cpu";

export interface SetupModelInput {
  engine: SetupEngine;
  /** The hardware detector's pick, made for the engine it expected. */
  detectorModel: string;
  /** Logical processor count (os.cpus().length). */
  cpuThreads: number | null;
  /** Graphics memory in MB; 0 or null when unknown. */
  vramMb: number | null;
  /** The language to judge accuracy against (resolveRatingLanguage). */
  ratingLanguage: string | null;
}

export interface SetupModelChoice {
  model: string;
  /** One plain sentence for setup: why this model, and what it costs here. */
  reason: string;
  /** True when the model is slow on this engine and the user must be told. */
  slowOnThisEngine: boolean;
}

/** Models a processor runs at or slower than speech on a typical PC. */
export const HEAVY_ON_CPU = ["turbo", "large", "medium"] as const;

export function isHeavyOnCpu(model: string): boolean {
  return (HEAVY_ON_CPU as readonly string[]).includes(model);
}

/** The detector's processor rule, for when setup falls back from the GPU. */
export function cpuModelForThreads(cpuThreads: number | null): string {
  const threads = cpuThreads ?? 0;
  if (threads >= 16) return "small";
  if (threads >= 4) return "base";
  if (threads > 0) return "tiny";
  return "base";
}

const MODEL_NAMES: Record<string, string> = {
  tiny: "Tiny",
  base: "Base",
  small: "Small",
  medium: "Medium",
  turbo: "Turbo",
  large: "Large",
};

export const modelDisplayName = (model: string) => MODEL_NAMES[model] ?? model;

export function pickSetupWhisperModel(input: SetupModelInput): SetupModelChoice {
  const { engine, detectorModel, cpuThreads, vramMb, ratingLanguage } = input;
  const nonEnglish = isKnownNonEnglishLanguage(ratingLanguage);
  const languageName = nonEnglish ? getLanguageLabel(ratingLanguage ?? "") : "";

  if (engine === "gpu") {
    // The detector shrinks the model for cards under 6 GB. Turbo still fits a
    // 4 GB card, and below Turbo a non-English language falls apart.
    const vram = vramMb ?? 0;
    if (
      nonEnglish &&
      isWeakForNonEnglish(detectorModel, ratingLanguage) &&
      (vram === 0 || vram >= 4096)
    ) {
      return {
        model: "turbo",
        reason: `Whisper Turbo on your graphics card. The smaller models get most ${languageName} words wrong.`,
        slowOnThisEngine: false,
      };
    }
    return {
      model: detectorModel,
      reason: `Whisper ${modelDisplayName(detectorModel)} on your graphics card.`,
      slowOnThisEngine: false,
    };
  }

  if (nonEnglish) {
    return {
      model: "turbo",
      reason: `Whisper Turbo, because it is the smallest model that gets ${languageName} mostly right. On the processor it is slow: expect a wait after each dictation, often as long as you spoke or longer. Base answers in a second or two but gets most ${languageName} words wrong.`,
      slowOnThisEngine: true,
    };
  }

  const model = isHeavyOnCpu(detectorModel) ? cpuModelForThreads(cpuThreads) : detectorModel;
  return {
    model,
    reason: `Whisper ${modelDisplayName(model)}, sized for your processor so dictation comes back in a second or two.`,
    slowOnThisEngine: false,
  };
}

/** What setup says when the user picks a model the processor runs slowly. */
export function describeSlowCpuModel(model: string): string {
  return `Whisper ${modelDisplayName(model)} on the processor is slow: expect a wait after each dictation, often as long as you spoke or longer. A graphics card, or a smaller model, answers much faster.`;
}
