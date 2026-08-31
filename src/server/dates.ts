/**
 * Calendar-day boundaries for report ranges.
 *
 * The dashboard reports its own timezone offset (`getTimezoneOffset()`, e.g.
 * -330 for IST) so day ranges follow the *operator's* local clock. Without
 * this, a serverless region running in UTC would "reset" the day at 5:30 AM
 * IST instead of 12:00 AM.
 *
 * `offsetMinutes` uses the JS sign convention: minutes to ADD to local time
 * to get UTC (UTC+5:30 → -330).
 */

/** 12:00 AM of `base`'s calendar day in a zone `offsetMinutes` from UTC. */
export function startOfDayInZone(base: Date, offsetMinutes: number): Date {
  // Shift the instant into the target zone, read its calendar date, then
  // shift back — DST-safe because both conversions use the same offset.
  const shifted = new Date(base.getTime() - offsetMinutes * 60_000);
  return new Date(
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) +
      offsetMinutes * 60_000
  );
}

/** First day of `base`'s month at 12:00 AM in a zone `offsetMinutes` from UTC. */
export function startOfMonthInZone(base: Date, offsetMinutes: number): Date {
  const shifted = new Date(base.getTime() - offsetMinutes * 60_000);
  return new Date(
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), 1) + offsetMinutes * 60_000
  );
}

/**
 * Parses a timezone offset sent by a client, returning null when absent or
 * malformed so callers can fall back to the server's own local time.
 */
export function parseTimezoneOffsetMinutes(raw: unknown): number | null {
  const parsed = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(parsed) || Math.abs(parsed) > 14 * 60) return null;
  return parsed;
}
