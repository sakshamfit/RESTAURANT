/**
 * Audible alerts for the admin dashboard, generated with the Web Audio API so
 * they need NO audio files and work offline / on every device.
 *
 *  - `playWaiterSiren()` / `stopWaiterSiren()` — the loud, repeating "service
 *    bell / buzzer" alarm that fires when a customer presses "Call Waiter". It
 *    keeps ringing until staff attend the table or stop it, exactly like a real
 *    restaurant call bell.
 *  - `playOrderChime()` — a short pleasant two-note "ding-dong" that leads into
 *    the spoken new-order voice announcement.
 *  - `playTestSiren()` — a short self-test so staff can confirm the buzzer works.
 *
 * Browser autoplay rules: audio can only start after a user gesture. The
 * dashboard calls `unlockAudio()` on the first click/keypress, after which the
 * automatic siren/chime are allowed to play.
 */

type Scheduler = {
  ctx: AudioContext;
  master: GainNode;
  timers: number[];
  stopped: boolean;
};

let ctx: AudioContext | null = null;
let activeScheduler: Scheduler | null = null;

function audioSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    (typeof window.AudioContext !== 'undefined' ||
      typeof (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext !== 'undefined')
  );
}

/** Lazily create (and resume) the shared AudioContext. */
function getContext(): AudioContext | null {
  if (!audioSupported()) return null;
  if (!ctx) {
    const Ctor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    try {
      ctx = new Ctor();
    } catch {
      return null;
    }
  }
  if (ctx.state === 'suspended') {
    ctx.resume().catch(() => {
      // The context will resume on the next user gesture via unlockAudio().
    });
  }
  return ctx;
}

/**
 * Call on the first user gesture. Creates/resumes the AudioContext so later
 * automatic alarms are permitted by the browser's autoplay policy.
 */
export function unlockAudio(): boolean {
  const audio = getContext();
  if (!audio) return false;
  if (audio.state === 'suspended') {
    audio.resume().catch(() => undefined);
  }
  return true;
}

/** True when the waiter siren/buzzer is currently ringing. */
export function isWaiterSirenPlaying(): boolean {
  return activeScheduler !== null;
}

/**
 * Play a single bright service-bell "ding" at a given time.
 * A bell has two inharmonic partials with a fast exponential decay.
 */
function scheduleBell(audio: AudioContext, destination: AudioNode, when: number, peak = 0.5) {
  const partials: { freq: number; gain: number; decay: number }[] = [
    { freq: 1760, gain: peak, decay: 0.9 }, // A6 — the bright strike
    { freq: 2637, gain: peak * 0.5, decay: 0.55 }, // E7 — shimmer
    { freq: 3520, gain: peak * 0.25, decay: 0.35 }, // A7 — high sparkle
  ];

  partials.forEach(({ freq, gain, decay }) => {
    const osc = audio.createOscillator();
    const g = audio.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, when);

    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(gain, when + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, when + decay);

    osc.connect(g);
    g.connect(destination);
    osc.start(when);
    osc.stop(when + decay + 0.05);
  });
}

/**
 * The underlying "buzzer": a sawtooth-ish tone that sweeps between two
 * frequencies (classic pager/siren wobble). Scheduled continuously while a
 * waiter call is pending.
 */
function scheduleSirenWail(audio: AudioContext, destination: AudioNode, when: number, duration: number) {
  const osc = audio.createOscillator();
  const g = audio.createGain();
  osc.type = 'square';

  // Two up/down sweeps per wail window — unmistakable "buzzer" cadence.
  const cycles = 2;
  const low = 520;
  const high = 880;
  osc.frequency.setValueAtTime(low, when);
  for (let i = 0; i < cycles; i++) {
    const start = when + (duration / cycles) * i;
    osc.frequency.linearRampToValueAtTime(high, start + duration / cycles / 2);
    osc.frequency.linearRampToValueAtTime(low, start + duration / cycles);
  }

  g.gain.setValueAtTime(0.0001, when);
  g.gain.exponentialRampToValueAtTime(0.18, when + 0.05);
  g.gain.setValueAtTime(0.18, when + duration - 0.08);
  g.gain.exponentialRampToValueAtTime(0.0001, when + duration);

  osc.connect(g);
  g.connect(destination);
  osc.start(when);
  osc.stop(when + duration + 0.05);
}

/**
 * Start the repeating waiter-call alarm: a loud bell "ding-ding-ding" followed
 * by a short buzzer wail, looping ~every 3.4s until stopped.
 * Safe to call repeatedly — it will not start a second overlapping alarm.
 */
