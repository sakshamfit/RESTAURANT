/**
 * Opens the system print dialog for whatever is currently on screen.
 *
 * Two paths, neither of which uses `window.open()`:
 *
 *  • Desktop console (Electron): the main process calls
 *    `webContents.print()`, which raises the native print dialog for the
 *    console window itself. The shell's `setWindowOpenHandler` denies every
 *    popup, so this is the only print route that is guaranteed to work there.
 *  • Browser / hosted web build: the plain `window.print()` print dialog.
 *
 * A popup blocker can never get in the way because no new window is ever
 * created — the receipt / QR standee is rendered on the page and the print
 * styles in src/index.css decide what reaches the printer.
 */

export interface PrintOutcome {
  ok: boolean;
  /** True when the native desktop (Electron) dialog handled the job. */
  desktop: boolean;
  /** Operator-facing reason when `ok` is false. Never mentions pop-ups. */
  error?: string;
}

function failureMessage(reason?: string): string {
  const detail = (reason || '').trim();
  if (!detail) {
    return 'The print dialog could not be opened. Please try again, or press Ctrl+P (Cmd+P on Mac) and choose Print.';
  }
  // "No printers available" is the one failure staff can actually fix, so
  // spell it out instead of exposing the raw Electron string.
  if (/no printers?|printer.*not.*(found|available|installed)/i.test(detail)) {
    return 'No printer was found. Connect or install a printer (or the thermal printer driver), then press Print again.';
  }
  return `The print dialog could not be opened (${detail}). Please try again, or press Ctrl+P (Cmd+P on Mac) and choose Print.`;
}

export async function printCurrentPage(): Promise<PrintOutcome> {
  if (typeof window === 'undefined') {
    return { ok: false, desktop: false, error: 'Printing is only available inside the app window.' };
  }

  const bridge = window.nagoriDesktop;

  // Desktop console: ask the main process for the native print dialog. The
  // promise resolves after the dialog closes (print or cancel), which also
  // lets the caller dismiss its preview sheet at the right moment.
  if (bridge?.print) {
    try {
      const result = await bridge.print();
      if (result?.success) return { ok: true, desktop: true };
      return { ok: false, desktop: true, error: failureMessage(result?.failureReason) };
    } catch (error: any) {
      // IPC hiccup on an older shell — fall back to the renderer dialog.
      console.warn('[print] desktop print failed, using window.print():', error?.message || error);
    }
  }

  try {
    window.print();
    return { ok: true, desktop: false };
  } catch (error: any) {
    return { ok: false, desktop: false, error: failureMessage(error?.message) };
  }
}
