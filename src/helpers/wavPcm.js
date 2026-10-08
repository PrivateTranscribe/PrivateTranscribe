const WAV_HEADER_BYTES = 44;
const DEFAULT_CHUNK_SECONDS = 60;
// How far either side of a chunk boundary to look for a pause to cut on, and
// how finely to measure loudness while looking.
const CHUNK_SEAM_SEARCH_SECONDS = 5;
const CHUNK_SEAM_FRAME_SECONDS = 0.02;
const TRAILING_SILENCE_PAD_SECONDS = 0.8;

// Trailing silence is trimmed by reversing the stream, dropping the leading
// silence, and reversing back.
//
// `start_duration` must stay at 0. It is the amount of *non-silence* that has
// to be observed before trimming stops, and everything buffered while waiting
// is discarded — so any non-zero value deletes that much real speech from the
// end of the recording. The previous 0.5 turned "3s of speech" into "2.5s of
// speech", cutting the final words mid-utterance. Whisper responds to an
// utterance that stops mid-sentence by inventing the rest of it.
//
// `start_silence` keeps a fixed short pause instead of cutting flush against
// the last word, which is the cue Whisper uses to decide speech has ended.
function getTrailingSilenceFilters() {
  return [
    "areverse",
    [
      "silenceremove=start_periods=1",
      "start_duration=0",
      "start_threshold=-50dB",
      `start_silence=${TRAILING_SILENCE_PAD_SECONDS}`,
    ].join(":"),
    "areverse",
  ];
}

function parseWavPcmInfo(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < WAV_HEADER_BYTES) return null;
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    return null;
  }

  let offset = 12;
  let format = null;
  let dataOffset = -1;
  let dataSize = 0;

  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkDataOffset = offset + 8;

    if (chunkId === "fmt " && chunkDataOffset + 16 <= buffer.length) {
      format = {
        audioFormat: buffer.readUInt16LE(chunkDataOffset),
        channels: buffer.readUInt16LE(chunkDataOffset + 2),
        sampleRate: buffer.readUInt32LE(chunkDataOffset + 4),
        byteRate: buffer.readUInt32LE(chunkDataOffset + 8),
        blockAlign: buffer.readUInt16LE(chunkDataOffset + 12),
        bitsPerSample: buffer.readUInt16LE(chunkDataOffset + 14),
      };
    } else if (chunkId === "data") {
      dataOffset = chunkDataOffset;
      dataSize = Math.min(chunkSize, buffer.length - chunkDataOffset);
      break;
    }

    offset += 8 + chunkSize + (chunkSize % 2);
  }

  if (!format || dataOffset < 0 || dataSize <= 0 || format.byteRate <= 0) return null;

  return {
    ...format,
    dataOffset,
    dataSize,
    durationSeconds: dataSize / format.byteRate,
  };
}

/**
 * Where to cut a long recording so the seam lands in a pause.
 *
 * Chunks are transcribed independently and their texts joined with a space, so
 * a boundary that falls inside a word ships that word in two halves: cut
 * "vildtreservat" down the middle and the transcript reads "vildt reservat".
 * Cutting at the quietest nearby point puts the seam where a space belongs
 * anyway, and gives each chunk an utterance that actually finishes.
 *
 * Returns the byte offset to cut at, or `targetOffset` unchanged whenever there
 * is nothing better to say - non-PCM16 audio, a window too small to search, or
 * speech so continuous that no frame stands out. Falling back to the clock is
 * exactly what this did before, so the worst case is the old behaviour.
 */
function findQuietestCutOffset(
  buffer,
  info,
  targetOffset,
  dataEnd,
  searchSeconds = CHUNK_SEAM_SEARCH_SECONDS
) {
  if (info.bitsPerSample !== 16) return targetOffset;

  const align = (bytes) => Math.floor(bytes / info.blockAlign) * info.blockAlign;
  const frameBytes = Math.max(info.blockAlign, align(info.byteRate * CHUNK_SEAM_FRAME_SECONDS));
  const radiusBytes = align(info.byteRate * searchSeconds);

  const first = Math.max(info.dataOffset, targetOffset - radiusBytes);
  const last = Math.min(dataEnd - frameBytes, targetOffset + radiusBytes);
  if (last <= first) return targetOffset;

  let bestOffset = targetOffset;
  let bestEnergy = Infinity;

  for (let offset = first; offset <= last; offset += frameBytes) {
    let sum = 0;
    let samples = 0;
    for (let i = offset; i + 2 <= offset + frameBytes && i + 2 <= buffer.length; i += 2) {
      const sample = buffer.readInt16LE(i);
      sum += sample * sample;
      samples += 1;
    }
    if (samples === 0) continue;

    const energy = sum / samples;
    // Ties go to the frame nearest the boundary, so uniform audio - digital
    // silence especially - keeps chunks the length they were asked to be.
    const closer = Math.abs(offset - targetOffset) < Math.abs(bestOffset - targetOffset);
    if (energy < bestEnergy || (energy === bestEnergy && closer)) {
      bestEnergy = energy;
      bestOffset = offset;
    }
  }

  return bestOffset;
}