export function playWaiterSiren(): boolean {
  const audio = getContext();
  if (!audio) return false;

  // Already ringing — don't stack a second scheduler.
  if (activeScheduler && !activeScheduler.stopped) return true;

  stopWaiterSiren(); // clear any stale state

  const master = audio.createGain();
  master.gain.value = 1;
  master.connect(audio.destination);

  // Bells run a touch louder than the wail so the bell reads as the call bell.
  const bellGain = audio.createGain();
  bellGain.gain.value = 1;
  bellGain.connect(master);

  const wailGain = audio.createGain();
  wailGain.gain.value = 1;
  wailGain.connect(master);

  const scheduler: Scheduler = {
    ctx: audio,
    master,
    timers: [],
    stopped: false,
  };
  activeScheduler = scheduler;

  const CYCLE_SECONDS = 3.4;
  const lookahead = 0.2;

  const scheduleCycle = (offset: number) => {
    if (scheduler.stopped) return;

    // Three quick service-bell dings.
    scheduleBell(audio, bellGain, offset + 0.0, 0.55);
    scheduleBell(audio, bellGain, offset + 0.32, 0.55);
    scheduleBell(audio, bellGain, offset + 0.64, 0.6);

    // Buzzer wail under the tail of the bells.
    scheduleSirenWail(audio, wailGain, offset + 1.0, 1.4);
  };

  const startAt = audio.currentTime + lookahead;

  // Schedule the first few cycles up front, then keep topping up on a timer so
  // the alarm runs indefinitely with sample-accurate timing.
  for (let i = 0; i < 2; i++) {
    scheduleCycle(startAt + i * CYCLE_SECONDS);
  }

  let cycleIndex = 2;
  const interval = window.setInterval(() => {
    if (scheduler.stopped) return;
    const now = audio.currentTime;
    // While we're within ~2 cycles of the end of what's scheduled, add more.
    const horizon = startAt + cycleIndex * CYCLE_SECONDS;
    if (horizon - now < CYCLE_SECONDS * 2) {
      scheduleCycle(startAt + cycleIndex * CYCLE_SECONDS);
      cycleIndex += 1;
    }
  }, 700);
  scheduler.timers.push(interval);

  return true;
}

/**
 * Lower (or restore) the siren's volume — used to "duck" the buzzer while the
 * spoken table announcement plays so both are heard clearly.
 */
export function setWaiterSirenDucked(ducked: boolean) {
  if (!activeScheduler || activeScheduler.stopped || !ctx) return;
  const now = ctx.currentTime;
  try {
    // Smoothly lower the whole alarm while the spoken table name plays, then
    // restore full volume when speech finishes so the buzzer stays audible but
    // never drowns out the voice.
    activeScheduler.master.gain.cancelScheduledValues(now);
    activeScheduler.master.gain.setTargetAtTime(ducked ? 0.3 : 1, now, 0.12);
  } catch {
    // ignore timing errors on a torn-down context
  }
}

/** Stop the waiter siren/buzzer immediately. */
export function stopWaiterSiren() {
  const scheduler = activeScheduler;
  activeScheduler = null;
  if (!scheduler) return;

  scheduler.stopped = true;
  scheduler.timers.forEach((t) => window.clearInterval(t));
  scheduler.timers = [];

  try {
    const now = scheduler.ctx.currentTime;
    scheduler.master.gain.cancelScheduledValues(now);
    scheduler.master.gain.setTargetAtTime(0.0001, now, 0.05);
    // Disconnect shortly after the fade-out so the tail isn't clipped hard.
    window.setTimeout(() => {
      try {
        scheduler.master.disconnect();
      } catch {
        // already disconnected
      }
    }, 250);
  } catch {
    try {
      scheduler.master.disconnect();
    } catch {
      // ignore
    }
  }
}

/** Short pleasant two-note chime for a newly received order. */
export function playOrderChime(): boolean {
  const audio = getContext();
  if (!audio) return false;

  const master = audio.createGain();
  master.gain.value = 0.9;
  master.connect(audio.destination);

  const when = audio.currentTime + 0.05;
  // "Ding-dong": bright G6 then a warmer C6.
  scheduleBell(audio, master, when, 0.5);
  // A lower, softer second note (reuse bell with different partials via simple tone).
  const osc = audio.createOscillator();
  const g = audio.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(1046.5, when + 0.18); // C6
  g.gain.setValueAtTime(0.0001, when + 0.18);
  g.gain.exponentialRampToValueAtTime(0.4, when + 0.21);
  g.gain.exponentialRampToValueAtTime(0.0001, when + 0.9);
  osc.connect(g);
  g.connect(master);
  osc.start(when + 0.18);
  osc.stop(when + 1.0);

  window.setTimeout(() => {
    try {
      master.disconnect();
    } catch {
      // ignore
    }
  }, 1200);

  return true;
}

/**
 * Self-test: ring the waiter siren for ~4 seconds so staff can verify the
 * buzzer hardware/volume. Returns true if the test started.
 */
export function playTestSiren(): boolean {
  const started = playWaiterSiren();
  if (!started) return false;
  window.setTimeout(() => stopWaiterSiren(), 4000);
  return true;
}
