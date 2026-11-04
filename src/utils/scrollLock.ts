import { useEffect } from 'react';

/**
 * Locks the page behind a full-screen overlay (cart drawer, order history,
 * QR scanner, order confirmation) and restores it when the overlay closes.
 *
 * Why this exists (Android Chrome / WebView):
 *  - Before, overlays were plain `fixed` panels on top of a still-scrollable
 *    page. On Android the page behind kept receiving the gesture as soon as
 *    the inner list hit its end ("scroll chaining"), so while ordering the
 *    customer would scroll the cart, the menu underneath would jump, and the
 *    drawer looked stuck / out of sync with the finger.
 *  - The naive fix (`body.style.overflow = 'hidden'`) is unsafe on Android:
 *    hiding overflow on the scrolling element can reset the document scroll
 *    offset, and with several overlays mounted in one screen the first one to
 *    close would unlock while another is still open. Hence the ref-count and
 *    the scroll-offset restore below.
 *  - It is also fully reversible: the previous inline values are put back
 *    verbatim, so nothing else about the layout changes.
 *
 * Overlay scroll areas give themselves `overscroll-contain` (see the
 * components) so their own scrolling never leaks to this locked page either.
 */

const LOCK_CLASS = 'app-scroll-locked';

let lockCount = 0;
let savedHtmlOverflow = '';
let savedBodyOverflow = '';
let savedScrollY = 0;

function applyLock(): void {
  const html = document.documentElement;
  const body = document.body;

  savedScrollY = window.scrollY || html.scrollTop || 0;
  savedHtmlOverflow = html.style.overflow;
  savedBodyOverflow = body.style.overflow;

  // Both elements are locked because which one is the document scroller
  // differs between Chrome, Samsung Internet and in-app Android WebViews.
  html.style.overflow = 'hidden';
  body.style.overflow = 'hidden';
  html.classList.add(LOCK_CLASS);
}

function releaseLock(): void {
  const html = document.documentElement;
  const body = document.body;

  html.style.overflow = savedHtmlOverflow;
  body.style.overflow = savedBodyOverflow;
  html.classList.remove(LOCK_CLASS);

  // Android Chrome can drop the document scroll offset when the overflow
  // lock is released; put the customer back exactly where they were.
  const y = savedScrollY;
  window.requestAnimationFrame(() => {
    if (Math.abs((window.scrollY || 0) - y) > 2) {
      window.scrollTo(0, y);
    }
  });
}

/** Lock page scrolling while `active` is true. Safe to nest. */
export function useBodyScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active) return;

    lockCount += 1;
    if (lockCount === 1) applyLock();

    return () => {
      lockCount = Math.max(0, lockCount - 1);
      if (lockCount === 0) releaseLock();
    };
  }, [active]);
}
