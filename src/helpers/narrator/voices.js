"use strict";

/**
 * The narrator's voices. Each one turns a sentence into PCM outside the main
 * process's own thread; the overlay window plays it.
 *
 *   piper-da   Danish, Piper "talesyntese" through sherpa-onnx (already in the
 *              app for Parakeet), in its own utility process (piperHost.js).
 *              CPU, about 0.3 s for 25 words. The default.
 *   roest-da   Danish, Røst v3 (Chatterbox, CoRal project). Opt-in: it runs in
 *              a Python environment the user installs outside the app, and
 *              stays off the installer.
 *   kokoro-en  English, the Read Aloud voice. No extra download for anyone who
 *              already uses Read Aloud.
 *
 * Every voice here is synthetic and the page says so; Røst's licence asks for
 * that disclosure, and no voice is cloned from a real person.
 */

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { getModelsDirForService } = require("../modelDirUtils");
const { downloadFile } = require("../downloadUtils");
const { getTarCommand } = require("../systemTar");
const { planAnsiArgvPaths } = require("../ansiArgvPaths");
const { prepareSherpaPiperModel } = require("./piperModel");

const PIPER_VOICE = "da_DK-talesyntese-medium";
const PIPER_BASE =
  "https://huggingface.co/rhasspy/piper-voices/resolve/e7229f7d33a10e145e109b886d661984201ac3c4/da/da_DK/talesyntese/medium";
/**
 * Piper's phonemizer data. It ships inside the piper-tts wheel on PyPI, which
 * is a zip; only its espeak-ng-data folder is kept.
 */
const ESPEAK_WHEEL = {
  url: "https://files.pythonhosted.org/packages/12/9c/c736d1961cf9ce0655278731b9430df41892ca2ded7b09dabcb340612158/piper_tts-1.8.0-cp39-abi3-win_amd64.whl",
  sha256: "5da9bfdb05dfe15da3536859d422e605483ffa6d2b3ec2c5b9593bae6b5aa6a4",
  size: 34119688,
};
const PIPER_FILES = [
  {
    name: `${PIPER_VOICE}.onnx`,
    url: `${PIPER_BASE}/${PIPER_VOICE}.onnx`,
    sha256: "b9271efd25f7b8494bbd28d48dd675c8c119daa284f3ee488008935f515f1241",
    size: 63201294,
  },
  {
    name: `${PIPER_VOICE}.onnx.json`,
    url: `${PIPER_BASE}/${PIPER_VOICE}.onnx.json`,
    sha256: "89fe13bd251406cc0088570d103ea7ac35823211d8466faf913268ab8506f41b",
    size: 4878,
  },
];
const PIPER_DOWNLOAD_BYTES =
  PIPER_FILES.reduce((sum, file) => sum + file.size, 0) + ESPEAK_WHEEL.size;

function piperDir() {
  return (
    process.env.PT_NARRATOR_PIPER_DIR || path.join(getModelsDirForService("narrator"), "piper-da")
  );
}

/**
 * Starts piperHost.js. sherpa-onnx-node must never load in the main process:
 * see that file for the ONNX Runtime clash that closed the app.
 */
function createPiperHost() {
  const hostPath = path.join(__dirname, "piperHost.js");
  // Undefined under ELECTRON_RUN_AS_NODE and plain Node, where a forked child does the same job.
  const utilityProcess = process.versions.electron ? require("electron").utilityProcess : null;
  if (utilityProcess) {
    return utilityProcess.fork(hostPath, [], { serviceName: "PrivateTranscribe Narrator voice" });
  }
  const child = require("node:child_process").fork(hostPath, [], {
    serialization: "advanced",
    stdio: ["ignore", "ignore", "inherit", "ipc"],
    windowsHide: true,
  });
  child.postMessage = (message) => child.send(message);
  return child;
}

class PiperVoice {
  constructor({ log = () => {}, createHost = createPiperHost } = {}) {
    this.id = "piper-da";
    this.language = "da";
    this.log = log;
    this.createHost = createHost;
    this.host = null;
    this.tts = null;
    this.pending = new Map();
    this.nextId = 1;
    this.downloading = null;
  }

