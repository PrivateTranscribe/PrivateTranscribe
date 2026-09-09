// Caps Agent Mode uses per local day for Starter installs so the demo works on a fresh
// install; Pro is unlimited. The Pro entitlement check itself is NOT here: the caller
// decides eligibility via getEffectiveEntitlement() and only consults this module to count.
import { getLocalDay } from "./starterUsage";

export const AGENT_MODE_DAILY_USE_LIMIT = 20;
export const AGENT_MODE_USAGE_KEY = "privatetranscribe_agent_mode_usage_v1";

function normalizeUsage(value, date = new Date()) {
  const today = getLocalDay(date);
  if (!value || typeof value !== "object" || value.date !== today) {
    return { date: today, usesToday: 0, limit: AGENT_MODE_DAILY_USE_LIMIT };
  }
  return {
    date: today,
    usesToday: Math.max(0, Number(value.usesToday) || 0),
    limit: AGENT_MODE_DAILY_USE_LIMIT,
  };
}

export function readAgentModeUsage(storage = globalThis.localStorage, date = new Date()) {
  try {
    const raw = storage?.getItem?.(AGENT_MODE_USAGE_KEY);
    return normalizeUsage(raw ? JSON.parse(raw) : null, date);
  } catch {
    return normalizeUsage(null, date);
  }
}

export function writeAgentModeUsage(usage, storage = globalThis.localStorage) {
  try {
    storage?.setItem?.(AGENT_MODE_USAGE_KEY, JSON.stringify(usage));
  } catch {
    // Local usage enforcement is best-effort. If storage is unavailable, avoid crashing dictation.
  }
  return usage;
}

export function isAgentModeLimitReached(storage = globalThis.localStorage, date = new Date()) {
  const usage = readAgentModeUsage(storage, date);
  return usage.usesToday >= usage.limit;
}

export function recordAgentModeUse(storage = globalThis.localStorage, date = new Date()) {
  const usage = readAgentModeUsage(storage, date);
  const next = {
    ...usage,
    usesToday: usage.usesToday + 1,
  };
  writeAgentModeUsage(next, storage);
  return {
    ...next,
    remaining: Math.max(0, next.limit - next.usesToday),
    limitReached: next.usesToday >= next.limit,
  };
}

export function buildAgentModeLimitMessage(usage) {
  const limit = usage?.limit || AGENT_MODE_DAILY_USE_LIMIT;
  return `Starter includes ${limit.toLocaleString()} coding prompt shortcuts a day. It resets tomorrow. Buy Pro for unlimited coding shortcuts.`;
}
