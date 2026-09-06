/**
 * Agent Mode fallback: turn a spoken ramble into a prompt for a coding agent
 * (Claude Code, Cursor, Codex) and report whether the speaker ended with "send".
 * Pure string rules, no model and no network. This is the fallback used when the
 * Claude Code rewrite is switched off, missing, or failed; when it answers, its
 * text is used instead of anything here.
 *
 * The filler and false-start rules that used to run first were removed on
 * purpose: Whisper already drops most hesitation and a coding agent does not
 * care about the rest, so the regexes only risked eating real content.
 *
 * Rule order, each step reading the previous step's output:
 *   1 formatCodeReferences -> 2 applySpokenKeys -> 3 extractSendCommand
 *   4 tidyPunctuation
 * Step 3 runs before step 4 so the send check sees the spoken tail instead of a
 * tail that step 4 has already terminated with a period.
 */

const WORD_START = "(?<![\\p{L}\\p{N}'’])";
const WORD_END = "(?![\\p{L}\\p{N}'’])";
const JOIN_TOKEN = "[\\p{L}\\p{N}_][\\p{L}\\p{N}_./:-]*";
const CLAUSE_START = "(^|[.!?][ \\t]*|\\n[ \\t]*)";
const MASK_OPEN = String.fromCharCode(0xe000);
const MASK_CLOSE = String.fromCharCode(0xe001);
const MAX_PASSES = 5;

const SPOKEN_SEPARATORS = ["colonColon", "slash", "dash", "underscore", "dot"];

// Words that never sit either side of a spoken "dot", "slash" or "dash". Without
// this, "the dot on the map" becomes "the.on".
const JOIN_STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "of",
  "in",
  "on",
  "at",
  "to",
  "is",
  "it",
  "its",
  "was",
  "be",
  "this",
  "that",
  "there",
  "then",
  "my",
  "your",
  "our",
  "we",
  "i",
  "you",
  "if",
  "so",
  "not",
  "for",
  "from",
  "with",
  "by",
  "as",
  "do",
  "did",
  "has",
  "have",
  "had",
  "can",
  "will",
  "all",
  "any",
  "one",
  "two",
  "more",
  "no",
  "up",
  "out",
  "his",
  "her",
  "they",
  "he",
  "she",
  "me",
  "us",
  "him",
  "them",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "how",
]);

// "underscore" and "colon colon" are only ever spoken as code, so they need a much
// shorter guard than "dot" or "slash" ("created underscore at" must reach created_at).
const DETERMINERS = new Set([
  "the",
  "a",
  "an",
  "this",
  "that",
  "these",
  "those",
  "each",
  "every",
  "any",
  "some",
  "no",
  "my",
  "your",
  "our",
  "its",
  "his",
  "her",
  "their",
]);

const CODE_NOUNS =
  "function|method|class|component|hook|variable|module|file|folder|directory|prop|field|" +
  "table|column|endpoint|route|flag|option|command|branch|package";

// Words that are describing the noun rather than naming it: "the broken function"
// must not become "the `broken` function".
const NAMED_REFERENCE_EXCLUSIONS = new Set([
  "new",
  "old",
  "same",
  "main",
  "whole",
  "entire",
  "first",
  "last",
  "next",
  "other",
  "test",
  "helper",
  "missing",
  "broken",
  "wrong",
  "right",
  "current",
  "existing",
  "each",
  "every",
  "that",
  "this",
  "which",
  "the",
  "a",
  "an",
  "my",
  "your",
  "our",
  "its",
  "his",
  "her",
  "their",
  "it",
  "they",
  "we",
  "you",
  "some",
  "any",
  "no",
  "one",
  "another",
  "both",
  "such",
  "actual",
  "default",
  "empty",
  "failing",
  "final",
  "flaky",
  "only",
  "original",
  "previous",
  "real",
  "second",
  "simple",
  "single",
  "slow",
  "third",
  "top",
  "bottom",
  "inner",
  "outer",
]);

