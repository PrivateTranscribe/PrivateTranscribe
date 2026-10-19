import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConversePlayer } from "../../../src/helpers/conversePlayer";
import { __resetSharedAudioContextForTests } from "../../../src/utils/sharedAudioContext";

/** Stands in for the renderer's shared AudioContext; keeps every source it hands out. */
class FakeAudioContext {
  static last: FakeAudioContext | null = null;
  state = "running";
  currentTime = 0;
  destination = {};
  sources: any[] = [];

  constructor() {
    FakeAudioContext.last = this;
  }

  createBuffer(_channels: number, length: number, sampleRate: number) {
    const data = new Float32Array(length);
    return {
      length,
      sampleRate,
      data,
      copyToChannel(samples: Float32Array) {
        data.set(samples);
      },
    };
  }

  createBufferSource() {
    const source = { buffer: null, onended: null, connect() {}, start: vi.fn(), stop: vi.fn() };
    this.sources.push(source);
    return source;
  }

  close() {
    this.state = "closed";
  }
}

/** Sentence n's audio is a single sample of value n, so each source names its sentence. */
function harness() {
  const reports: any[] = [];
  const api = {
    readAloudSynth: vi.fn(async ({ text }: { text: string }) => ({
      pcm: Float32Array.of(Number(text.match(/\d+/)![0])),
      sampleRate: 1000,
      synthMs: 1,
    })),
    converseReportPlayerState: (state: unknown) => reports.push(state),
  };
  const player = new ConversePlayer({ api });
  const sources = () => FakeAudioContext.last!.sources;
  return {
    player,
    reports,
    /** Sentence numbers in the order the speakers started them. */
    played: () => sources().map((source) => source.buffer.data[0]),
    /** The playing sentence reaches its end, as the speakers report it. */
    finish: () => sources().at(-1).onended(),
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const sentence = (index: number) => ({ gen: 1, index, text: `Sentence ${index}.` });

describe("Converse playback queue", () => {
  beforeEach(() => {
    (window as any).AudioContext = FakeAudioContext;
  });

  afterEach(() => {
    __resetSharedAudioContextForTests();
    delete (window as any).AudioContext;
    FakeAudioContext.last = null;
  });

  it("plays the next sentence after a tool pause instead of the last one again", async () => {
    const { player, reports, played, finish } = harness();
    player.handleSentence(sentence(0));
    await settle();
    expect(played()).toEqual([0]);

    // Sentence 0 ends while the agent is still running a tool.
    finish();
    await settle();
    const duringPause = reports.at(-1);

    player.handleSentence(sentence(1));
    await settle();
    expect(played()).toEqual([0, 1]);
    // An interrupt during the pause tells the agent from this which sentences were heard.
    expect(duringPause).toMatchObject({ playing: false, playIndex: 1 });
  });

  it("drains a turn whose last sentence ended before the turn end arrived", async () => {
    const { player, reports, finish } = harness();
    player.handleSentence(sentence(0));
    await settle();
    finish();
    await settle();

    player.handleTurnEnd({ gen: 1, total: 1 });
    expect(player.getState().drained).toBe(true);
    expect(reports.at(-1)).toMatchObject({ drained: true });
  });

  it("drains after the last sentence when the turn ends while it plays", async () => {
    const { player, played, finish } = harness();
    player.handleSentence(sentence(0));
    player.handleSentence(sentence(1));
    await settle();
    player.handleTurnEnd({ gen: 1, total: 2 });
    finish();
    await settle();
    expect(player.getState().drained).toBe(false);

    finish();
    await settle();
    expect(played()).toEqual([0, 1]);
    expect(player.getState().drained).toBe(true);
  });
});
