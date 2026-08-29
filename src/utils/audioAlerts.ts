// Web Audio API Sound Synthesizer for Kitchen Loud Siren & Order Alerts

let audioCtx: AudioContext | null = null;
let activeSirenOscillators: { osc1: OscillatorNode; osc2?: OscillatorNode; gain: GainNode }[] = [];
let sirenLoopTimer: number | null = null;

function getAudioContext(): AudioContext | null {
  try {
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioContextClass) return null;
    if (!audioCtx) {
      audioCtx = new AudioContextClass();
    }
    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
    return audioCtx;
  } catch (e) {
    console.warn('Web Audio API not supported or blocked:', e);
    return null;
  }
}

/**
 * User gesture audio unlock for iOS Safari and Android Chrome
 */
export function unlockAudio(): boolean {
  const ctx = getAudioContext();
  if (!ctx) return false;
  if (ctx.state === 'suspended') {
    ctx.resume();
  }
  // Play short silent buffer to prime audio engine
  try {
    const buffer = ctx.createBuffer(1, 1, 22050);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.start(0);
  } catch {
    // Ignore
  }
  return true;
}

/**
 * High-Volume Loud Siren Alert (सायरन)
 * Generates an oscillating dual-tone emergency siren with pulsing bursts
 */
export function playLoudOrderSiren(durationSeconds = 4): void {
  const ctx = getAudioContext();
  if (!ctx) return;

  // Stop any currently running siren first
  stopSiren();

  try {
    const now = ctx.currentTime;
    const masterGain = ctx.createGain();
    masterGain.gain.setValueAtTime(0.85, now); // High loud volume
    masterGain.connect(ctx.destination);

    // Primary High Frequency Tone (Oscillates between 980Hz and 680Hz)
    const osc1 = ctx.createOscillator();
    osc1.type = 'sawtooth';
    
    // Frequency Modulation for true siren sweep
    const modCycles = Math.floor(durationSeconds / 0.35);
    for (let i = 0; i < modCycles; i++) {
      const cycleStart = now + i * 0.35;
      osc1.frequency.setValueAtTime(980, cycleStart);
      osc1.frequency.exponentialRampToValueAtTime(650, cycleStart + 0.18);
      osc1.frequency.exponentialRampToValueAtTime(980, cycleStart + 0.35);
    }

    // Secondary Sub Tone for punchy kitchen alarm body (Square wave)
    const osc2 = ctx.createOscillator();
    osc2.type = 'square';
    for (let i = 0; i < modCycles; i++) {
      const cycleStart = now + i * 0.35;
      osc2.frequency.setValueAtTime(490, cycleStart);
      osc2.frequency.exponentialRampToValueAtTime(325, cycleStart + 0.18);
      osc2.frequency.exponentialRampToValueAtTime(490, cycleStart + 0.35);
    }

    const subGain = ctx.createGain();
    subGain.gain.setValueAtTime(0.4, now);

    osc1.connect(masterGain);
    osc2.connect(subGain);
    subGain.connect(masterGain);

    // Envelope
    masterGain.gain.setValueAtTime(0.85, now);
    masterGain.gain.setValueAtTime(0.85, now + durationSeconds - 0.2);
    masterGain.gain.exponentialRampToValueAtTime(0.001, now + durationSeconds);

    osc1.start(now);
    osc2.start(now);

    osc1.stop(now + durationSeconds);
    osc2.stop(now + durationSeconds);

    activeSirenOscillators.push({ osc1, osc2, gain: masterGain });
  } catch (e) {
    console.warn('Failed to synthesize loud siren:', e);
  }
}

/**
 * Stop any running siren
 */
export function stopSiren(): void {
  if (sirenLoopTimer) {
    clearTimeout(sirenLoopTimer);
    sirenLoopTimer = null;
  }
  for (const item of activeSirenOscillators) {
    try {
      item.gain.gain.setValueAtTime(0, 0);
      item.osc1.stop();
      item.osc2?.stop();
    } catch {
      // Ignore already stopped
    }
  }
  activeSirenOscillators = [];
}

/**
 * Crisp QR Scan Success Beep
 */
export function playScanSuccessBeep(): void {
  const ctx = getAudioContext();
  if (!ctx) return;

  try {
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(1400, now);
    osc.frequency.setValueAtTime(1850, now + 0.08);

    gain.gain.setValueAtTime(0.4, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(now);
    osc.stop(now + 0.25);
  } catch (e) {
    console.warn('Failed to play scan beep:', e);
  }
}

/**
 * Order Placed / Bell Chime
 */
export function playBellChime(): void {
  const ctx = getAudioContext();
  if (!ctx) return;

  try {
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(880, now); // A5
    osc.frequency.setValueAtTime(1174.66, now + 0.12); // D6

    gain.gain.setValueAtTime(0.5, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.8);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(now);
    osc.stop(now + 0.8);
  } catch {
    // Ignore
  }
}

/**
 * Customer Order Placed Sound
 */
export function playCustomerOrderSuccessSound(): void {
  const ctx = getAudioContext();
  if (!ctx) return;

  try {
    const now = ctx.currentTime;
    const notes = [523.25, 659.25, 783.99, 1046.5]; // C5, E5, G5, C6 (Major Arpeggio)
    notes.forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now + idx * 0.1);

      gain.gain.setValueAtTime(0.35, now + idx * 0.1);
      gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.1 + 0.45);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(now + idx * 0.1);
      osc.stop(now + idx * 0.1 + 0.45);
    });
  } catch {
    // Ignore
  }
}

/**
 * Order Received / Accepted in Kitchen Sound
 */
export function playOrderAcceptedSound(): void {
  const ctx = getAudioContext();
  if (!ctx) return;

  try {
    const now = ctx.currentTime;
    // Pleasant double ding
    [880, 1318.51].forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, now + idx * 0.15);

      gain.gain.setValueAtTime(0.4, now + idx * 0.15);
      gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.15 + 0.6);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(now + idx * 0.15);
      osc.stop(now + idx * 0.15 + 0.6);
    });
  } catch {
    // Ignore
  }
}

/**
 * Order Ready Sound
 */
export function playOrderReadySound(): void {
  const ctx = getAudioContext();
  if (!ctx) return;

  try {
    const now = ctx.currentTime;
    // Triple celebration chime
    [659.25, 880, 1174.66].forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now + idx * 0.12);

      gain.gain.setValueAtTime(0.45, now + idx * 0.12);
      gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.12 + 0.7);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(now + idx * 0.12);
      osc.stop(now + idx * 0.12 + 0.7);
    });
  } catch {
    // Ignore
  }
}

/**
 * Web Browser Push / Toast Notification Helper
 */
export function requestNotificationPermission(): void {
  if (typeof window !== 'undefined' && 'Notification' in window) {
    if (Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }
  }
}

export function sendBrowserNotification(title: string, bodyText: string): void {
  if (typeof window !== 'undefined' && 'Notification' in window) {
    if (Notification.permission === 'granted') {
      try {
        new Notification(title, {
          body: bodyText,
          icon: 'https://images.unsplash.com/photo-1576092768241-dec231879fc3?auto=format&fit=crop&w=128&q=80',
        });
      } catch (e) {
        console.warn('Browser notification error:', e);
      }
    } else if (Notification.permission === 'default') {
      Notification.requestPermission().then((perm) => {
        if (perm === 'granted') {
          try {
            new Notification(title, {
              body: bodyText,
              icon: 'https://images.unsplash.com/photo-1576092768241-dec231879fc3?auto=format&fit=crop&w=128&q=80',
            });
          } catch {}
        }
      }).catch(() => {});
    }
  }
}
