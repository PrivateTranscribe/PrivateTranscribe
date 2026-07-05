/**
 * Minimal dotted-version comparison for internal version strings like
 * "v0.0.9" or "0.13.0". Not full semver — no prerelease/build handling,
 * which our engine and app versions never use.
 */
export function parseVersionParts(version: string): number[] | null {
  if (typeof version !== "string") return null;
  const trimmed = version.trim().replace(/^v/i, "");
  if (!/^\d+(\.\d+)*$/.test(trimmed)) return null;
  return trimmed.split(".").map((part) => Number.parseInt(part, 10));
}

/**
 * True when `candidate` is a strictly newer version than `current`.
 * Returns false when either version is missing or malformed, so callers can
 * treat "unknown" as "nothing new to announce".
 */
export function isNewerVersion(
  candidate: string | null | undefined,
  current: string | null | undefined
): boolean {
  const a = candidate ? parseVersionParts(candidate) : null;
  const b = current ? parseVersionParts(current) : null;
  if (!a || !b) return false;

  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left > right;
  }
  return false;
}
