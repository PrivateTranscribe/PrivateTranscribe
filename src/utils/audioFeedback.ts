/**
 * Minimal audio feedback using Web Audio API.
 * No external sound files needed — generates clean tones programmatically.
 */

let audioContext: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (!audioContext) {
    audioContext = new AudioContext();
  }
  // Resume if suspended (browsers/Electron may suspend until user gesture)
  if (audioContext.state === "suspended") {
    audioContext.resume();
  }
  return audioContext;
}

/**
 * Play a shaped tone with smooth envelope.
 * Uses a combination of oscillator types for a warmer, more pleasant sound.
 */
function playNote(
  frequency: number,
  durationMs: number,
  {
    volume = 0.12,
    type = "sine" as OscillatorType,
    attackMs = 10,
    releaseMs = 60,
    delayMs = 0,
  } = {}
) {
  try {
    const ctx = getAudioContext();
    const startTime = ctx.currentTime + delayMs / 1000;
    const duration = durationMs / 1000;
    const attack = Math.min(attackMs / 1000, duration * 0.3);
    const release = Math.min(releaseMs / 1000, duration * 0.5);

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.type = type;
    osc.frequency.setValueAtTime(frequency, startTime);

    // Smooth envelope: silence → attack → sustain → release → silence
    gain.gain.setValueAtTime(0, startTime);
    gain.gain.linearRampToValueAtTime(volume, startTime + attack);
    gain.gain.setValueAtTime(volume, startTime + duration - release);
    gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);

    osc.start(startTime);
    osc.stop(startTime + duration + 0.05);
  } catch {
    // Audio feedback is best-effort — never crash
  }
}

/**
 * Pleasant two-note chime — recording started.
 * G3 → B3 (soft major third, low register = calm "ready")
 */
export function playStartSound() {
  playNote(196, 180, { volume: 0.06, type: "sine", attackMs: 8, releaseMs: 120 });
  playNote(247, 200, { volume: 0.06, type: "sine", attackMs: 8, releaseMs: 150, delayMs: 130 });
}

/**
 * Soft descending chime — recording stopped / processing.
 * B3 → G3 (downward = "done")
 */
export function playStopSound() {
  playNote(247, 160, { volume: 0.05, type: "sine", attackMs: 8, releaseMs: 120 });
  playNote(196, 200, { volume: 0.05, type: "sine", attackMs: 8, releaseMs: 150, delayMs: 110 });
}

/**
 * Gentle success tone — transcription completed.
 * D4, soft ring-out.
 */
export function playSuccessSound() {
  playNote(293, 250, { volume: 0.05, type: "sine", attackMs: 8, releaseMs: 200 });
}

/**
 * Low soft tone — error occurred.
 * A2, long fade.
 */
export function playErrorSound() {
  playNote(110, 350, { volume: 0.06, type: "triangle", attackMs: 15, releaseMs: 280 });
}