  paths() {
    const dir = piperDir();
    return {
      dir,
      model: path.join(dir, "model.onnx"),
      tokens: path.join(dir, "tokens.txt"),
      espeak: path.join(dir, "espeak-ng-data"),
    };
  }

  installed() {
    const p = this.paths();
    return (
      fs.existsSync(p.model) &&
      fs.existsSync(p.tokens) &&
      fs.existsSync(path.join(p.espeak, "phontab"))
    );
  }

  status() {
    return {
      id: this.id,
      installed: this.installed(),
      downloading: Boolean(this.downloading),
      sizeBytes: PIPER_DOWNLOAD_BYTES,
    };
  }

  /** Downloads the voice and the phonemizer data, then converts the voice for sherpa-onnx. */
  download(onProgress = () => {}) {
    if (this.downloading) return this.downloading;
    this.downloading = this._download(onProgress).finally(() => {
      this.downloading = null;
    });
    return this.downloading;
  }

  async _download(onProgress) {
    const p = this.paths();
    const staging = path.join(p.dir, "download");
    await fsp.mkdir(staging, { recursive: true });
    let done = 0;
    const progress = (file) => (_p, downloaded) =>
      onProgress({
        downloadedBytes: done + (downloaded || 0),
        totalBytes: PIPER_DOWNLOAD_BYTES,
        file,
      });

    for (const file of [...PIPER_FILES, { ...ESPEAK_WHEEL, name: "piper_tts.whl" }]) {
      const dest = path.join(staging, file.name);
      if (!fs.existsSync(dest)) {
        await downloadFile(file.url, dest, {
          sha256: file.sha256,
          onProgress: progress(file.name),
        });
      }
      done += file.size;
    }

    // Only espeak-ng-data comes out of the wheel; the Python code in it is never unpacked.
    const unpack = path.join(staging, "wheel");
    await fsp.rm(unpack, { recursive: true, force: true });
    await fsp.mkdir(unpack, { recursive: true });
    await extractFromZip(path.join(staging, "piper_tts.whl"), unpack, "piper/espeak-ng-data");
    await fsp.rm(p.espeak, { recursive: true, force: true });
    await fsp.rename(path.join(unpack, "piper", "espeak-ng-data"), p.espeak);

    prepareSherpaPiperModel({
      srcOnnx: path.join(staging, PIPER_FILES[0].name),
      srcConfig: path.join(staging, PIPER_FILES[1].name),
      destOnnx: p.model,
      destTokens: p.tokens,
    });
    await fsp.rm(staging, { recursive: true, force: true });
    onProgress({
      downloadedBytes: PIPER_DOWNLOAD_BYTES,
      totalBytes: PIPER_DOWNLOAD_BYTES,
      done: true,
    });
    return { ...this.status(), downloading: false };
  }

  async remove() {
    // Stop the engine first, so no process still has the voice's files in use.
    await this._stopHost();
    await fsp.rm(piperDir(), { recursive: true, force: true });
  }

  /** The engine, loaded once in the host process. */
  _load() {
    if (this.tts) return this.tts;
    if (!this.installed()) {
      return Promise.reject(
        Object.assign(new Error("The Danish voice is not downloaded"), { code: "voice-missing" })
      );
    }
    const p = this.paths();
    this.tts = this._call("load", {
      model: p.model,
      tokens: p.tokens,
      dataDir: p.espeak,
      numThreads: Math.max(1, Math.min(2, os.cpus().length - 1)),
    }).catch((error) => {
      this.tts = null;
      throw error;
    });
    return this.tts;
  }

  /** Loads the engine ahead of the first item, so the first wait is not slower than the rest. */
  warm() {
    if (this.installed()) this._load().catch(() => {});
  }

  async synthesize(text) {
    await this._load();
    const { samples, sampleRate } = await this._call("speak", { text });
    return { pcm: samples, sampleRate };
  }

  unload() {
    this._stopHost();
  }