const CODE_SPAN_RE = /`[^`]*`/gu;
const SEPARATOR_RE = {
  colonColon: new RegExp(
    `${WORD_START}(${JOIN_TOKEN})[ \\t]+colon[ \\t]+colon[ \\t]+(${JOIN_TOKEN})${WORD_END}`,
    "giu"
  ),
  slash: new RegExp(
    `${WORD_START}(${JOIN_TOKEN})[ \\t]+slash[ \\t]+(${JOIN_TOKEN})${WORD_END}`,
    "giu"
  ),
  dash: new RegExp(
    `${WORD_START}(${JOIN_TOKEN})[ \\t]+(?:dash|hyphen)[ \\t]+(${JOIN_TOKEN})${WORD_END}`,
    "giu"
  ),
  underscore: new RegExp(
    `${WORD_START}(${JOIN_TOKEN})[ \\t]+underscore[ \\t]+(${JOIN_TOKEN})${WORD_END}`,
    "giu"
  ),
  dot: new RegExp(`${WORD_START}(${JOIN_TOKEN})[ \\t]+dot[ \\t]+(${JOIN_TOKEN})${WORD_END}`, "giu"),
};
const SEPARATOR_GLUE = {
  colonColon: "::",
  slash: "/",
  dash: "-",
  underscore: "_",
  dot: ".",
};
const NAMED_REFERENCE_RE = new RegExp(
  `(?<![\`\\p{L}\\p{N}])(\\p{Ll}[\\p{L}\\p{N}_]*)([ \\t]+)(?:${CODE_NOUNS})${WORD_END}`,
  "gu"
);
// "add a newline character" and "a new line at the end" are content, not a keypress.
const SPOKEN_KEY_GUARD = "(?<!\\b(?:an|a|the|another|one|each|every|any|no)[ \\t])";
const PARAGRAPH_RE = new RegExp(
  `[ \\t]*[,.;:]?[ \\t]*${SPOKEN_KEY_GUARD}${WORD_START}new[ \\t]+paragraph${WORD_END}` +
    `[ \\t]*[,.;:]?[ \\t]*`,
  "giu"
);
const NEWLINE_RE = new RegExp(
  `[ \\t]*[,.;:]?[ \\t]*${SPOKEN_KEY_GUARD}${WORD_START}(?:new[ \\t]+line|newline)${WORD_END}` +
    `[ \\t]*[,.;:]?[ \\t]*`,
  "giu"
);
const SEND_TAIL_RE = new RegExp(
  `${WORD_START}(?:and[ \\t]+send|then[ \\t]+send|send[ \\t]+(?:it|now|that|this)|send)` +
    `[\\s.,!?;]*$`,
  "iu"
);
const DANGLING_CONJUNCTION_RE = new RegExp(`${WORD_START}(?:and|then)[\\s,]*$`, "iu");

function asString(value) {
  return typeof value === "string" ? value : "";
}

function collapseInlineSpaces(text) {
  return text.replace(/[^\S\n]+/gu, " ");
}

function repeatReplace(text, pattern, replacement) {
  let out = text;
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const next = out.replace(pattern, replacement);
    if (next === out) return out;
    out = next;
  }
  return out;
}

/** Runs `transform` on everything except spans already inside backticks. */
function mapOutsideCodeSpans(text, transform) {
  let out = "";
  let last = 0;
  for (const match of text.matchAll(CODE_SPAN_RE)) {
    out += transform(text.slice(last, match.index));
    out += match[0];
    last = match.index + match[0].length;
  }
  return out + transform(text.slice(last));
}

function isStopWordJoin(left, right) {
  return JOIN_STOP_WORDS.has(left.toLowerCase()) || JOIN_STOP_WORDS.has(right.toLowerCase());
}

function isDeterminerJoin(left, right) {
  return DETERMINERS.has(left.toLowerCase()) || DETERMINERS.has(right.toLowerCase());
}

function canJoin(kind, left, right) {
  if (kind === "underscore" || kind === "colonColon") return !isDeterminerJoin(left, right);
  if (isStopWordJoin(left, right)) return false;
  if (kind === "dot") {
    return /^[\p{L}\p{N}]{1,5}$/u.test(right) && /[\p{L}\p{N}]{2,}/u.test(left);
  }
  return true;
}

function joinSpokenSeparators(chunk) {
  let out = chunk;
  for (const kind of SPOKEN_SEPARATORS) {
    out = repeatReplace(out, SEPARATOR_RE[kind], (match, left, right) =>
      canJoin(kind, left, right) ? `${left}${SEPARATOR_GLUE[kind]}${right}` : match
    );
  }
  return out;
}

function isCodeShaped(core) {
  if (core.length < 2) return false;
  if (core.includes("`")) return false;
  if (/^[\p{N}.,]+$/u.test(core)) return false;
  if (core.includes("://")) return false;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(core)) return false;
  if (/::|->|\(\)|\[\]|\{\}/u.test(core)) return true;
  if (/^(?:@|--)[\p{L}\p{N}]/u.test(core)) return true;
  if (core.includes("/")) {
    const segments = core.split("/").filter(Boolean);
    if (segments.length >= 2 || core.includes(".")) return true;
  }
  if (/^[\p{L}\p{N}_.-]+$/u.test(core) && /\.[\p{L}\p{N}]{1,5}$/u.test(core)) {
    const stem = core.slice(0, core.lastIndexOf("."));
    if (stem.replace(/[^\p{L}\p{N}]/gu, "").length >= 2) return true;
  }
  if (/^\p{Ll}[\p{L}\p{N}]*\p{Lu}[\p{L}\p{N}]*$/u.test(core)) return true;
  if (/^[\p{L}\p{N}]+(?:_[\p{L}\p{N}]+)+$/u.test(core)) return true;
  if (/^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)+$/u.test(core) && /\p{N}/u.test(core)) return true;
  return false;
}

