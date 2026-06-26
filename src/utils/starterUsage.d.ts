export const STARTER_DAILY_WORD_LIMIT: number;
export const STARTER_USAGE_KEY: string;
export function buildStarterLimitMessage(usage?: { limit?: number }): string;
export function countWords(text: string): number;
export function getLocalDay(date?: Date): string;
export function isStarterLimitReached(storage?: Storage, date?: Date): boolean;
export function readStarterUsage(
  storage?: Storage,
  date?: Date
): {
  date: string;
  wordsUsed: number;
  limit: number;
};
export function recordStarterWords(
  text: string,
  storage?: Storage,
  date?: Date
): {
  date: string;
  wordsUsed: number;
  limit: number;
  wordsAdded: number;
  remaining: number;
  limitReached: boolean;
};
export function writeStarterUsage(
  usage: { date: string; wordsUsed: number; limit: number },
  storage?: Storage
): { date: string; wordsUsed: number; limit: number };
