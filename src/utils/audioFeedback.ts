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
 * A4 → C#5 (major third, upward = "beginning")
 */
export function playStartSound() {
  playNote(440, 140, { volume: 0.1, type: "sine", attackMs: 5, releaseMs: 80 });
  playNote(554, 160, { volume: 0.1, type: "sine", attackMs: 5, releaseMs: 100, delayMs: 90 });
}

/**
 * Soft descending chime — recording stopped / processing.
 * C#5 → A4 (same interval, downward = "done")
 */
export function playStopSound() {
  playNote(554, 130, { volume: 0.08, type: "sine", attackMs: 5, releaseMs: 70 });
  playNote(440, 170, { volume: 0.08, type: "sine", attackMs: 5, releaseMs: 110, delayMs: 80 });
}

/**
 * Bright success ping — transcription completed successfully.
 * E5 with a gentle ring-out.
 */
export function playSuccessSound() {
  playNote(659, 200, { volume: 0.08, type: "sine", attackMs: 5, releaseMs: 150 });
}

/**
 * Low soft tone — error occurred.
 * A3, longer sustain to feel distinct from the chimes.
 */
export function playErrorSound() {
  playNote(220, 300, { volume: 0.1, type: "triangle", attackMs: 10, releaseMs: 200 });
}
