const fs = require("fs");
const path = require("path");
const debugLogger = require("./debugLogger");
const { getSafeTempDir } = require("./safeTempDir");
// Called through the module objects so tests can spy on them.
const ffmpegUtils = require("./ffmpegUtils");
const speechRunner = require("./dictationSpeechRunner");
const { NORMALIZATION_FILTER } = require("./dictationSpeech");
const {
  getTrailingSilenceFilters,
  parseWavPcmInfo,
  createPcm16WavBuffer,
  splitWavIntoChunks,
  pcm16ToFloat32,
} = require("./wavPcm");

const SAMPLE_RATE = 16000;
const BYTES_PER_SECOND = SAMPLE_RATE * 2;
// One Parakeet decode aborts past ~400 s and its memory grows with clip length,
// so no piece may exceed 60 s. Aiming at 55 s with a 5 s search keeps every
// seam inside the ceiling while still letting it move to a pause.
const PARAKEET_MAX_CHUNK_SECONDS = 60;
const PARAKEET_TARGET_CHUNK_SECONDS = 55;
const PARAKEET_SEAM_SEARCH_SECONDS = 5;
const TEMP_DIR_PREFIX = "parakeet-audio-";

function cancelledError() {
  return Object.assign(new Error("Parakeet audio preparation cancelled"), { isAbort: true });
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw cancelledError();
}

function toBuffer(audio) {
  if (Buffer.isBuffer(audio)) return audio;
  if (audio instanceof ArrayBuffer) return Buffer.from(audio);
  if (ArrayBuffer.isView(audio))
    return Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength);
  throw new TypeError("Parakeet audio must be a Buffer, ArrayBuffer or typed array");
}

function isPcm16Mono16k(info) {
  return (
    info?.audioFormat === 1 &&
    info.channels === 1 &&
    info.sampleRate === SAMPLE_RATE &&
    info.bitsPerSample === 16
  );
}

// The PCM payload of an FFmpeg output, or null when it holds no samples. FFmpeg
// still writes a LIST chunk around zero samples, so file size says nothing.
async function readPcm(wavPath) {
  const wav = await fs.promises.readFile(wavPath);
  const info = parseWavPcmInfo(wav);
  return info ? wav.subarray(info.dataOffset, info.dataOffset + info.dataSize) : null;
}

/**
 * Turns a raw recording into Parakeet-sized pieces: 16 kHz mono, speech-trimmed
 * by the dictation detector, loudness-normalised, trailing silence cut, and
 * split at quiet points into chunks of at most 60 s.
 *
 * `speechFound` is false when the detector heard nothing or the audio is silent
 * throughout. Chunks are then empty only for silence; a quiet utterance the
 * detector missed still comes back so it is not erased. `durationSec` is the
 * length of the prepared audio, the sum of the chunks.
 */
