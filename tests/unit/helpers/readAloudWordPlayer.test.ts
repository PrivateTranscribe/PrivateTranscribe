import { describe, expect, it, vi } from "vitest";
import { ReadAloudPlayer } from "../../../src/helpers/readAloudPlayer";

function harness(synth) {
  const sources: any[] = [];
  const ctx: any = {
    currentTime: 0,
    state: "running",
    destination: {},
    createBuffer(_channels, length, sampleRate) {
      const data = new Float32Array(length);
      return {
        length,
        sampleRate,
        duration: length / sampleRate,
        copyToChannel(samples, _channel, offset = 0) {
          data.set(samples, offset);
        },
        getChannelData() {
          return data;
        },
      };
    },
    createBufferSource() {
      const source = { connect() {}, start: vi.fn(), stop: vi.fn() };
      sources.push(source);
      return source;
    },
  };
  const api = {
    readAloudLoadEngine: async () => ({ loaded: true }),
    readAloudSplit: async (text) => [text],
    readAloudSynth: vi.fn(synth),
  };
  const player = new ReadAloudPlayer({ api });
  player.getContext = () => ctx;
  return { player, ctx, sources, api };
}
function audio(text = "one two") {
  return {
    pcm: new Float32Array(2000).fill(0.1),
    sampleRate: 1000,
    synthMs: 1,
    wordTimings: [
      {
        text: text.split(" ")[0],
        start: 0,
        end: text.split(" ")[0].length,
        startTime: 0.1,
        endTime: 0.4,
      },
      { text: "two", start: 4, end: 7, startTime: 0.5, endTime: 1.8 },
    ],
  };
}
describe("Read Aloud word playback clock", () => {
  it("uses the audible clock and holds a word through the gap before the next", async () => {
    const { player, ctx } = harness(async () => audio());
    await player.speak("one two");
    ctx.currentTime = 0.55;
    ctx.getOutputTimestamp = () => ({ contextTime: 0.45 });
    expect(player.getState().currentWord.text).toBe("one");
    ctx.getOutputTimestamp = () => ({ contextTime: 0.6 });
    expect(player.getState().currentWord.text).toBe("two");
    player.stop();
    expect(player.getState().currentWord).toBeNull();
  });
  it("keeps its word while paused and resumes the same cached buffer", async () => {
    const { player, ctx, api, sources } = harness(async () => audio());
    await player.speak("one two");
    ctx.currentTime = 0.7;
    player.pause();
    ctx.currentTime = 8;
    expect(player.getState().currentWord.text).toBe("two");
    await player.playFrom(0, player.offset);
    expect(sources[1].buffer).toBe(sources[0].buffer);
    expect(player.getState().currentWord.text).toBe("two");
    expect(api.readAloudSynth).toHaveBeenCalledTimes(1);
    player.stop();
  });
  it("does not schedule a late tail after pause and resumes those same chunks", async () => {
    let resolveTail;
    const text =
      "A quiet morning makes room for a little reading, while the rest of the world begins another busy day.";
    const { player, ctx, api, sources } = harness(({ text }) => {
      if (api.readAloudSynth.mock.calls.length === 1) return Promise.resolve(audio(text));
      return new Promise((resolve) => {
        resolveTail = () => resolve(audio(text));
      });
    });
    await player.speak(text);
    await vi.waitFor(() => expect(resolveTail).toBeTypeOf("function"));
    ctx.currentTime = 0.2;
    player.pause();
    resolveTail();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sources).toHaveLength(1);
    expect(player.pendingSource).toBeNull();
    await player.playFrom(0, player.offset);
    expect(api.readAloudSynth).toHaveBeenCalledTimes(2);
    expect(sources[1].buffer.duration).toBe(4);
    expect(sources[1].start).toHaveBeenCalledWith(0, 0.2);
    player.stop();
  });
});
