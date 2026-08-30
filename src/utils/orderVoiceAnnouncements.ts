import type { Order } from '../types';

/**
 * Spoken order/waiter alerts. These use the browser's built-in Web Speech API
 * but the voice is chosen with a quality-first ranking so that, when the device
 * ships a premium neural voice (Microsoft "Aria/Sonia/Jenny Natural", Google
 * natural voices, Apple Siri/Premium voices), the assistant sounds like a real
 * human instead of a robotic default.
 *
 * Robustness details:
 *  - The browser voice list loads ASYNCHRONOUSLY. We wait for the
 *    `voiceschanged` event (with a poll + gesture fallback) before speaking, so
 *    the very first announcement after page load already uses the good voice.
 *  - The queue makes sure two tables ordering together never talk over each
 *    other, with a hard time cap so a stuck utterance can't block the queue.
 *  - A generation counter invalidates any in-flight announcement when the
 *    queue is cleared / stopped, so an awaited voice never speaks after stop.
 */
export const MAX_ORDER_VOICE_DURATION_MS = 15_000;

export interface VoiceAnnouncementCallbacks {
  onStart?: (message: string) => void;
  onFinish?: () => void;
}

type OrderAlert = Pick<Order, 'tableName' | 'tableNumber'>;

type QueuedAnnouncement = VoiceAnnouncementCallbacks & {
  message: string;
};

// Human-friendly feminine assistant voice names across platforms (Chrome
// Android, Google voices, Microsoft Edge / Windows, Apple macOS/iOS, Samsung).
// Web Speech doesn't expose gender, so we match on the name strings.
const FEMALE_VOICE_NAME_HINTS = [
  'female', 'woman',
  // Premium / neural human-sounding voices first
  'aria', 'sonia', 'jenny', 'neerja', 'swara', 'google natural',
  'samantha', 'victoria', 'siri', 'karen', 'moira', 'tessa',
  'zira', 'susan', 'hazel', 'veena', 'lekha', 'priya', 'sangeeta',
  'heera', 'raveena', 'natasha', 'libby', 'ava', 'allison', 'serena',
  'emma', 'olivia', 'linda', 'kathy', 'salli', 'joanna', 'ivy',
  'kimberly', 'amy', 'nicky', 'fiona', 'catherine',
] as const;

// Names that reliably mean a LOW quality robotic male voice — deprioritise
// these even if they otherwise look like an English voice.
const ROBOTIC_VOICE_HINTS = ['david', 'mark', 'fred', 'albert', 'ralph', 'bruce', 'george', 'daniel', 'oliver'] as const;

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

function canSpeak(): boolean {
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

function isFemaleNamedVoice(voice: SpeechSynthesisVoice): boolean {
  const label = `${voice.name} ${voice.voiceURI}`.toLowerCase();
  return FEMALE_VOICE_NAME_HINTS.some((hint) => label.includes(hint));
}

function isRoboticVoice(voice: SpeechSynthesisVoice): boolean {
  const label = `${voice.name} ${voice.voiceURI}`.toLowerCase();
  return ROBOTIC_VOICE_HINTS.some((hint) => label.includes(hint));
}

/**
 * Higher score = more natural / more desirable.
 *
 * Quality signals (biggest wins first):
 *  - premium neural/online/“natural” voices (these genuinely sound human)
 *  - local, non-default voices
 *  - female assistant voice
 * Region: Indian English first (this is an Indian café), then US/UK English.
 */
function scoreVoice(voice: SpeechSynthesisVoice): number {
  const label = `${voice.name} ${voice.voiceURI}`.toLowerCase();
  let score = 0;

  // Quality tier — the single biggest factor for “sounding real”.
  if (/(natural|neural|online|premium|wavenet|studio|enhanced)/.test(label)) score += 1000;
  if (voice.localService === false) score += 250; // cloud voices are the high-quality ones
  if (voice.localService === true) score += 40;
  if (isRoboticVoice(voice)) score -= 600;

  // Prefer a feminine assistant voice.
  if (isFemaleNamedVoice(voice)) score += 150;

  // Region preference.
  if (isIndianEnglishVoice(voice)) score += 90;
  else if (/^en(?:-|_)(us|gb)/i.test(voice.lang || '')) score += 60;
  else if (isEnglishVoice(voice)) score += 40;

  if (voice.default) score += 5;

  return score;
}

/**
 * Resolve the best voice once the browser's voice list is actually loaded.
 * Cached after the first resolution so repeated announcements are instant.
 */
function getVoices(): Promise<SpeechSynthesisVoice[]> {
  if (!canSpeak()) return Promise.resolve([]);

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

    // Never wait forever: after 2s, speak with whatever (possibly the default)
    // voice we have instead of staying silent.
    window.setTimeout(() => {
      window.clearInterval(poll);
      finish();
    }, 2000);
  });

  return voicesReadyPromise;
}