async function prepareParakeetAudio(audioBuffer, { signal } = {}) {
  throwIfAborted(signal);
  const input = toBuffer(audioBuffer);
  const tempDir = await fs.promises.mkdtemp(path.join(getSafeTempDir(), TEMP_DIR_PREFIX));
  // ffmpeg probes the container from its contents; the extension is only a hint.
  const isWav = input.length >= 12 && input.toString("ascii", 0, 4) === "RIFF";
  const inputPath = path.join(tempDir, isWav ? "input.wav" : "input.webm");
  const wavPath = path.join(tempDir, "converted.wav");
  const speechPath = path.join(tempDir, "speech.wav");
  const normalizedPath = path.join(tempDir, "normalized.wav");
  const trimmedPath = path.join(tempDir, "trimmed.wav");

  try {
    await fs.promises.writeFile(inputPath, input);
    await ffmpegUtils.convertToWav(inputPath, wavPath, { sampleRate: SAMPLE_RATE, channels: 1 });
    throwIfAborted(signal);

    const wav = await fs.promises.readFile(wavPath);
    const info = parseWavPcmInfo(wav);
    if (!info) {
      return { chunks: [], sampleRate: SAMPLE_RATE, speechFound: false, durationSec: 0 };
    }
    if (!isPcm16Mono16k(info)) throw new Error("FFmpeg did not produce 16 kHz mono PCM16 audio");

    // true, false, or null when the detector could not run.
    let detectorHeardSpeech = null;
    let speechPcm = wav.subarray(info.dataOffset, info.dataOffset + info.dataSize);
    try {
      const detected = await speechRunner.prepareDictationSpeech(speechPcm, { signal });
      throwIfAborted(signal);
      if (detected.available) {
        detectorHeardSpeech = detected.mode !== "unchanged";
        if (detectorHeardSpeech) speechPcm = detected.pcm;
        debugLogger.debug("Prepared Parakeet speech", {
          mode: detected.mode,
          regions: detected.regions,
          inputSeconds: info.durationSeconds,
          outputSeconds: speechPcm.length / BYTES_PER_SECOND,
        });
      } else {
        debugLogger.warn("Speech detection unavailable for Parakeet; normalising whole recording", {
          reason: detected.reason,
        });
      }
    } catch (error) {
      if (error?.isAbort) throw error;
      debugLogger.warn("Speech detection failed for Parakeet; normalising whole recording", {
        error: error.message,
      });
    }
    await fs.promises.writeFile(speechPath, createPcm16WavBuffer(speechPcm));

    // Whisper normalises only after a cleanup cut, but Parakeet returns nothing
    // for quiet audio, so every recording is normalised here.
    let prepared = null;
    let audible = true;
    try {
      await ffmpegUtils.convertToWav(speechPath, trimmedPath, {
        sampleRate: SAMPLE_RATE,
        channels: 1,
        audioFilters: [NORMALIZATION_FILTER, ...getTrailingSilenceFilters()],
      });
      throwIfAborted(signal);
      prepared = await readPcm(trimmedPath);
      audible = Boolean(prepared);
    } catch (error) {
      if (error?.isAbort) throw error;
      debugLogger.warn("Parakeet normalise-and-trim failed; retrying without the trim", {
        error: error.message,
      });
    }

    if (!audible && detectorHeardSpeech !== true) {
      return { chunks: [], sampleRate: SAMPLE_RATE, speechFound: false, durationSec: 0 };
    }
    if (!prepared) {
      // The trim emptied audio the detector called speech, or the trim failed.
      // Mirror Whisper: a quiet transcript beats an empty one.
      try {
        await ffmpegUtils.convertToWav(speechPath, normalizedPath, {
          sampleRate: SAMPLE_RATE,
          channels: 1,
          audioFilters: [NORMALIZATION_FILTER],
        });
        throwIfAborted(signal);
        prepared = await readPcm(normalizedPath);
      } catch (error) {
        if (error?.isAbort) throw error;
        debugLogger.warn("Parakeet normalisation failed; using unnormalised audio", {
          error: error.message,
        });
      }
      prepared = prepared || speechPcm;
    }

    const pieces = splitWavIntoChunks(createPcm16WavBuffer(prepared), {
      chunkSeconds: PARAKEET_TARGET_CHUNK_SECONDS,
      thresholdSeconds: PARAKEET_MAX_CHUNK_SECONDS,
      searchSeconds: PARAKEET_SEAM_SEARCH_SECONDS,
      maxChunkSeconds: PARAKEET_MAX_CHUNK_SECONDS,
    });
    const chunks = pieces.map((piece) => {
      const pieceInfo = parseWavPcmInfo(piece.buffer);
      return pcm16ToFloat32(
        piece.buffer.subarray(pieceInfo.dataOffset, pieceInfo.dataOffset + pieceInfo.dataSize)
      );
    });
    const durationSec = chunks.reduce((sum, chunk) => sum + chunk.length, 0) / SAMPLE_RATE;
    return {
      chunks,
      sampleRate: SAMPLE_RATE,
      speechFound: detectorHeardSpeech === true || (audible && detectorHeardSpeech !== false),
      durationSec,
    };
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = {
  prepareParakeetAudio,
  PARAKEET_MAX_CHUNK_SECONDS,
  TEMP_DIR_PREFIX,
};