function createPcm16WavBuffer(pcmData, sampleRate = 16000, channels = 1, bitsPerSample = 16) {
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const header = Buffer.alloc(WAV_HEADER_BYTES);

  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcmData.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcmData.length, 40);

  return Buffer.concat([header, pcmData]);
}

/**
 * Splits a PCM WAV longer than `thresholdSeconds` into WAV pieces of about
 * `chunkSeconds`, each seam moved to the quietest point within `searchSeconds`.
 * `maxChunkSeconds` is a hard ceiling for engines that fail past a length.
 */
function splitWavIntoChunks(
  wavBuffer,
  {
    chunkSeconds = DEFAULT_CHUNK_SECONDS,
    thresholdSeconds = chunkSeconds,
    searchSeconds = CHUNK_SEAM_SEARCH_SECONDS,
    maxChunkSeconds = Infinity,
  } = {}
) {
  const info = parseWavPcmInfo(wavBuffer);
  if (!info || info.durationSeconds <= thresholdSeconds) {
    return [{ buffer: wavBuffer, durationSeconds: info?.durationSeconds || 0 }];
  }

  const bytesPerChunk =
    Math.floor((info.byteRate * chunkSeconds) / info.blockAlign) * info.blockAlign;
  if (bytesPerChunk <= 0 || bytesPerChunk >= info.dataSize) {
    return [{ buffer: wavBuffer, durationSeconds: info.durationSeconds }];
  }
  const maxBytes = Number.isFinite(maxChunkSeconds)
    ? Math.floor((info.byteRate * maxChunkSeconds) / info.blockAlign) * info.blockAlign
    : Infinity;

  const chunks = [];
  const dataEnd = info.dataOffset + info.dataSize;
  let start = info.dataOffset;
  while (start < dataEnd) {
    const target = Math.min(start + bytesPerChunk, dataEnd);
    // The last chunk ends where the audio ends; there is no seam to place.
    let end =
      target === dataEnd
        ? target
        : findQuietestCutOffset(
            wavBuffer,
            info,
            target,
            Math.min(dataEnd, start + maxBytes),
            searchSeconds
          );
    end -= (end - info.dataOffset) % info.blockAlign;
    // A seam that did not move forward would stall the walk. Fall back to the
    // clock, which is what this did before the search existed.
    if (end <= start) end = target;
    // Whisper can return no text for an isolated sub-second request. Keep
    // that final fragment with the preceding speech instead of dropping it.
    if (dataEnd - end < info.byteRate && dataEnd - start <= maxBytes) end = dataEnd;

    const pcmData = wavBuffer.slice(start, end);
    if (pcmData.length === 0) break;
    chunks.push({
      buffer: createPcm16WavBuffer(pcmData, info.sampleRate, info.channels, info.bitsPerSample),
      durationSeconds: pcmData.length / info.byteRate,
      offsetSeconds: (start - info.dataOffset) / info.byteRate,
    });
    start = end;
  }

  return chunks.length > 0
    ? chunks
    : [{ buffer: wavBuffer, durationSeconds: info.durationSeconds }];
}

function pcm16ToFloat32(pcm) {
  const samples = new Float32Array(Math.floor(pcm.length / 2));
  for (let i = 0; i < samples.length; i++) samples[i] = pcm.readInt16LE(i * 2) / 32768;
  return samples;
}

module.exports = {
  WAV_HEADER_BYTES,
  DEFAULT_CHUNK_SECONDS,
  CHUNK_SEAM_SEARCH_SECONDS,
  getTrailingSilenceFilters,
  parseWavPcmInfo,
  findQuietestCutOffset,
  createPcm16WavBuffer,
  splitWavIntoChunks,
  pcm16ToFloat32,
};
