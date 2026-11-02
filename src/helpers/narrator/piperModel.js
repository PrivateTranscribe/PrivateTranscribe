"use strict";

/**
 * Turns a Piper voice as published (model.onnx + model.onnx.json) into the
 * shape sherpa-onnx-node's VITS engine reads: the same onnx file with a few
 * metadata entries added, and a tokens.txt. sherpa-onnx is already in the app
 * for Parakeet, so the Danish voice runs without Python.
 *
 * The metadata is appended to the file rather than rewritten through an onnx
 * library: an ONNX model is one protobuf ModelProto message, protobuf allows a
 * message's fields in any order, and metadata_props is a repeated field
 * (number 14) of key/value string pairs. Appending entries to the end of the
 * file adds them and changes nothing else.
 */

const fs = require("node:fs");

const METADATA_PROPS_FIELD = 14;

function varint(value) {
  const bytes = [];
  let rest = value >>> 0;
  while (rest > 0x7f) {
    bytes.push((rest & 0x7f) | 0x80);
    rest >>>= 7;
  }
  bytes.push(rest);
  return Buffer.from(bytes);
}

/** One length-delimited protobuf field. */
function lengthDelimited(field, payload) {
  return Buffer.concat([varint((field << 3) | 2), varint(payload.length), payload]);
}

/** metadata_props entries for `entries`, ready to append to a ModelProto. */
function encodeMetadataProps(entries) {
  const parts = [];
  for (const [key, value] of Object.entries(entries)) {
    const entry = Buffer.concat([
      lengthDelimited(1, Buffer.from(String(key), "utf8")),
      lengthDelimited(2, Buffer.from(String(value), "utf8")),
    ]);
    parts.push(lengthDelimited(METADATA_PROPS_FIELD, entry));
  }
  return Buffer.concat(parts);
}

/** What sherpa-onnx reads from a Piper model, taken from the voice's own config. */
function sherpaMetadata(config) {
  const voice = config?.espeak?.voice;
  if (!voice) throw new Error("The Piper voice config has no espeak voice");
  return {
    model_type: "vits",
    comment: "piper",
    language: config?.language?.name_english || voice,
    voice,
    has_espeak: 1,
    n_speakers: config?.num_speakers || 1,
    sample_rate: config?.audio?.sample_rate || 22050,
  };
}

/** tokens.txt: one "<symbol> <id>" line per phoneme, as sherpa-onnx expects. */
function buildTokens(config) {
  const map = config?.phoneme_id_map;
  if (!map || typeof map !== "object") throw new Error("The Piper voice config has no phoneme map");
  return Object.entries(map)
    .map(([symbol, ids]) => `${symbol} ${Array.isArray(ids) ? ids[0] : ids}`)
    .join("\n")
    .concat("\n");
}

/**
 * Writes `<destOnnx>` (model with metadata) and `<destTokens>` from a Piper
 * voice. The source files are left as they are.
 */
function prepareSherpaPiperModel({ srcOnnx, srcConfig, destOnnx, destTokens }) {
  const config = JSON.parse(fs.readFileSync(srcConfig, "utf8"));
  fs.writeFileSync(destTokens, buildTokens(config), "utf8");
  const tmp = `${destOnnx}.tmp`;
  fs.copyFileSync(srcOnnx, tmp);
  fs.appendFileSync(tmp, encodeMetadataProps(sherpaMetadata(config)));
  fs.renameSync(tmp, destOnnx);
  return { sampleRate: config?.audio?.sample_rate || 22050 };
}

module.exports = {
  encodeMetadataProps,
  sherpaMetadata,
  buildTokens,
  prepareSherpaPiperModel,
  varint,
};
