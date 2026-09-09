"use strict";

const SAMPLE_RATE = 16000;
const PADDING_SAMPLES = SAMPLE_RATE / 2;
const NORMALIZATION_FILTER = "dynaudnorm=f=150:g=5:m=50:r=0.2:p=0.95";
const MODEL_SHA256 = "9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6";

// Keep padding around speech, including quiet consonants. Neighbouring regions
// overlap deliberately; merge them before copying so words cannot be duplicated.
function prepareSpeechPcm(pcm, speechRegions) {
  const sampleCount = pcm.length / 2;
  const regions = [];
  for (const { start, end } of speechRegions) {
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 0 ||
      end <= start ||
      end > sampleCount
    )
      throw new Error("Invalid speech detector boundaries");
    const region = [
      Math.max(0, start - PADDING_SAMPLES),
      Math.min(sampleCount, end + PADDING_SAMPLES),
    ];
    const previous = regions.at(-1);
    if (previous && region[0] < previous[0]) throw new Error("Speech regions are out of order");
    if (previous && region[0] <= previous[1]) previous[1] = Math.max(previous[1], region[1]);
    else regions.push(region);
  }
  // A missed detection must not silently erase a quiet utterance. Existing
  // non-speech handling remains responsible for these recordings.
  if (!regions.length) return { pcm, mode: "unchanged", regions: 0 };
  const end = regions.at(-1)[1];
  const hasLongGap = regions.some(
    ([start], i) => start - (regions[i - 1]?.[1] || 0) > 2 * SAMPLE_RATE
  );
  const hasNoiseTail = sampleCount - end > 2 * SAMPLE_RATE;
  if (!hasLongGap && !hasNoiseTail) {
    // Even a short breath after speech can seed a closing phrase. Always use
    // the detected endpoint; leave the volume and internal timing intact here.
    return { pcm: pcm.subarray(0, end * 2), mode: "tail", regions: regions.length };
  }
  return {
    pcm: Buffer.concat(
      regions.flatMap(([start, stop]) => [
        pcm.subarray(start * 2, stop * 2),
        Buffer.alloc(PADDING_SAMPLES * 2),
      ])
    ),
    mode: "cleanup",
    regions: regions.length,
  };
}

function detectSpeechRegions(pcm, modelPath) {
  const { Vad } = require("sherpa-onnx-node");
  const samples = new Float32Array(pcm.length / 2);
  for (let i = 0; i < samples.length; i++) samples[i] = pcm.readInt16LE(i * 2) / 32768;
  const detector = new Vad(
    {
      sileroVad: {
        model: modelPath,
        threshold: 0.3,
        minSilenceDuration: 0.5,
        minSpeechDuration: 0.15,
        windowSize: 512,
        maxSpeechDuration: 60,
      },
      sampleRate: SAMPLE_RATE,
      numThreads: 1,
      provider: "cpu",
      debug: 0,
    },
    90
  );
  const regions = [];
  const drain = () => {
    while (!detector.isEmpty()) {
      // Electron's V8 sandbox does not support external ArrayBuffers. Ask the
      // native wrapper to copy its samples rather than expose native memory.
      const segment = detector.front(false);
      regions.push({
        start: segment.start,
        end: Math.min(samples.length, segment.start + segment.samples.length),
      });
      detector.pop();
    }
  };
  for (let offset = 0; offset < samples.length; offset += 512) {
    detector.acceptWaveform(samples.subarray(offset, offset + 512));
    drain();
  }
  detector.flush();
  drain();
  return regions;
}

module.exports = { prepareSpeechPcm, detectSpeechRegions, MODEL_SHA256, NORMALIZATION_FILTER };
