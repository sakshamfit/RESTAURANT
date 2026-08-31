// Local-timezone date helpers shared by the customer "My Orders" list and the
// admin daily views. Everything here works in the *device's* local time so
// "Today" is whatever day it is on that phone/counter — matching the 12:00 AM
// daily reset everywhere the app shows a day-scoped list.

function toDate(value: Date | string): Date | null {
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "YYYY-MM-DD" for the given date in the device's local time ("" if invalid). */
export function localDayKey(value: Date | string): string {
  const d = toDate(value);
  if (!d) return '';
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

/** true when both values fall on the same local calendar day. */
export function isSameLocalDay(a: Date | string, b: Date | string): boolean {
  const first = toDate(a);
  const second = toDate(b);
  if (!first || !second) return false;
  return (
    first.getFullYear() === second.getFullYear() &&
    first.getMonth() === second.getMonth() &&
    first.getDate() === second.getDate()
  );
}

/** "Today" / "Yesterday" / "30 Aug" (or "30 Aug 2025" for another year). */
export function formatOrderDay(value: Date | string, now: Date = new Date()): string {
  const d = toDate(value);
  if (!d) return '';
  if (isSameLocalDay(d, now)) return 'Today';
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (isSameLocalDay(d, yesterday)) return 'Yesterday';
  const options: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' };
  if (d.getFullYear() !== now.getFullYear()) options.year = 'numeric';
  return d.toLocaleDateString('en-IN', options);
}

/** "09:41 PM" in the device's local time. */
export function formatOrderTime(value: Date | string): string {
  const d = toDate(value);
  if (!d) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Full, unambiguous stamp: "Today, 09:41 PM" / "30 Aug 2025, 09:41 PM". */
export function formatOrderDateTime(value: Date | string, now: Date = new Date()): string {
  const day = formatOrderDay(value, now);
  const time = formatOrderTime(value);
  if (!day) return time;
  return time ? `${day}, ${time}` : day;
}

/**
 * Compact stamp for live feeds: today's entries show just the time (kitchen
 * tickets), anything older shows the date too so yesterday's still-active
 * orders are never mistaken for today's.
 */
export function formatOrderStamp(value: Date | string, now: Date = new Date()): string {
  const d = toDate(value);
  if (!d) return '';
  return isSameLocalDay(d, now) ? formatOrderTime(d) : formatOrderDateTime(d, now);
}
