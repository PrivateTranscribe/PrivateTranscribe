export const READ_ALOUD_SPEED_KEY = "readAloudSpeed";
export const READ_ALOUD_SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2] as const;

export function normalizeReadAloudSpeed(value: unknown): number {
  const speed = typeof value === "string" ? Number(value) : value;
  return READ_ALOUD_SPEEDS.some((option) => option === speed) ? (speed as number) : 1;
}

export function readStoredReadAloudSpeed(): number {
  try {
    return normalizeReadAloudSpeed(localStorage.getItem(READ_ALOUD_SPEED_KEY));
  } catch {
    return 1;
  }
}
