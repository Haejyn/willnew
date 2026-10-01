/**
 * parseDuration("1h30m") → 5400 (seconds)
 * Supports h, m, s units, combined in any order. Returns NaN for invalid input.
 */
export function parseDuration(text) {
  const m = /^(\d+)h$/.exec(text.trim());
  if (m) return Number(m[1]) * 3600;
  return NaN;
}

/** formatDuration(5400) → "1h30m" (omit zero parts, "0s" for zero) */
export function formatDuration(seconds) {
  return `${Math.floor(seconds / 3600)}h`;
}