/** Pick the highest-ranked English voice available on this device. */
async function getPreferredVoice(): Promise<SpeechSynthesisVoice | undefined> {
  if (!canSpeak()) return undefined;
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

  // Let SpeechSynthesis process its previous end event before speaking the
  // next message. This avoids messages being dropped in Chrome.
  window.setTimeout(() => void startNextAnnouncement(), 0);
}

async function startNextAnnouncement() {
  if (activeAnnouncement || announcementQueue.length === 0) return;

  const generationAtStart = queueGeneration;
  const item = announcementQueue.shift();
  if (!item || !canSpeak()) {
    item?.onFinish?.();
    return;
  }

  const utterance = new window.SpeechSynthesisUtterance(item.message);

  // Wait for the voice list to be populated so the FIRST announcement uses the
  // natural neural voice rather than the browser's robotic fallback.
  const preferredVoice = await getPreferredVoice();

  // Stop() was called (or everything cleared) while we awaited the voice list.
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

  // Natural, warm assistant delivery — close to a real person's speaking rate.
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

  // Update the hotel/admin panel at the same moment the spoken message begins.
  item.onStart?.(item.message);

  active.stopTimer = window.setTimeout(() => {
    if (activeAnnouncement?.item !== item) return;
    try {
      window.speechSynthesis.cancel();
    } catch {
      // The visual alert still closes even if the speech engine fails.
    }
    finishActiveAnnouncement(item);
  }, MAX_ORDER_VOICE_DURATION_MS);

  try {
    window.speechSynthesis.speak(utterance);
  } catch {
    finishActiveAnnouncement(item);
  }
}

function queueAnnouncement(message: string, callbacks: VoiceAnnouncementCallbacks = {}): boolean {
  if (!canSpeak()) return false;
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
 * Warms the browser voice list after the first user interaction (no audio is
 * played). Call this on dashboard load / first gesture so the voice list is
 * ready before an order ever arrives.
 */
export function prepareOrderVoiceAnnouncements(): boolean {
  if (!canSpeak()) return false;
  try {
    window.speechSynthesis.getVoices();
    void getVoices(); // start loading + cache the list
    return true;
  } catch {
    return false;
  }
}

/**
 * Announce a newly placed order from any table returned by the all-table admin
 * endpoint. Deliberately concise (a few seconds of speech).
 */
export function announceOrderReceived(order: OrderAlert, callbacks: VoiceAnnouncementCallbacks = {}): boolean {
  return queueAnnouncement(
    `You have received a new order from ${tableLabel(order)}. Please check the order panel.`,
    callbacks
  );
}

/** Announce that a customer has pressed the "Call Waiter" button. */
export function announceWaiterCall(
  table: { tableName?: string; tableNumber: number },
  callbacks: VoiceAnnouncementCallbacks = {}
): boolean {
  return queueAnnouncement(
    `Attention please. ${tableLabel(table)} is requesting a waiter. Please attend to the table.`,
    callbacks
  );
}

/** A manual preview that lets staff confirm the installed natural voice. */
export function previewOrderVoiceAnnouncement(callbacks: VoiceAnnouncementCallbacks = {}): boolean {
  return queueAnnouncement(
    'This is your AI restaurant assistant. You have received a new order from Table 1. Please check the order panel.',
    callbacks
  );
}

/** Stops the current spoken message and clears any waiting messages. */
export function stopOrderVoiceAnnouncements(): void {
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
    if (canSpeak()) window.speechSynthesis.cancel();
  } catch {
    // Ignore browser speech cancellation failures.
  }
  active.item.onFinish?.();
}
