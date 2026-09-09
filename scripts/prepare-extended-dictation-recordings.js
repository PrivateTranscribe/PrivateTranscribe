"use strict";

// Reuse the documented public speech corpus. No microphone capture or downloads.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const { createWav } = require("./dictation-ending-benchmark-utils");
const root = path.resolve(__dirname, "..");
const source = path.join(root, "tmp/dictation-integrated-comparison");
const output = path.join(root, "tmp/extended-dictation-recordings");
const benchmark = JSON.parse(fs.readFileSync(path.join(source, "results.json"), "utf8"));
const manifest = JSON.parse(
  fs.readFileSync(
    path.join(root, "tmp/long-dictation-test/long-dictation-fixture.manifest.json"),
    "utf8"
  )
);
fs.mkdirSync(output, { recursive: true });

function minuteChecks(clips) {
  const groups = new Map();
  for (const clip of clips) {
    const minute = Math.floor(clip.startSeconds / 60);
    if (!groups.has(minute)) groups.set(minute, []);
    groups.get(minute).push(clip.text);
  }
  return [...groups].map(([minute, words]) => ({
    label: `minute-${minute + 1}`,
    text: words.join(" "),
  }));
}

const cases = [];
for (const [name, model] of [
  ["speech-60s", "turbo"],
  ["four-minute-quiet-last-minute", "turbo"],
  ["speech-399s", "turbo"],
  ["speech-399s", "large"],
]) {
  const reference = benchmark.cases.find((c) => c.name === name);
  const seconds = name.includes("399") ? 399 : name.includes("quiet") ? 240 : 60;
  cases.push({
    ...reference,
    model,
    fixturePath: path.join(source, `${name}.wav`),
    boundaryChecks: minuteChecks(manifest.clips.filter((clip) => clip.endSeconds <= seconds)),
  });
}

const decoded = spawnSync(
  require("ffmpeg-static"),
  [
    "-v",
    "error",
    "-i",
    path.join(source, "speech-399s.wav"),
    "-ar",
    "16000",
    "-ac",
    "1",
    "-f",
    "s16le",
    "-",
  ],
  { windowsHide: true, maxBuffer: 64 * 1024 * 1024 }
);
if (decoded.status !== 0) throw new Error(decoded.error?.message || decoded.stderr.toString());
const prefixClips = manifest.clips.filter((clip) => clip.endSeconds <= 180);
const prefixSeconds = prefixClips.at(-1).endSeconds;
// Repeat only the opening before the full corpus. The final passage occurs once,
// so hearing an earlier copy cannot falsely satisfy the ending check.
const pcm = Buffer.concat([
  decoded.stdout.subarray(0, Math.round(prefixSeconds * 16000) * 2),
  Buffer.alloc(40 * 32000),
  decoded.stdout,
  Buffer.alloc(4 * 32000),
]);
const fixturePath = path.join(output, "ten-minute-long-pause.wav");
const wav = createWav(pcm);
fs.writeFileSync(fixturePath, wav);
const full = benchmark.cases.find((c) => c.name === "speech-399s");
cases.push({
  name: "ten-minute-long-pause",
  model: "large",
  fixturePath,
  seconds: pcm.length / 32000,
  sha256: crypto.createHash("sha256").update(wav).digest("hex"),
  reference: `${prefixClips.map((c) => c.text).join(" ")} ${full.reference}`,
  ending: full.ending,
  boundaryChecks: minuteChecks([
    ...prefixClips,
    ...manifest.clips
      .filter((c) => c.endSeconds <= 399)
      .map((c) => ({
        ...c,
        startSeconds: c.startSeconds + prefixSeconds + 40,
      })),
  ]),
});
fs.writeFileSync(path.join(output, "suite.json"), JSON.stringify(cases, null, 2));
console.log(
  JSON.stringify(
    cases.map(({ name, model, seconds }) => ({ name, model, seconds })),
    null,
    2
  )
);
