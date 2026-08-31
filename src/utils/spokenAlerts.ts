import type { Order } from '../types';

/**
 * Spoken staff alerts.
 *
 * The admin dashboard announces new orders and waiter calls using the
 * browser's built-in speech engine. No audio files are shipped and no network
 * service is called — the voice is whatever the device already has installed.
 *
 * Voice selection is quality-first: when the device ships a natural/neural
 * voice it is preferred over the platform's basic fallback, so announcements
 * stay clear on a busy service floor.
 *
 * Robustness details:
 *  - The browser voice list loads ASYNCHRONOUSLY. We wait for the
 *    `voiceschanged` event (with a poll + gesture fallback) before speaking, so
 *    the very first announcement after page load already uses the best voice.
 *  - Announcements are queued, so two tables ordering together never talk over
 *    each other, with a hard time cap so a stuck utterance cannot block the
 *    queue.
 *  - A generation counter invalidates any in-flight announcement when the
 *    queue is cleared, so a pending voice never speaks after "stop".
 */
export const MAX_ANNOUNCEMENT_DURATION_MS = 15_000;

export interface SpokenAlertCallbacks {
  onStart?: (message: string) => void;
  onFinish?: () => void;
}

type OrderAlert = Pick<Order, 'tableName' | 'tableNumber'>;

type QueuedAnnouncement = SpokenAlertCallbacks & {
  message: string;
};

// Human-sounding voice names across platforms (Chrome Android, Google voices,
// Microsoft Edge / Windows, Apple macOS/iOS, Samsung). The speech API does not
// expose gender, so we match on the name strings.
const PREFERRED_VOICE_NAME_HINTS = [
  'aria', 'sonia', 'jenny', 'neerja', 'swara', 'google natural',
  'samantha', 'victoria', 'karen', 'moira', 'tessa',
  'zira', 'susan', 'hazel', 'veena', 'lekha', 'priya', 'sangeeta',
  'heera', 'raveena', 'natasha', 'libby', 'ava', 'allison', 'serena',
  'emma', 'olivia', 'linda', 'kathy', 'salli', 'joanna', 'ivy',
  'kimberly', 'amy', 'nicky', 'fiona', 'catherine',
] as const;

// Names that reliably mean a low-quality, harsh voice — deprioritise these
// even if they otherwise look like an English voice.
const LOW_QUALITY_VOICE_HINTS = [
  'david', 'mark', 'fred', 'albert', 'ralph', 'bruce', 'george', 'daniel', 'oliver',
] as const;

let announcementQueue: QueuedAnnouncement[] = [];
let activeAnnouncement: {
  item: QueuedAnnouncement;
  utterance: SpeechSynthesisUtterance;
  stopTimer: number | null;
  finished: boolean;
  generation: number;
} | null = null;

// Bumped on every stop(); an in-flight async announcement whose generation no
// longer matches is discarded instead of being spoken.
let queueGeneration = 0;

let voicesReadyPromise: Promise<SpeechSynthesisVoice[]> | null = null;

/** True when this browser can produce spoken announcements at all. */
export function isSpokenAlertSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.speechSynthesis !== 'undefined' &&
    typeof window.SpeechSynthesisUtterance !== 'undefined'
  );
}

function isEnglishVoice(voice: SpeechSynthesisVoice): boolean {
  return /^en(?:-|_)/i.test(voice.lang || '');
}

function isIndianEnglishVoice(voice: SpeechSynthesisVoice): boolean {
  return /^en(?:-|_)in/i.test(voice.lang || '');
}

function isPreferredNamedVoice(voice: SpeechSynthesisVoice): boolean {
  const label = `${voice.name} ${voice.voiceURI}`.toLowerCase();
  return PREFERRED_VOICE_NAME_HINTS.some((hint) => label.includes(hint));
}

function isLowQualityVoice(voice: SpeechSynthesisVoice): boolean {
  const label = `${voice.name} ${voice.voiceURI}`.toLowerCase();
  return LOW_QUALITY_VOICE_HINTS.some((hint) => label.includes(hint));
}

