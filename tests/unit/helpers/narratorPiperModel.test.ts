import { describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  encodeMetadataProps,
  buildTokens,
  sherpaMetadata,
  varint,
} = require("../../../src/helpers/narrator/piperModel");

/** Reads back the metadata_props entries appended to a ModelProto. */
function decode(buffer: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let pos = 0;
  const readVarint = () => {
    let result = 0;
    let shift = 0;
    for (;;) {
      const byte = buffer[pos++];
      result |= (byte & 0x7f) << shift;
      if (!(byte & 0x80)) return result;
      shift += 7;
    }
  };
  while (pos < buffer.length) {
    const tag = readVarint();
    expect(tag).toBe((14 << 3) | 2);
    const end = readVarint() + pos;
    let key = "";
    let value = "";
    while (pos < end) {
      const field = readVarint() >> 3;
      const len = readVarint();
      const text = buffer.subarray(pos, pos + len).toString("utf8");
      pos += len;
      if (field === 1) key = text;
      else value = text;
    }
    out[key] = value;
  }
  return out;
}

const CONFIG = {
  audio: { sample_rate: 22050 },
  espeak: { voice: "da" },
  language: { name_english: "Danish" },
  num_speakers: 1,
  phoneme_id_map: { _: [0], "^": [1], " ": [3], æ: [40] },
};

describe("Piper model conversion for sherpa-onnx", () => {
  it("encodes metadata as ModelProto field 14 key/value entries", () => {
    expect(decode(encodeMetadataProps(sherpaMetadata(CONFIG)))).toEqual({
      model_type: "vits",
      comment: "piper",
      language: "Danish",
      voice: "da",
      has_espeak: "1",
      n_speakers: "1",
      sample_rate: "22050",
    });
  });

  it("writes varints the protobuf way", () => {
    expect([...varint(1)]).toEqual([1]);
    expect([...varint(300)]).toEqual([0xac, 0x02]);
  });

  it("writes one token per line, keeping the space symbol", () => {
    expect(buildTokens(CONFIG)).toBe("_ 0\n^ 1\n  3\næ 40\n");
  });

  it("refuses a config without an espeak voice", () => {
    expect(() => sherpaMetadata({})).toThrow(/espeak/);
  });
});
