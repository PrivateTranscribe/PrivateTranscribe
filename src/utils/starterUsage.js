export const STARTER_DAILY_WORD_LIMIT = 5000;
export const STARTER_USAGE_KEY = "privatetranscribe_starter_usage_v1";

export function getLocalDay(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function formatTimeUntilLocalMidnight(date = new Date()) {
  const nextMidnight = new Date(date);
  nextMidnight.setHours(24, 0, 0, 0);
  const totalMinutes = Math.max(1, Math.ceil((nextMidnight.getTime() - date.getTime()) / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours === 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}

export function countWords(text) {
  if (typeof text !== "string") return 0;
  const matches = text.trim().match(/[\p{L}\p{N}]+(?:[’'\-][\p{L}\p{N}]+)*/gu);
  return matches ? matches.length : 0;
}

function normalizeUsage(value, date = new Date()) {
  const today = getLocalDay(date);
  if (!value || typeof value !== "object" || value.date !== today) {
    return { date: today, wordsUsed: 0, limit: STARTER_DAILY_WORD_LIMIT };
  }
  return {
    date: today,
    wordsUsed: Math.max(0, Number(value.wordsUsed) || 0),
    limit: Math.max(STARTER_DAILY_WORD_LIMIT, Number(value.limit) || STARTER_DAILY_WORD_LIMIT),
  };
}

export function readStarterUsage(storage = globalThis.localStorage, date = new Date()) {
  try {
    const raw = storage?.getItem?.(STARTER_USAGE_KEY);
    return normalizeUsage(raw ? JSON.parse(raw) : null, date);
  } catch {
    return normalizeUsage(null, date);
  }
}

export function writeStarterUsage(usage, storage = globalThis.localStorage) {
  try {
    storage?.setItem?.(STARTER_USAGE_KEY, JSON.stringify(usage));
  } catch {
    // Local usage enforcement is best-effort. If storage is unavailable, avoid crashing dictation.
  }
  return usage;
}

export function isStarterLimitReached(storage = globalThis.localStorage, date = new Date()) {
  const usage = readStarterUsage(storage, date);
  return usage.wordsUsed >= usage.limit;
}

export function recordStarterWords(text, storage = globalThis.localStorage, date = new Date()) {
  const words = countWords(text);
  const usage = readStarterUsage(storage, date);
  const next = {
    ...usage,
    wordsUsed: usage.wordsUsed + words,
  };
  writeStarterUsage(next, storage);
  return {
    ...next,
    wordsAdded: words,
    remaining: Math.max(0, next.limit - next.wordsUsed),
    limitReached: next.wordsUsed >= next.limit,
  };
}

export function buildStarterLimitMessage(usage) {
  const limit = usage?.limit || STARTER_DAILY_WORD_LIMIT;
  return `Starter includes ${limit.toLocaleString()} words per day. It resets tomorrow. Join Pro Early Access for unlimited private dictation.`;
}
