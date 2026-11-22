"use strict";

/**
 * Turns a short spoken sentence into one of the narrator's commands, in
 * Danish or English, or null. The language it was asked in comes back too,
 * so a brief answers in the language of the question.
 *
 * Only short utterances count. The microphone hears the whole room, and a
 * command buried in a long sentence ("I told him what's new is the build")
 * was not said to the narrator.
 *
 * The narrator has no command that answers a chat. A spoken "yes" that speech
 * recognition invented must never allow anything, so answers stay in the chat.
 */

const MAX_COMMAND_WORDS = 7;

/** Checked in order; the first pattern that matches wins. */
const COMMANDS = [
  { command: "stop", language: "da", pattern: /^(?:stop|stille|ti stille|hold op|tys)$/ },
  { command: "stop", language: "en", pattern: /^(?:stop|stop talking|be quiet|quiet|shush)$/ },
  {
    command: "more",
    language: "da",
    pattern: /^(?:fortæl (?:mig )?(?:lidt )?mere|mere|uddyb|uddyb det|hvad mere)$/,
  },
  { command: "more", language: "en", pattern: /^(?:tell me more|more|go on|more detail|details)$/ },
  {
    command: "follow",
    language: "da",
    pattern:
      /^(?:følg (?:den|denne|den her|det) ?(?:chat|chatten)?|følg chatten|følg med i (?:den|chatten))$/,
  },
  {
    command: "follow",
    language: "en",
    pattern: /^(?:follow (?:that|this|the) chat|follow (?:it|that|this))$/,
  },
  {
    command: "brief",
    language: "da",
    pattern:
      /^(?:(?:hey |hej )?hvad (?:er|sker) (?:der )?(?:nyt|nye)|hvad er nyt|noget nyt|nyheder|hvad venter|hvad mangler)$/,
  },
  {
    command: "brief",
    language: "en",
    pattern:
      /^(?:(?:hey )?what(?:'s| is) new|anything new|what's waiting|what is waiting|any news|news|catch me up)$/,
  },
];

/** Lower case, no punctuation, single spaces. Danish letters are kept. */
function normalise(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[’`´]/g, "'")
    .replace(/[^\p{L}\p{N}' ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** @returns {{ command: "brief"|"more"|"follow"|"stop", language: "da"|"en" } | null} */
function matchCommand(text) {
  const normal = normalise(text);
  if (!normal) return null;
  if (normal.split(" ").length > MAX_COMMAND_WORDS) return null;
  // A polite frame around a command is still the command: "okay, hvad er
  // nyt", "please tell me more".
  const stripped = normal
    .replace(/^(?:okay |ok |så |og |nå |please |so |and |well )+/, "")
    .replace(/(?: tak| please| så| thanks)+$/, "");
  for (const entry of COMMANDS) {
    if (entry.pattern.test(stripped)) return { command: entry.command, language: entry.language };
  }
  return null;
}

module.exports = { matchCommand, normalise, MAX_COMMAND_WORDS };