  _call(op, args) {
    const host = this._ensureHost();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        host.postMessage({ id, op, args });
      } catch (error) {
        this._dropHost(host, error);
      }
    });
  }

  _ensureHost() {
    if (this.host) return this.host;
    const host = this.createHost();
    host.on("message", (message) => {
      if (host !== this.host) return;
      const waiter = this.pending.get(message?.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.ok) waiter.resolve(message.result);
      else
        waiter.reject(
          Object.assign(new Error(message.error?.message || "The Danish voice failed"), {
            code: message.error?.code || "voice-host-error",
          })
        );
    });
    host.once("exit", (code) => {
      if (host !== this.host) return;
      this.log("Narrator voice host exited", { code });
      this._dropHost(host, new Error(`The Danish voice stopped (${code})`));
    });
    this.host = host;
    return host;
  }

  /** Forgets `host`; every request still waiting on it fails with `error`. */
  _dropHost(host, error) {
    if (host === this.host) {
      this.host = null;
      this.tts = null;
    }
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
  }

  /** Stops the host and resolves once it has exited, so its files can be removed. */
  _stopHost() {
    const host = this.host;
    if (!host) return Promise.resolve();
    const exited = new Promise((resolve) => {
      host.once("exit", resolve);
      setTimeout(resolve, 2000).unref?.();
    });
    this._dropHost(host, new Error("The Danish voice was stopped"));
    try {
      host.kill();
    } catch {
      // Already gone.
    }
    return exited;
  }
}

