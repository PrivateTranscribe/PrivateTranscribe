const words = new Intl.Segmenter(undefined, { granularity: "word" });

/** Count words rather than spaces so a full Japanese sentence isn't "one word". */
export function isShortDictation(text: string): boolean {
  let count = 0;
  for (const segment of words.segment(text)) {
    if (segment.isWordLike && ++count > 2) return false;
  }
  return count > 0;
}
