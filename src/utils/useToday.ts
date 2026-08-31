import { useEffect, useState } from 'react';
import { isSameLocalDay } from './datetime';

/**
 * Returns a Date pinned to the current local calendar day and re-renders the
 * component the moment the day rolls over at 12:00 AM — so any "Today" list
 * built from it resets itself exactly at midnight, every day.
 *
 * The day change is detected two ways:
 *  1. a timer scheduled precisely for the next local midnight;
 *  2. visibilitychange / focus / pageshow listeners, because phones and
 *     backgrounded tabs heavily throttle timers — when the screen wakes up
 *     (possibly minutes or hours past midnight) the day is re-checked at once.
 *
 * Same-day refreshes do NOT re-render (state keeps the same reference), so the
 * hook costs nothing during normal operation.
 */
export function useToday(): Date {
  const [today, setToday] = useState<Date>(() => new Date());

  useEffect(() => {
    let midnightTimer: number | undefined;

    const refreshIfDayChanged = () => {
      setToday((prev) => (isSameLocalDay(prev, new Date()) ? prev : new Date()));
    };

    const scheduleMidnightRollover = () => {
      const now = new Date();
      const nextMidnight = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() + 1,
        0,
        0,
        0,
        0
      ).getTime();
      // +50ms so the clock has safely ticked past 12:00:00.000 when we wake.
      const delay = Math.max(0, nextMidnight - now.getTime()) + 50;
      midnightTimer = window.setTimeout(() => {
        refreshIfDayChanged();
        scheduleMidnightRollover();
      }, delay);
    };

    scheduleMidnightRollover();

    document.addEventListener('visibilitychange', refreshIfDayChanged);
    window.addEventListener('focus', refreshIfDayChanged);
    window.addEventListener('pageshow', refreshIfDayChanged);

    return () => {
      if (midnightTimer !== undefined) window.clearTimeout(midnightTimer);
      document.removeEventListener('visibilitychange', refreshIfDayChanged);
      window.removeEventListener('focus', refreshIfDayChanged);
      window.removeEventListener('pageshow', refreshIfDayChanged);
    };
  }, []);

  return today;
}