/** Extracts one folder of a zip with Windows' own tar (bsdtar reads zip). */
function extractFromZip(zipPath, destDir, member) {
  const plan = planAnsiArgvPaths([zipPath, destDir], { platform: process.platform });
  const [archive, destination] = plan.paths;
  return new Promise((resolve, reject) => {
    const child = spawn(getTarCommand(), ["-xf", archive, "-C", destination, member], {
      cwd: plan.cwd || undefined,
      windowsHide: true,
    });
    let stderr = "";
    child.stderr.on("data", (data) => {
      stderr += String(data);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Could not unpack the voice data (${code}): ${stderr.slice(0, 200)}`));
    });
  });
}

/** Where the opt-in Røst environment lives; the narrator's own folder in the model cache. */
function roestHome() {
  return (
    process.env.PT_NARRATOR_ROEST_DIR ||
    path.join(path.dirname(getModelsDirForService("narrator")), "narrator")
  );
}

/**
 * Røst, through a Python worker in the user's own environment. One process,
 * one request at a time; it holds the model on the GPU between sentences.
 */
class RoestVoice {
  constructor({ log = () => {} } = {}) {
    this.id = "roest-da";
    this.language = "da";
    this.log = log;
    this.proc = null;
    this.pending = new Map();
    this.nextId = 1;
    this.buffer = "";
    this.ready = null;
  }

  paths() {
    const home = roestHome();
    return {
      home,
      python: path.join(
        home,
        "roest-venv",
        process.platform === "win32" ? "Scripts" : "bin",
        process.platform === "win32" ? "python.exe" : "python"
      ),
      model: path.join(home, "roest-model"),
    };
  }

  /**
   * The worker script where Python can read it. In the installed app it sits
   * inside app.asar, which only Electron can read, so it is copied out next to
   * the environment first, and again whenever the app ships a new one.
   */
  async _workerPath() {
    const bundled = path.join(__dirname, "roestWorker.py");
    if (!bundled.split(/[\\/]/).includes("app.asar")) return bundled;
    const copy = path.join(roestHome(), "roestWorker.py");
    const script = await fsp.readFile(bundled);
    const existing = await fsp.readFile(copy).catch(() => null);
    if (!existing?.equals(script)) await fsp.writeFile(copy, script);
    return copy;
  }

  installed() {
    const p = this.paths();
    return (
      fs.existsSync(p.python) && fs.existsSync(path.join(p.model, "t3_mtl23ls_v2.safetensors"))
    );
  }

  status() {
    return { id: this.id, installed: this.installed(), optIn: true };
  }

  _start() {
    if (this.ready) return this.ready;
    this.ready = this._workerPath()
      .then((worker) => this._spawn(worker))
      .catch((error) => {
        this.ready = null;
        throw error;
      });
    return this.ready;
  }

  /** Loads the model ahead of the first item: about 45 s on the processor. */
  warm() {
    if (this.installed()) this._start().catch(() => {});
  }

  _spawn(worker) {
    const p = this.paths();
    return new Promise((resolve, reject) => {
      const proc = spawn(p.python, ["-I", worker, p.model], {
        cwd: os.tmpdir(),
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, HF_HUB_OFFLINE: "1", PYTHONIOENCODING: "utf-8" },
      });
      this.proc = proc;
      this.buffer = "";
      let stderr = "";
      proc.stdout.setEncoding("utf8");
      proc.stdout.on("data", (chunk) => {
        this.buffer += chunk;
        let index;
        while ((index = this.buffer.indexOf("\n")) >= 0) {
          const line = this.buffer.slice(0, index);
          this.buffer = this.buffer.slice(index + 1);
          let message;
          try {
            message = JSON.parse(line);
          } catch {
            continue;
          }
          if (message.ready) resolve();
          const waiter = this.pending.get(message.id);
          if (waiter) {
            this.pending.delete(message.id);
            if (message.error) waiter.reject(new Error(message.error));
            else waiter.resolve(message);
          }
        }
      });
      proc.stderr.on("data", (chunk) => {
        stderr = (stderr + String(chunk)).slice(-1000);
      });
      proc.stdin.on("error", () => {});
      proc.on("error", (error) => reject(error));
      proc.on("exit", (code) => {
        const error = new Error(`The Røst worker stopped (${code}). ${stderr.trim()}`);
        reject(error);
        // A worker unloaded earlier must not clear the one started after it.
        if (this.proc === proc) this._reset(error);
      });
    });
  }

  /** Forgets the worker; every request still waiting on it fails with `error`. */
  _reset(error) {
    this.proc = null;
    this.ready = null;
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
  }

  async synthesize(text) {
    if (!this.installed()) {
      throw Object.assign(new Error("Røst is not installed"), { code: "voice-missing" });
    }
    await this._start();
    const proc = this.proc;
    if (!proc) throw new Error("The Røst worker stopped");
    const id = this.nextId++;
    const out = path.join(os.tmpdir(), `pt-narrator-roest-${process.pid}-${id}.f32`);
    const reply = await new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      proc.stdin.write(`${JSON.stringify({ id, text, out })}\n`);
    });
    try {
      const bytes = await fsp.readFile(out);
      const pcm = new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.length / 4));
      return { pcm: Float32Array.from(pcm), sampleRate: reply.sampleRate };
    } finally {
      fsp.rm(out, { force: true }).catch(() => {});
    }
  }

  unload() {
    const proc = this.proc;
    this._reset(new Error("The Røst worker was stopped"));
    try {
      proc?.kill();
    } catch {
      // Already gone.
    }
  }
}

/** English through Kokoro, the Read Aloud engine. */
class KokoroVoice {
  /** `getVoiceId` is read per sentence, so a voice picked on the page applies at once. */
  constructor({ kokoro, getVoiceId = () => "bm_lewis" } = {}) {
    this.id = "kokoro-en";
    this.language = "en";
    this.kokoro = kokoro;
    this.getVoiceId = getVoiceId;
  }

  async installed() {
    try {
      return Boolean((await this.kokoro?.checkModelStatus?.())?.installed);
    } catch {
      return false;
    }
  }

  async status() {
    return { id: this.id, installed: await this.installed() };
  }

  /** Loads Read Aloud's engine ahead of the first item, as the Danish voices do. */
  warm() {
    this.kokoro?.loadEngine?.()?.catch?.(() => {});
  }

  async synthesize(text) {
    if (!this.kokoro)
      throw Object.assign(new Error("Read Aloud is unavailable"), { code: "voice-missing" });
    const { pcm, sampleRate } = await this.kokoro.synthesize(text, {
      voice: this.getVoiceId(),
      channel: "narrator",
    });
    return { pcm, sampleRate };
  }

  unload() {}
}

module.exports = {
  PiperVoice,
  RoestVoice,
  KokoroVoice,
  PIPER_FILES,
  ESPEAK_WHEEL,
  PIPER_DOWNLOAD_BYTES,
};
