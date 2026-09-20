// Run with the installed Electron binary, not Node. No windows, user profile,
// microphone, cloud requests, or global shortcuts are used.
const { app, utilityProcess } = require("electron");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { prepareDictationSpeech } = require("../src/helpers/dictationSpeechRunner");
const { readPcm } = require("./benchmark-dictation-endings");

app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "pt-speech-isolation-")));
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  try {
    // Importing the splitter is the main-process part of Read Aloud. The model
    // itself already runs in a separate Kokoro utility process.
    const { TextSplitterStream } = await import("kokoro-js");
    const splitter = new TextSplitterStream();
    splitter.push("Read aloud before dictation.");
    assert.ok([...splitter].length);
    const pcm = readPcm(path.resolve(__dirname, "../tests/fixtures/dictation/banana.wav"));
    for (let i = 0; i < 3; i++) {
      const result = await prepareDictationSpeech(pcm);
      assert.equal(result.available, true, JSON.stringify(result));
      assert.ok(result.regions > 0);
      console.log(`Native speech detection ${i + 1} passed`);
    }
    const failed = await prepareDictationSpeech(pcm, {
      createProcess: () =>
        utilityProcess.fork(
          path.join(__dirname, "../tests/fixtures/speech-detector-crash.cjs"),
          [],
          { stdio: "ignore" }
        ),
    });
    assert.equal(failed.available, false);
    assert.equal(failed.reason, "worker-exited");
    assert.equal((await prepareDictationSpeech(pcm)).available, true);
    console.log("Child native crash survived; next recording succeeded");
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
