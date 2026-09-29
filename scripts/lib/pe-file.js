/**
 * Small readers for Windows PE files (.exe, .dll, .node) used by the packaging
 * scripts. They read only what those scripts check; this is not a general parser.
 */

// VS_FIXEDFILEINFO opens with this signature, followed by its structure version, 1.0.
const FIXED_FILE_INFO_SIGNATURE = Buffer.from([0xbd, 0x04, 0xef, 0xfe]);
const FIXED_FILE_INFO_VERSION = 0x00010000;

/** The numeric file version as [major, minor, build, revision], or null without one. */
function readFileVersion(buffer) {
  let at = buffer.indexOf(FIXED_FILE_INFO_SIGNATURE);
  while (at >= 0 && at + 16 <= buffer.length) {
    if (buffer.readUInt32LE(at + 4) === FIXED_FILE_INFO_VERSION) {
      const high = buffer.readUInt32LE(at + 8);
      const low = buffer.readUInt32LE(at + 12);
      return [high >>> 16, high & 0xffff, low >>> 16, low & 0xffff];
    }
    at = buffer.indexOf(FIXED_FILE_INFO_SIGNATURE, at + 1);
  }
  return null;
}

module.exports = { readFileVersion };
