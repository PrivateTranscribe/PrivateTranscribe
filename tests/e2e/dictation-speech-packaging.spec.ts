import fs from "node:fs";
import path from "node:path";
import { test, expect } from "./fixtures/electron-app";

test("speech worker runs from ASAR with unpacked native dependencies", async ({
  electronApp,
}, testInfo) => {
  const { createPackageWithOptions } = require("@electron/asar");
  const root = path.resolve(".");
  const resources = testInfo.outputPath("resources");
  const source = testInfo.outputPath("package-source");
  fs.mkdirSync(path.join(source, "src/helpers"), { recursive: true });
  fs.mkdirSync(path.join(resources, "models"), { recursive: true });
  for (const file of [
    "dictationSpeech.js",
    "dictationSpeechRunner.js",
    "dictationSpeechWorker.js",
  ]) {
    fs.copyFileSync(path.join(root, "src/helpers", file), path.join(source, "src/helpers", file));
  }
  const platform = process.platform === "win32" ? "win" : process.platform;
  for (const name of ["sherpa-onnx-node", `sherpa-onnx-${platform}-${process.arch}`]) {
    fs.cpSync(path.join(root, "node_modules", name), path.join(source, "node_modules", name), {
      recursive: true,
    });
  }
  fs.copyFileSync(
    path.join(root, "resources/models/silero-vad.onnx"),
    path.join(resources, "models/silero-vad.onnx")
  );
  const archive = path.join(resources, "app.asar");
  await createPackageWithOptions(source, archive, { unpackDir: "node_modules" });
  const result = await electronApp.evaluate(
    async ({ app }, { archive, resources, root }) => {
      const { createRequire } = (process as any).getBuiltinModule("module");
      const mainRequire = createRequire(`${app.getAppPath()}/main.js`);
      const { prepareDictationSpeech, resolveSpeechModelPath } = mainRequire(
        archive + "/src/helpers/dictationSpeechRunner.js"
      );
      const wav = mainRequire("fs").readFileSync(root + "/tests/fixtures/dictation/banana.wav");
      const modelPath = resolveSpeechModelPath(resources);
      const prepared = await prepareDictationSpeech(wav.subarray(44), { modelPath });
      return {
        available: prepared.available,
        reason: prepared.reason,
        regions: prepared.regions,
        modelPath,
      };
    },
    { archive, resources, root }
  );
  expect(result.available, JSON.stringify(result)).toBe(true);
  expect(result.regions).toBeGreaterThan(0);
  expect(result.modelPath).toBe(path.join(resources, "models/silero-vad.onnx"));
});