function wrapCodeTokens(chunk) {
  return chunk.replace(/\S+/gu, (token) => {
    const lead = (token.match(/^["“(]+/u) || [""])[0];
    const rest = token.slice(lead.length);
    const tail = (rest.match(/[.,;:!?"”]+$/u) || [""])[0];
    const core = rest.slice(0, rest.length - tail.length);
    if (!isCodeShaped(core)) return token;
    return `${lead}\`${core}\`${tail}`;
  });
}

function wrapNamedCodeReferences(chunk) {
  return chunk.replace(NAMED_REFERENCE_RE, (match, word, gap) => {
    if (NAMED_REFERENCE_EXCLUSIONS.has(word.toLowerCase())) return match;
    return `\`${word}\`${gap}${match.slice(word.length + gap.length)}`;
  });
}

/**
 * Rule 1. Does not guess word joins the speaker did not make: "use effect" stays two
 * words, and "dashboard page dot tsx" only joins the token next to "dot".
 */
export function formatCodeReferences(text) {
  const joined = mapOutsideCodeSpans(asString(text), joinSpokenSeparators);
  const wrapped = mapOutsideCodeSpans(joined, wrapCodeTokens);
  return mapOutsideCodeSpans(wrapped, wrapNamedCodeReferences);
}

/** Rule 2. Does not invent line breaks; only a spoken "new line" makes one. */
export function applySpokenKeys(text) {
  return mapOutsideCodeSpans(asString(text), (chunk) =>
    chunk
      .replace(PARAGRAPH_RE, "\n\n")
      .replace(NEWLINE_RE, "\n")
      .replace(/(\n+)(\p{Ll})/gu, (match, breaks, letter) => breaks + letter.toUpperCase())
  );
}

/** Rule 3. Does not look anywhere but the tail, so "send the email" stays content. */
export function extractSendCommand(text) {
  const source = asString(text);
  if (!SEND_TAIL_RE.test(source)) return { text: source, send: false };
  const head = source
    .replace(SEND_TAIL_RE, "")
    .replace(/[\s,]+$/u, "")
    .replace(DANGLING_CONJUNCTION_RE, "")
    .replace(/[\s,]+$/u, "");
  return { text: head, send: true };
}

function maskCodeSpans(text) {
  const spans = [];
  const masked = text.replace(CODE_SPAN_RE, (span) => {
    spans.push(span);
    return `${MASK_OPEN}${spans.length - 1}${MASK_CLOSE}`;
  });
  return { masked, spans };
}

function unmaskCodeSpans(text, spans) {
  return text.replace(
    new RegExp(`${MASK_OPEN}(\\d+)${MASK_CLOSE}`, "gu"),
    (match, index) => spans[Number(index)]
  );
}

function capitalizeSentences(text) {
  const characters = Array.from(text);
  let out = "";
  let pending = true;
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index];
    if (pending && /\p{L}/u.test(character)) {
      out += character.toUpperCase();
      pending = false;
      continue;
    }
    out += character;
    // A "." only ends a sentence when a space follows it, so example.com stays lowercase.
    const next = characters[index + 1];
    if (character === "\n") pending = true;
    else if (".!?".includes(character)) pending = next === undefined || /\s/u.test(next);
    else if (!/\s/u.test(character)) pending = false;
  }
  return out;
}

function endLinesWithPeriod(text) {
  return text
    .split("\n")
    .map((line) => {
      const trimmed = line.trimEnd();
      if (!trimmed) return trimmed;
      const last = trimmed[trimmed.length - 1];
      const closesCode = last === MASK_CLOSE || last === "`";
      return /[\p{L}\p{N}]/u.test(last) || closesCode ? `${trimmed}.` : trimmed;
    })
    .join("\n");
}

/**
 * Rule 4. Does not re-case anything inside backticks or the word straight after a
 * closing backtick, and does not expand or create contractions.
 */
export function tidyPunctuation(text) {
  const { masked, spans } = maskCodeSpans(asString(text));
  let out = collapseInlineSpaces(masked);
  out = out.replace(/[^\S\n]*\n[^\S\n]*/gu, "\n");
  out = out.replace(/[^\S\n]+([,.;:!?])/gu, "$1");
  out = repeatReplace(out, /,[ \t]*,/gu, ",");
  out = out.replace(/,[ \t]*([.!?])/gu, "$1");
  out = repeatReplace(out, new RegExp(`${CLAUSE_START}[ \\t]*,[ \\t]*`, "gu"), "$1");
  out = out.replace(/^[\s,.;:]+/u, "").trim();
  out = capitalizeSentences(out);
  out = endLinesWithPeriod(out);
  return unmaskCodeSpans(out, spans);
}

/** The rule list a settings screen can render; ids match the exported functions. */
export const AGENT_PROMPT_RULES = Object.freeze([
  { id: "formatCodeReferences", label: "Paths and identifiers as code", order: 1 },
  { id: "applySpokenKeys", label: "Spoken line breaks", order: 2 },
  { id: "extractSendCommand", label: "Trailing send", order: 3 },
  { id: "tidyPunctuation", label: "Punctuation and capitals", order: 4 },
]);

export function cleanAgentPrompt(transcript) {
  const original = asString(transcript).trim();
  if (!original) return { text: "", send: false, changed: false };

  let text = formatCodeReferences(original);
  text = applySpokenKeys(text);
  const sent = extractSendCommand(text);
  text = tidyPunctuation(sent.text);

  return { text, send: sent.send, changed: text !== original };
}
