"use strict";

const { normalizeTranscript, scoreLongDictation } = require("./long-dictation-test-utils");

function createWav(pcm) {
  if (pcm.length % 2) throw new Error("PCM16 must contain complete samples");
  const header = Buffer.alloc(44);
  header.write("RIFF");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function scalePcm(pcm, multiplier) {
  const result = Buffer.from(pcm);
  for (let i = 0; i < result.length; i += 2) {
    const sample = Math.round(result.readInt16LE(i) * multiplier);
    result.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), i);
  }
  return result;
}

function scoreCase(testCase, text) {
  const score = scoreLongDictation(
    {
      referenceText: testCase.reference,
      boundaryChecks: [{ label: "ending", text: testCase.ending }],
    },
    text,
    { maximumWordErrorRate: 0.2, minimumBoundaryRecall: 0.9 }
  );
  const countThanks = (value) => (normalizeTranscript(value).match(/\bthank you\b/g) || []).length;
  const unexpectedThanks = countThanks(text) > countThanks(testCase.reference);
  const missingThanks = countThanks(text) < countThanks(testCase.reference);
  // A two-word error allowance hides the exact hallucination being tested.
  // These short fixtures have known exact wording; punctuation is immaterial.
  const exactMatch = normalizeTranscript(text) === normalizeTranscript(testCase.reference);
  return {
    ...score,
    unexpectedThanks,
    missingThanks,
    exactMatch,
    passed: score.passed && !unexpectedThanks && !missingThanks && (!testCase.exact || exactMatch),
  };
}

function buildCases({ speech, manifest, banana, breath, thanks }) {
  const cases = [];
  const silence = (seconds) => Buffer.alloc(Math.round(seconds * 32000));
  const join = (...parts) => Buffer.concat(parts.flat());
  const add = (name, pcm, reference, ending = reference, exact = false) =>
    cases.push({ name, pcm, reference, ending, exact });
  for (const seconds of [60, 180, 240, 399]) {
    const clips = manifest.clips.filter((clip) => clip.endSeconds <= seconds);
    const end = clips.at(-1).endSeconds;
    const audio = speech.subarray(0, Math.round(end * 16000) * 2);
    const reference = clips.map((clip) => clip.text).join(" ");
    const ending = clips
      .slice(-2)
      .map((clip) => clip.text)
      .join(" ");
    add(`speech-${seconds}s`, join(audio, silence(2)), reference, ending);
    if (seconds === 240) {
      add("four-minute-breath-tail", join(audio, Array(6).fill(breath)), reference, ending);
      const quietAt = Math.round((end - 60) * 16000) * 2;
      add(
        "four-minute-quiet-last-minute",
        join(audio.subarray(0, quietAt), scalePcm(audio.subarray(quietAt), 0.03), silence(2)),
        reference,
        ending
      );
      const pauseAt =
        Math.round(clips.find((clip) => clip.startSeconds >= 170).startSeconds * 16000) * 2;
      add(
        "four-minute-mid-pause",
        join(audio.subarray(0, pauseAt), silence(40), audio.subarray(pauseAt), silence(2)),
        reference,
        ending
      );
    }
  }
  const reference = "I put the banana in my backpack yesterday.";
  const spoken = banana.subarray(0, 3.8 * 32000);
  for (const gap of [25, 35]) {
    add(
      `short-speech-${gap}s-gap-breath`,
      join(spoken, silence(gap), Array(6).fill(breath)),
      reference,
      reference,
      true
    );
  }
  const withThanks = `${reference} Thank you.`;
  add(
    "speech-real-thanks-breath",
    join(spoken, thanks, Array(6).fill(breath)),
    withThanks,
    withThanks,
    true
  );
  add(
    "speech-quiet-thanks-breath",
    join(spoken, scalePcm(thanks, 0.05), breath, breath),
    withThanks,
    withThanks,
    true
  );
  for (const [name, pcm, expected] of [
    ["speech", join(spoken, silence(2)), reference],
    ["speech-silence", join(spoken, silence(30)), reference],
    ["speech-breath", join(spoken, breath, breath), reference],
    ["speech-loud-breath", join(spoken, scalePcm(breath, 10), scalePcm(breath, 10)), reference],
    ["quiet-speech-breath", join(scalePcm(spoken, 0.05), breath, breath), reference],
    ["spoken-thank-you", join(spoken, thanks, silence(5)), withThanks],
  ])
    add(name, pcm, expected, expected, true);
  return cases;
}

module.exports = { buildCases, createWav, scalePcm, scoreCase };
