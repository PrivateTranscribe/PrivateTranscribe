// A word is a run of letters or digits in any script; an apostrophe or hyphen
// between two such runs keeps them one word ("don't", "e-mail").
export function countWords(text) {
  if (typeof text !== "string") return 0;
  const matches = text.trim().match(/[\p{L}\p{N}]+(?:[’'\-][\p{L}\p{N}]+)*/gu);
  return matches ? matches.length : 0;
}