/**
 * Higher score = more desirable.
 *
 * Quality signals (biggest wins first):
 *  - natural / neural / online voices (these are the clear ones)
 *  - local, non-default voices
 * Region: Indian English first (this is an Indian café), then US/UK English.
 */
function scoreVoice(voice: SpeechSynthesisVoice): number {
  const label = `${voice.name} ${voice.voiceURI}`.toLowerCase();
  let score = 0;

  if (/(natural|neural|online|premium|wavenet|studio|enhanced)/.test(label)) score += 1000;
  if (voice.localService === false) score += 250; // cloud voices are the higher-quality ones
  if (voice.localService === true) score += 40;
  if (isLowQualityVoice(voice)) score -= 600;
  if (isPreferredNamedVoice(voice)) score += 150;

  if (isIndianEnglishVoice(voice)) score += 90;
  else if (/^en(?:-|_)(us|gb)/i.test(voice.lang || '')) score += 60;
  else if (isEnglishVoice(voice)) score += 40;

  if (voice.default) score += 5;

  return score;
}

/**
 * Resolve the voice list once the browser has actually loaded it.
 * Cached after the first resolution so repeated announcements are instant.
 */
function getVoices(): Promise<SpeechSynthesisVoice[]> {
  if (!isSpokenAlertSupported()) return Promise.resolve([]);

  const direct = window.speechSynthesis.getVoices();
  if (direct.length > 0) return Promise.resolve(direct);

  if (voicesReadyPromise) return voicesReadyPromise;

  voicesReadyPromise = new Promise<SpeechSynthesisVoice[]>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      try {
        window.removeEventListener('pointerdown', finish);
      } catch {
        // ignore
      }
      resolve(window.speechSynthesis.getVoices());
    };

    // `voiceschanged` fires in Chrome/Edge when the list becomes available.
    window.speechSynthesis.addEventListener?.('voiceschanged', finish, { once: true });
    // Some browsers (older Safari) never fire the event — a short poll covers them.
    const poll = window.setInterval(() => {
      if (window.speechSynthesis.getVoices().length > 0) {
        window.clearInterval(poll);
        finish();
      }
    }, 250);
    // A user gesture also unlocks/loads the voice list on mobile browsers.
    window.addEventListener('pointerdown', finish, { once: true });

    // Never wait forever: after 2s, speak with whatever voice we have instead
    // of staying silent.
    window.setTimeout(() => {
      window.clearInterval(poll);
      finish();
    }, 2000);
  });

  return voicesReadyPromise;
}

/** Pick the highest-ranked English voice available on this device. */
async function getPreferredVoice(): Promise<SpeechSynthesisVoice | undefined> {
  if (!isSpokenAlertSupported()) return undefined;
  const voices = await getVoices();
  const english = voices.filter(isEnglishVoice);
  const pool = english.length > 0 ? english : voices;
  if (pool.length === 0) return undefined;
  return [...pool].sort((a, b) => scoreVoice(b) - scoreVoice(a))[0];
}

function finishActiveAnnouncement(item: QueuedAnnouncement) {
  if (!activeAnnouncement || activeAnnouncement.item !== item || activeAnnouncement.finished) return;

  activeAnnouncement.finished = true;
  if (activeAnnouncement.stopTimer !== null) {
    window.clearTimeout(activeAnnouncement.stopTimer);
  }
  activeAnnouncement = null;
  item.onFinish?.();

  // Let the speech engine process its previous end event before speaking the
  // next message. This avoids messages being dropped in Chrome.
  window.setTimeout(() => void startNextAnnouncement(), 0);
}

