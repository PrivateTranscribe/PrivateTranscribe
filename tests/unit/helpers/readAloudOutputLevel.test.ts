import { describe, expect, it, vi } from "vitest";
import { ReadAloudPlayer, rmsAround } from "../../../src/helpers/readAloudPlayer";
import { nextVoiceLevel } from "../../../src/utils/voiceBars";

// The dictation button's bars follow the voice Read Aloud is speaking. The
// level comes from the decoded audio at the position the listener hears, so
// these pin which audio is read and where.

function buffer(samples: Float32Array, sampleRate: number) {
  return { sampleRate, getChannelData: () => samples };
}

function harness(pcm: Float32Array, sampleRate = 1000) {
  const ctx: any = {
    currentTime: 0,
    state: "running",
    destination: {},
    createBuffer(_channels, length, rate) {
      const data = new Float32Array(length);
      return {
        length,
        sampleRate: rate,
        duration: length / rate,
        copyToChannel(samples, _channel, offset = 0) {
          data.set(samples, offset);
        },
        getChannelData() {
          return data;
        },
      };
    },
    createBufferSource() {
      return { connect() {}, start: vi.fn(), stop: vi.fn() };
    },
  };
  const api = {
    readAloudLoadEngine: async () => ({ loaded: true }),
    readAloudSplit: async (text) => [text],
    readAloudSynth: vi.fn(async () => ({ pcm, sampleRate, synthMs: 1, wordTimings: [] })),
  };
  const player = new ReadAloudPlayer({ api });
  player.getContext = () => ctx;
  return { player, ctx };
}

/** One second of silence, then one second at a steady 0.3. */
function quietThenLoud() {
  const pcm = new Float32Array(2000);
  pcm.fill(0.3, 1000);
  return pcm;
}

describe("rmsAround", () => {
  it("measures the window around a moment of the audio", () => {
    const audio = buffer(quietThenLoud(), 1000);
    expect(rmsAround(audio, 0.5)).toBe(0);
    expect(rmsAround(audio, 1.5)).toBeCloseTo(0.3, 6);
    // Straddling the step, half the window is loud.
    expect(rmsAround(audio, 1.0, 0.1)).toBeCloseTo(Math.sqrt(0.09 / 2), 6);
  });

  it("is silent outside the audio", () => {
    const audio = buffer(quietThenLoud(), 1000);
    expect(rmsAround(audio, -1)).toBe(0);
    expect(rmsAround(audio, 5)).toBe(0);
  });
});

describe("Read Aloud output level", () => {
  it("follows the audio at the position the listener hears", async () => {
    const { player, ctx } = harness(quietThenLoud());
    await player.speak("one two");
    ctx.getOutputTimestamp = () => ({ contextTime: 0.5 });
    expect(player.getOutputLevel()).toBe(0);
    ctx.getOutputTimestamp = () => ({ contextTime: 1.5 });
    expect(player.getOutputLevel()).toBeCloseTo(0.3, 6);
    player.stop();
  });

  it("is silent while paused or stopped, whatever the buffer holds", async () => {
    const { player, ctx } = harness(quietThenLoud());
    await player.speak("one two");
    ctx.currentTime = 1.5;
    player.pause();
    expect(player.getOutputLevel()).toBe(0);
    player.stop();
    expect(player.getOutputLevel()).toBe(0);
  });

  it("reads the first chunk while the rest of the first sentence is synthesized", async () => {
    const text =
      "A quiet morning makes room for a little reading, while the rest of the world begins another busy day.";
    const { player, ctx } = harness(new Float32Array(2000).fill(0.2));
    // The tail never lands, so only the head chunk is playing.
    let calls = 0;
    (player.api.readAloudSynth as any).mockImplementation(async () => {
      calls += 1;
      if (calls > 1) return new Promise(() => {});
      return {
        pcm: new Float32Array(2000).fill(0.2),
        sampleRate: 1000,
        synthMs: 1,
        wordTimings: [],
      };
    });
    await player.speak(text);
    expect(player.firstChunks).not.toBeNull();
    expect(player.cache.has(0)).toBe(false);
    ctx.getOutputTimestamp = () => ({ contextTime: 0.3 });
    expect(player.getOutputLevel()).toBeGreaterThan(0.1);
    player.stop();
  });
});

describe("nextVoiceLevel", () => {
  it("rises fast and falls slowly, within 0-1", () => {
    const up = nextVoiceLevel(0, 0.25);
    expect(up).toBeCloseTo(0.35, 6);
    const down = nextVoiceLevel(1, 0);
    expect(down).toBeCloseTo(0.9, 6);
    expect(nextVoiceLevel(0, 10)).toBeLessThanOrEqual(1);
    expect(nextVoiceLevel(0, -1)).toBe(0);
  });

  it("settles on the level a steady voice holds", () => {
    let level = 0;
    for (let frame = 0; frame < 200; frame++) level = nextVoiceLevel(level, 0.125);
    expect(level).toBeCloseTo(0.5, 6);
  });
});
