import { describe, expect, it } from "vitest";

const { startupReasoningVars } = require("../../../src/helpers/ipcHandlers");

const CLEAR = ["REASONING_PROVIDER", "LOCAL_REASONING_MODEL"];

// main.js loads the local AI model at login whenever these two are saved. The
// model holds gigabytes of memory, so it is loaded only when AI enhancement
// will use it.
describe("startupReasoningVars", () => {
  it("loads the local model at login while AI enhancement is on", () => {
    expect(
      startupReasoningVars({
        reasoningEnabled: true,
        reasoningProvider: "local",
        reasoningModel: "qwen3-8b-q4_k_m",
      })
    ).toEqual({
      set: { REASONING_PROVIDER: "local", LOCAL_REASONING_MODEL: "qwen3-8b-q4_k_m" },
      clear: [],
    });
  });

  it("stops loading it at login once AI enhancement is off", () => {
    expect(
      startupReasoningVars({
        reasoningEnabled: false,
        reasoningProvider: "local",
        reasoningModel: "qwen3-8b-q4_k_m",
      })
    ).toEqual({ set: {}, clear: CLEAR });
  });

  it("clears it for a cloud provider, as before", () => {
    expect(startupReasoningVars({ reasoningEnabled: true, reasoningProvider: "openai" })).toEqual({
      set: {},
      clear: CLEAR,
    });
  });

  it("leaves the saved values alone when the renderer sends no switch", () => {
    // An older window that does not send reasoningEnabled keeps today's behaviour.
    expect(
      startupReasoningVars({ reasoningProvider: "local", reasoningModel: "qwen3-8b-q4_k_m" })
    ).toEqual({
      set: { REASONING_PROVIDER: "local", LOCAL_REASONING_MODEL: "qwen3-8b-q4_k_m" },
      clear: [],
    });
    expect(startupReasoningVars({ reasoningProvider: "local" })).toEqual({ set: {}, clear: [] });
  });
});