async function startNextAnnouncement() {
  if (activeAnnouncement || announcementQueue.length === 0) return;

  const generationAtStart = queueGeneration;
  const item = announcementQueue.shift();
  if (!item || !isSpokenAlertSupported()) {
    item?.onFinish?.();
    return;
  }

  const utterance = new window.SpeechSynthesisUtterance(item.message);

  // Wait for the voice list to be populated so the FIRST announcement already
  // uses the best available voice instead of the browser's fallback.
  const preferredVoice = await getPreferredVoice();

  // stop() was called while we awaited the voice list — drop this message.
  if (generationAtStart !== queueGeneration) {
    item.onFinish?.();
    return;
  }
  if (activeAnnouncement) {
    // Another announcement somehow started — drop this one.
    item.onFinish?.();
    return;
  }

  if (preferredVoice) {
    utterance.voice = preferredVoice;
    utterance.lang = preferredVoice.lang || 'en-IN';
  } else {
    utterance.lang = 'en-IN';
  }

  // Natural delivery, close to a person's speaking rate.
  utterance.rate = 1.0;
  utterance.pitch = 1.05;
  utterance.volume = 1;

  const active = {
    item,
    utterance,
    stopTimer: null as number | null,
    finished: false,
    generation: generationAtStart,
  };
  activeAnnouncement = active;

  utterance.onend = () => finishActiveAnnouncement(item);
  utterance.onerror = () => finishActiveAnnouncement(item);

  // Update the dashboard banner at the moment the spoken message begins.
  item.onStart?.(item.message);

  active.stopTimer = window.setTimeout(() => {
    if (activeAnnouncement?.item !== item) return;
    try {
      window.speechSynthesis.cancel();
    } catch {
      // The visual alert still closes even if the speech engine fails.
    }
    finishActiveAnnouncement(item);
  }, MAX_ANNOUNCEMENT_DURATION_MS);

  try {
    window.speechSynthesis.speak(utterance);
  } catch {
    finishActiveAnnouncement(item);
  }
}

function queueAnnouncement(message: string, callbacks: SpokenAlertCallbacks = {}): boolean {
  if (!isSpokenAlertSupported()) return false;
  announcementQueue.push({ message, ...callbacks });
  void startNextAnnouncement();
  return true;
}

function tableLabel(order: OrderAlert | { tableName?: string; tableNumber: number }): string {
  const label = order?.tableName?.trim();
  // Keep a custom table label from making the spoken message unexpectedly long.
  return (label || `Table ${order?.tableNumber ?? ''}`).trim().slice(0, 80);
}

/**
 * Warms the browser voice list after the first user interaction (nothing is
 * spoken). Call this on dashboard load so the voice list is ready before the
 * first order arrives.
 */
export function prepareSpokenAlerts(): boolean {
  if (!isSpokenAlertSupported()) return false;
  try {
    window.speechSynthesis.getVoices();
    void getVoices(); // start loading + cache the list
    return true;
  } catch {
    return false;
  }
}

/**
 * Announce a newly placed order from the all-table admin feed.
 * Deliberately concise: a few seconds of speech.
 */
export function announceOrderReceived(order: OrderAlert, callbacks: SpokenAlertCallbacks = {}): boolean {
  return queueAnnouncement(
    `New order from ${tableLabel(order)}. Please check the order panel.`,
    callbacks
  );
}

/** Announce that a customer has pressed the "Call Waiter" button. */
export function announceWaiterCall(
  table: { tableName?: string; tableNumber: number },
  callbacks: SpokenAlertCallbacks = {}
): boolean {
  return queueAnnouncement(
    `${tableLabel(table)} is requesting a waiter. Please attend to the table.`,
    callbacks
  );
}

/** Stops the current spoken message and clears any waiting messages. */
export function stopSpokenAlerts(): void {
  queueGeneration += 1;
  announcementQueue = [];
  const active = activeAnnouncement;
  if (!active) return;

  if (active.stopTimer !== null) {
    window.clearTimeout(active.stopTimer);
  }
  activeAnnouncement = null;
  active.finished = true;

  try {
    if (isSpokenAlertSupported()) window.speechSynthesis.cancel();
  } catch {
    // Ignore browser speech cancellation failures.
  }
  active.item.onFinish?.();
}
