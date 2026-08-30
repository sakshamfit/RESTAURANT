import type { Order } from '../types';

/**
 * A spoken order alert is intentionally kept short and is forcibly stopped at
 * this limit. The queue makes sure two tables ordering at the same time never
 * talk over one another.
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

const FEMALE_VOICE_NAME_HINTS = [
  // Common browser/system voice names. The Web Speech API does not expose a
  // gender field, so these are used to prefer an available feminine voice.
  'female',
  'woman',
  'zira',
  'susan',
  'hazel',
  'samantha',
  'victoria',
  'karen',
  'moira',
  'tessa',
  'veena',
  'lekha',
  'priya',
  'sangeeta',
  'heera',
  'raveena',
  'swara',
  'aria',
  'jenny',
  'sonia',
  'natasha',
  'libby',
  'ava',
  'allison',
  'serena',
  'emma',
  'olivia',
  'linda',
  'kathy',
  'salli',
  'joanna',
  'ivy',
  'kimberly',
  'amy',
  'nicky',
] as const;

let announcementQueue: QueuedAnnouncement[] = [];
let activeAnnouncement: {
  item: QueuedAnnouncement;
  utterance: SpeechSynthesisUtterance;
  stopTimer: number | null;
  finished: boolean;
} | null = null;

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

/**
 * Choose an English feminine voice where the operating system provides one.
 * The voice list is device-specific; if a named feminine voice is unavailable,
 * an Indian English voice is preferred before the browser's default English
 * voice so every supported device can still receive the announcement.
 */
function getPreferredFemaleVoice(): SpeechSynthesisVoice | undefined {
  if (!canSpeak()) return undefined;

  const voices = window.speechSynthesis.getVoices();
  return (
    voices.find((voice) => isEnglishVoice(voice) && isFemaleNamedVoice(voice) && isIndianEnglishVoice(voice)) ||
    voices.find((voice) => isEnglishVoice(voice) && isFemaleNamedVoice(voice)) ||
    voices.find((voice) => isIndianEnglishVoice(voice)) ||
    voices.find((voice) => isEnglishVoice(voice)) ||
    voices.find((voice) => voice.default) ||
    voices[0]
  );
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
  // next table's message. This avoids messages being dropped in Chrome.
  window.setTimeout(startNextAnnouncement, 0);
}

function startNextAnnouncement() {
  if (activeAnnouncement || announcementQueue.length === 0) return;

  const item = announcementQueue.shift();
  if (!item || !canSpeak()) return;

  const utterance = new window.SpeechSynthesisUtterance(item.message);
  const preferredVoice = getPreferredFemaleVoice();
  if (preferredVoice) {
    utterance.voice = preferredVoice;
    utterance.lang = preferredVoice.lang || 'en-IN';
  } else {
    utterance.lang = 'en-IN';
  }

  // A calm, clear assistant voice. The sentence is normally only a few
  // seconds long; the safety timer below enforces the 15-second hard limit.
  utterance.rate = 0.92;
  utterance.pitch = 1.08;
  utterance.volume = 1;

  const active = {
    item,
    utterance,
    stopTimer: null as number | null,
    finished: false,
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
      // The visual alert still closes even if the browser speech engine fails.
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
  startNextAnnouncement();
  return true;
}

function tableLabel(order: OrderAlert): string {
  const label = order.tableName?.trim();
  // Keep a custom table label from making the spoken message unexpectedly long.
  return (label || `Table ${order.tableNumber}`).slice(0, 80);
}

/**
 * Warm the browser's installed voice list after the first user interaction.
 * This does not play any sound. It simply gives later automatic order alerts
 * the best available feminine voice choice.
 */
export function prepareOrderVoiceAnnouncements(): boolean {
  if (!canSpeak()) return false;
  try {
    window.speechSynthesis.getVoices();
    return true;
  } catch {
    return false;
  }
}

/**
 * Announces an order from any table returned by the all-table admin endpoint.
 * The message is deliberately concise and has a strict 15-second maximum.
 */
export function announceOrderReceived(order: OrderAlert, callbacks: VoiceAnnouncementCallbacks = {}): boolean {
  return queueAnnouncement(
    `You have received a new order from ${tableLabel(order)}. Please check the order panel.`,
    callbacks
  );
}

/** A manual preview that lets staff confirm the installed feminine voice. */
export function previewOrderVoiceAnnouncement(callbacks: VoiceAnnouncementCallbacks = {}): boolean {
  return queueAnnouncement(
    'This is the AI order assistant. You have received a new order from Table 1. Please check the order panel.',
    callbacks
  );
}

/** Stops the current spoken message and clears any waiting table messages. */
export function stopOrderVoiceAnnouncements(): void {
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
