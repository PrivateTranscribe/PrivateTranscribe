import { useEffect, useRef, useState } from "react";
import { nextVoiceLevel } from "../utils/voiceBars";

/** Below this the bars cannot show the difference from rest. */
const SETTLED = 0.002;

/**
 * useReadAloudLevel - how loud Read Aloud is speaking, smoothed the way the
 * microphone level is, so the dictation button's bars move with the voice
 * being read exactly as they move with yours.
 *
 * Samples `readLevel` (raw RMS) once a frame while `speaking`. When speaking
 * stops the level falls back to rest, lands exactly on 0 and the frame loop
 * ends, so paused bars hold still and cost nothing.
 *
 * @param {() => number} readLevel
 * @param {boolean} speaking
 * @returns {number} level in [0, 1]
 */
export function useReadAloudLevel(readLevel, speaking) {
  const [level, setLevel] = useState(0);
  const levelRef = useRef(0);

  useEffect(() => {
    let frame = null;
    const tick = () => {
      let next = nextVoiceLevel(levelRef.current, speaking ? readLevel() : 0);
      if (!speaking && next < SETTLED) next = 0;
      levelRef.current = next;
      setLevel(next);
      frame = speaking || next > 0 ? requestAnimationFrame(tick) : null;
    };
    frame = requestAnimationFrame(tick);
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [readLevel, speaking]);

  return level;
}
