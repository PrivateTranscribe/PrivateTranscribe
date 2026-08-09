"use strict";

const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");

const MAX_AUDIO_BYTES = 512 * 1024 * 1024;
const MIME_EXTENSIONS = new Map([
  ["audio/webm", "webm"],
  ["audio/ogg", "ogg"],
  ["audio/wav", "wav"],
  ["audio/x-wav", "wav"],
  ["audio/mpeg", "mp3"],
  ["audio/mp4", "m4a"],
]);

class DictationRecoveryManager {
  constructor({
    baseDir,
    fsModule = fs,
    idFactory = randomUUID,
    now = () => new Date(),
    maxEntries = 10,
  } = {}) {
    if (!baseDir || typeof baseDir !== "string") {
      throw new Error("A recovery directory is required");
    }
    this.baseDir = path.resolve(baseDir);
    this.fs = fsModule;
    this.idFactory = idFactory;
    this.now = now;
    this.maxEntries = Math.max(1, Math.min(Number(maxEntries) || 10, 100));
  }

  _ensureDirectory() {
    this.fs.mkdirSync(this.baseDir, { recursive: true, mode: 0o700 });
    this._assertDirectory();
  }

  _assertDirectory() {
    const stat = this.fs.lstatSync(this.baseDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("Recovery directory must not be a symbolic link or junction");
    }
  }

