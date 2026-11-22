/**
 * The English-only speaker-turn model the Transcribe page uses for files with
 * speaker labels. It is no dictation model: the dictation picker hides it and
 * the Parakeet fallback skips it.
 */
export const SPEAKER_TURN_WHISPER_MODEL = "small-en-tdrz";

export function isDictationWhisperModel(modelId: string | null | undefined): boolean {
  return Boolean(modelId) && modelId !== SPEAKER_TURN_WHISPER_MODEL;
}

/**
 * The model dictation switches to when the selected one is no longer on disk,
 * for example after the user deleted it.
 *
 * @returns undefined to keep the current selection, "" for no model, or the id
 *   of the first downloaded dictation model
 */
export function pickReplacementWhisperModel(
  models: Array<{ model: string; downloaded?: boolean }>,
  current: string
): string | undefined {
  if (models.find((m) => m.model === current)?.downloaded) return undefined;
  const replacement = models.find((m) => m.downloaded && isDictationWhisperModel(m.model));
  return replacement ? replacement.model : "";
}
