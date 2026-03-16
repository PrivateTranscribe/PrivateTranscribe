/**
 * languageCompat.ts
 *
 * Pure utilities for checking language compatibility against transcription
 * model capabilities. All logic is centralised here so it can be shared
 * between the UI (settings warnings) and the runtime (audioManager fallback).
 *
 * Whisper supports ~99 languages — no restriction is applied.
 * Parakeet supports a fixed set of 25 languages defined in modelRegistryData.json.
 */

import { getParakeetModelInfo } from "../models/ModelRegistry";
import logger from "./logger";

export type TranscriptionModelType = "whisper" | "parakeet";

/**
 * Returns the set of BCP-47 language codes supported by the given model,
 * or `null` if the model has no language restriction (i.e. supports everything).
 *
 * @param modelType - "whisper" or "parakeet"
 * @param modelId   - Optional model identifier (used for Parakeet to look up
 *                    the specific model's supportedLanguages list)
 */
export function getModelSupportedLanguages(
    modelType: TranscriptionModelType,
    modelId?: string
): readonly string[] | null {
    if (modelType === "whisper") {
        // Whisper (all variants) supports ~99 languages — no restriction.
        return null;
    }

    if (modelType === "parakeet") {
        const info = modelId ? getParakeetModelInfo(modelId) : undefined;
        const langs = info?.supportedLanguages;
        if (langs && langs.length > 0) {
            return langs;
        }
        // If the model info is missing, default to English-only as a safe fallback.
        return ["en"];
    }

    return null;
}

/**
 * Returns true if the given language code is supported by the model.
 *
 * "auto" is always considered supported — it means the model should detect
 * the language itself, which every model supports.
 *
 * @param language  - BCP-47 code (e.g. "en", "de") or "auto"
 * @param modelType - "whisper" or "parakeet"
 * @param modelId   - Optional; used by Parakeet to look up the specific model
 */
export function isLanguageSupported(
    language: string,
    modelType: TranscriptionModelType,
    modelId?: string
): boolean {
    if (!language || language === "auto") return true;

    const supported = getModelSupportedLanguages(modelType, modelId);
    if (supported === null) return true; // no restriction

    return supported.includes(language);
}

/**
 * Resolves the effective language to send to the transcription backend.
 *
 * If the requested language is not supported by the model, this function
 * logs a console warning and returns `null`, signalling that the caller
 * should use auto-detect (i.e. omit the language parameter entirely).
 *
 * @param language  - The user's preferred language ("auto", a BCP-47 code, or null/undefined)
 * @param modelType - "whisper" or "parakeet"
 * @param modelId   - Optional; used by Parakeet to look up the specific model
 * @returns The resolved language code to use, or `null` for auto-detect
 */
export function resolveTranscriptionLanguage(
    language: string | null | undefined,
    modelType: TranscriptionModelType,
    modelId?: string
): string | null {
    if (!language || language === "auto") return null;

    if (!isLanguageSupported(language, modelType, modelId)) {
        const modelLabel = modelId ? `${modelType} model "${modelId}"` : modelType;
        const supportedList =
            getModelSupportedLanguages(modelType, modelId)?.join(", ") ?? "all";
        logger.warn(
            `Language "${language}" not supported by ${modelLabel}; falling back to auto-detect`,
            { language, modelType, modelId: modelId ?? null, supportedLanguages: supportedList },
            "transcription"
        );
        return null;
    }

    logger.debug(
        "Language resolved for transcription",
        { language, modelType, modelId: modelId ?? null },
        "transcription"
    );
    return language;
}
