import { useEffect, useRef } from 'react';

/**
 * Polling that stops while nobody is looking.
 *
 * The admin dashboard is typically left open all day on a counter tablet, and
 * every tab that ever loaded it used to keep hitting the API on a fixed timer
 * forever — even when minimised, backgrounded, or on a sleeping phone. With a
 * handful of stale tabs around that quietly turns into hundreds of thousands of
 * requests a month and is the main driver of hosting egress bills.
 *
 * This hook keeps the same "always live" feel while cutting that waste:
 *   - ticks only while the document is visible;
 *   - fires an immediate catch-up fetch when the tab is focused again, so the
 *     operator never stares at stale orders waiting for the next tick;
 *   - always clears its timer on unmount.
 *
 * @param callback invoked on every tick and on each visibility catch-up.
 * @param intervalMs delay between ticks while the tab is visible.
 * @param enabled set false to suspend polling entirely (e.g. a closed modal).
 */
export function useVisiblePolling(callback: () => void, intervalMs: number, enabled = true) {
  // Keep the newest callback in a ref so changing closures never restart the
  // timer (a restart on every render would defeat the interval entirely).
  const savedCallback = useRef(callback);
  savedCallback.current = callback;

  useEffect(() => {
    if (!enabled) return;

    let timer: number | null = null;

    const stop = () => {
      if (timer !== null) {
        window.clearInterval(timer);
        timer = null;
      }
    };

    const start = () => {
      if (timer === null) {
        timer = window.setInterval(() => savedCallback.current(), intervalMs);
      }
    };

    const handleVisibility = () => {
      if (document.hidden) {
        stop();
      } else {
        // Catch up immediately, then resume the regular cadence.
        savedCallback.current();
        start();
      }
    };

    if (!document.hidden) start();
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      stop();
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [intervalMs, enabled]);
}
