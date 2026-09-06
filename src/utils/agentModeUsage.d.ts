export const AGENT_MODE_DAILY_USE_LIMIT: number;
export const AGENT_MODE_USAGE_KEY: string;
export function buildAgentModeLimitMessage(usage?: { limit?: number }): string;
export function isAgentModeLimitReached(storage?: Storage, date?: Date): boolean;
export function readAgentModeUsage(
  storage?: Storage,
  date?: Date
): {
  date: string;
  usesToday: number;
  limit: number;
};
export function recordAgentModeUse(
  storage?: Storage,
  date?: Date
): {
  date: string;
  usesToday: number;
  limit: number;
  remaining: number;
  limitReached: boolean;
};
export function writeAgentModeUsage(
  usage: { date: string; usesToday: number; limit: number },
  storage?: Storage
): { date: string; usesToday: number; limit: number };
