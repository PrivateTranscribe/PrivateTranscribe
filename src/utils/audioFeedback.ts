/**
 * Minimal audio feedback using Web Audio API.
 * No external sound files needed — generates clean tones programmatically.
 */

let audioContext: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (!audioContext) {
    audioContext = new AudioContext();
  }
  return audioContext;
}

function playTone(frequency: number, durationMs: number, volume = 0.15) {
  try {
    const ctx = getAudioContext();
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();

    oscillator.connect(gain);
    gain.connect(ctx.destination);

    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(frequency, ctx.currentTime);

    // Fade in/out to avoid clicks
    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(volume, ctx.currentTime + 0.01);
    gain.gain.linearRampToValueAtTime(0, ctx.currentTime + durationMs / 1000);

    oscillator.start(ctx.currentTime);
    oscillator.stop(ctx.currentTime + durationMs / 1000);
  } catch {
    // Audio feedback is best-effort
  }
}

/** Short ascending tone — recording started */
export function playStartSound() {
  playTone(440, 120, 0.12);
  setTimeout(() => playTone(587, 120, 0.12), 80);
}

/** Short descending tone — recording stopped */
export function playStopSound() {
  playTone(587, 120, 0.12);
  setTimeout(() => playTone(440, 120, 0.12), 80);
}

/** Single soft beep — success */
export function playSuccessSound() {
  playTone(660, 150, 0.1);
}

/** Low tone — error */
export function playErrorSound() {
  playTone(220, 250, 0.12);
}