  _validateId(id) {
    const value = String(id || "");
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(value)) {
      throw new Error("Invalid recovery id");
    }
    return value;
  }

  _metadataPath(id) {
    return path.join(this.baseDir, `${this._validateId(id)}.json`);
  }

  _writeMetadata(metadata) {
    this._ensureDirectory();
    const target = this._metadataPath(metadata.id);
    const temporary = `${target}.tmp`;
    this.fs.writeFileSync(temporary, JSON.stringify(metadata), { encoding: "utf8", mode: 0o600 });
    this.fs.renameSync(temporary, target);
  }

  _readMetadata(id) {
    this._assertDirectory();
    const safeId = this._validateId(id);
    const metadataPath = this._metadataPath(safeId);
    const stat = this.fs.lstatSync(metadataPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("Invalid recovery metadata");
    }
    return this._validateMetadata(JSON.parse(this.fs.readFileSync(metadataPath, "utf8")), safeId);
  }

  _validateMetadata(metadata, expectedId = null) {
    const id = this._validateId(metadata?.id);
    if (expectedId && id !== expectedId) {
      throw new Error("Invalid recovery metadata");
    }
    const allowedExtensions = [...new Set(MIME_EXTENSIONS.values())].join("|");
    const expectedAudioFile = new RegExp(`^${id}\\.(${allowedExtensions})$`);
    if (!expectedAudioFile.test(String(metadata?.audioFile || ""))) {
      throw new Error("Invalid recovery metadata");
    }
    return metadata;
  }

  stage(audio, { mimeType = "audio/webm", durationSeconds = null } = {}) {
    const bytes = Buffer.isBuffer(audio) ? audio : Buffer.from(audio || []);
    if (bytes.length === 0) {
      throw new Error("Cannot recover an empty recording");
    }
    if (bytes.length > MAX_AUDIO_BYTES) {
      throw new Error("Recording is too large for the recovery vault");
    }

    const id = this._validateId(this.idFactory());
    const normalizedMimeType = MIME_EXTENSIONS.has(mimeType) ? mimeType : "audio/webm";
    const extension = MIME_EXTENSIONS.get(normalizedMimeType);
    const audioFile = `${id}.${extension}`;
    const audioPath = path.join(this.baseDir, audioFile);
    const temporaryAudioPath = `${audioPath}.tmp`;
    const createdAt = this.now().toISOString();
    const metadata = {
      id,
      status: "pending",
      createdAt,
      updatedAt: createdAt,
      mimeType: normalizedMimeType,
      durationSeconds:
        Number.isFinite(durationSeconds) && durationSeconds >= 0 ? durationSeconds : null,
      sizeBytes: bytes.length,
      audioFile,
      reason: "",
    };

    this._ensureDirectory();
    this.fs.writeFileSync(temporaryAudioPath, bytes, { mode: 0o600 });
    this.fs.renameSync(temporaryAudioPath, audioPath);
    try {
      this._writeMetadata(metadata);
    } catch (error) {
      try {
        this.fs.unlinkSync(audioPath);
      } catch {
        // Best-effort rollback; the unindexed audio is never exposed to the renderer.
      }
      throw error;
    }

    this._prune();
    return { ...metadata };
  }

  markFailed(id, reason) {
    const metadata = this._readMetadata(id);
    metadata.status = "failed";
    metadata.reason = String(reason || "Transcription failed")
      .replace(/[\r\n]+/g, " ")
      .slice(0, 500);
    metadata.updatedAt = this.now().toISOString();
    this._writeMetadata(metadata);
    this._prune();
    return { ...metadata };
  }

  markCanceled(id) {
    const metadata = this._readMetadata(id);
    metadata.status = "canceled";
    metadata.reason = "Canceled before transcription completed";
    metadata.updatedAt = this.now().toISOString();
    this._writeMetadata(metadata);
    this._prune();
    return { ...metadata };
  }

  getAudioPath(id) {
    this._assertDirectory();
    const metadata = this._readMetadata(id);
    const audioPath = path.resolve(this.baseDir, metadata.audioFile);
    if (path.dirname(audioPath) !== this.baseDir) {
      throw new Error("Invalid recovery audio path");
    }
    const stat = this.fs.lstatSync(audioPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("Invalid recovery audio path");
    }
    return audioPath;
  }

  list() {
    this._ensureDirectory();
    const entries = [];
    for (const name of this.fs.readdirSync(this.baseDir)) {
      if (!name.endsWith(".json")) continue;
      try {
        const metadataPath = path.join(this.baseDir, name);
        const metadataStat = this.fs.lstatSync(metadataPath);
        if (!metadataStat.isFile() || metadataStat.isSymbolicLink()) continue;
        const metadata = this._validateMetadata(
          JSON.parse(this.fs.readFileSync(metadataPath, { encoding: "utf8" })),
          name.slice(0, -5)
        );
        const audioPath = path.resolve(this.baseDir, metadata.audioFile || "");
        const audioStat = this.fs.lstatSync(audioPath);
        if (
          path.dirname(audioPath) !== this.baseDir ||
          !audioStat.isFile() ||
          audioStat.isSymbolicLink() ||
          !/^[a-zA-Z0-9-]{1,80}$/.test(String(metadata.id || ""))
        ) {
          continue;
        }
        entries.push({ ...metadata });
      } catch {
        // Ignore corrupt/unrelated files without exposing their contents.
      }
    }
    return entries.sort((left, right) =>
      String(right.createdAt).localeCompare(String(left.createdAt))
    );
  }

  recoverInterrupted() {
    const recovered = [];
    for (const metadata of this.list()) {
      if (metadata.status !== "pending") continue;
      metadata.status = "interrupted";
      metadata.reason = "PrivateTranscribe closed before this dictation completed";
      metadata.updatedAt = this.now().toISOString();
      this._writeMetadata(metadata);
      recovered.push({ ...metadata });
    }
    this._prune();
    return recovered;
  }

  remove(id) {
    this._ensureDirectory();
    let audioPath = null;
    try {
      audioPath = this.getAudioPath(id);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      // Metadata may already be missing; still validate the id below.
      this._validateId(id);
    }
    for (const target of [audioPath, this._metadataPath(id)]) {
      if (!target) continue;
      try {
        this.fs.unlinkSync(target);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    return { success: true, id: String(id) };
  }

  clear() {
    this._ensureDirectory();
    const entries = this.list();
    const managedFilePattern = /^[a-zA-Z0-9-]{1,80}\.(json|webm|ogg|wav|mp3|m4a)(\.tmp)?$/;
    for (const name of this.fs.readdirSync(this.baseDir)) {
      if (!managedFilePattern.test(name)) continue;
      const target = path.join(this.baseDir, name);
      const stat = this.fs.lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      this.fs.unlinkSync(target);
    }
    return { success: true, cleared: entries.length };
  }

  _prune() {
    const completedEntries = this.list().filter((entry) => entry.status !== "pending");
    for (const entry of completedEntries.slice(this.maxEntries)) {
      this.remove(entry.id);
    }
  }
}

module.exports = DictationRecoveryManager;
