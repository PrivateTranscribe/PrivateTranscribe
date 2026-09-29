/**
 * Small readers for Windows PE files (.exe, .dll, .node) used by the packaging
 * scripts. They read only what those scripts check; this is not a general parser.
 */

/** IMAGE_FILE_HEADER.Machine values, by electron-builder's arch names. */
const MACHINE = { ia32: 0x14c, x64: 0x8664, arm64: 0xaa64 };

const IMPORT_DIRECTORY = 1;
const DELAY_IMPORT_DIRECTORY = 13;
const IMPORT_DESCRIPTOR_SIZE = 20;
const DELAY_IMPORT_DESCRIPTOR_SIZE = 32;

// VS_FIXEDFILEINFO opens with this signature, followed by its structure version, 1.0.
const FIXED_FILE_INFO_SIGNATURE = Buffer.from([0xbd, 0x04, 0xef, 0xfe]);
const FIXED_FILE_INFO_VERSION = 0x00010000;

function readCString(buffer, offset) {
  const end = buffer.indexOf(0, offset);
  return buffer.toString("latin1", offset, end < 0 ? buffer.length : end);
}

/**
 * The machine type and the DLL names a PE file imports, loaded at start
 * (`imports`) or on first use (`delayImports`). Null when the buffer is not a PE file.
 */
function readImports(buffer) {
  if (buffer.length < 0x40 || buffer.readUInt16LE(0) !== 0x5a4d) return null; // "MZ"
  const peOffset = buffer.readUInt32LE(0x3c);
  if (peOffset + 24 > buffer.length || buffer.readUInt32LE(peOffset) !== 0x4550) return null;

  const machine = buffer.readUInt16LE(peOffset + 4);
  const sectionCount = buffer.readUInt16LE(peOffset + 6);
  const optionalHeader = peOffset + 24;
  const is64 = buffer.readUInt16LE(optionalHeader) === 0x20b; // PE32+
  const imageBase = is64
    ? buffer.readBigUInt64LE(optionalHeader + 24)
    : BigInt(buffer.readUInt32LE(optionalHeader + 28));
  const directoryCountOffset = optionalHeader + (is64 ? 108 : 92);
  const directoryCount = buffer.readUInt32LE(directoryCountOffset);
  const directoryRva = (index) =>
    index < directoryCount ? buffer.readUInt32LE(directoryCountOffset + 4 + index * 8) : 0;

  const sections = [];
  const sectionTable = optionalHeader + buffer.readUInt16LE(peOffset + 20);
  for (let i = 0; i < sectionCount; i++) {
    const at = sectionTable + i * 40;
    sections.push({
      virtualAddress: buffer.readUInt32LE(at + 12),
      size: Math.max(buffer.readUInt32LE(at + 8), buffer.readUInt32LE(at + 16)),
      rawOffset: buffer.readUInt32LE(at + 20),
    });
  }
  const toOffset = (rva) => {
    const section = sections.find(
      (s) => rva >= s.virtualAddress && rva < s.virtualAddress + s.size
    );
    const offset = section ? rva - section.virtualAddress + section.rawOffset : -1;
    return offset < buffer.length ? offset : -1;
  };

  const imports = [];
  let at = toOffset(directoryRva(IMPORT_DIRECTORY));
  while (at >= 0 && at + IMPORT_DESCRIPTOR_SIZE <= buffer.length) {
    const nameRva = buffer.readUInt32LE(at + 12);
    if (!nameRva) break; // The all-zero descriptor ends the table.
    const nameOffset = toOffset(nameRva);
    if (nameOffset >= 0) imports.push(readCString(buffer, nameOffset));
    at += IMPORT_DESCRIPTOR_SIZE;
  }

  const delayImports = [];
  at = toOffset(directoryRva(DELAY_IMPORT_DIRECTORY));
  while (at >= 0 && at + DELAY_IMPORT_DESCRIPTOR_SIZE <= buffer.length) {
    const attributes = buffer.readUInt32LE(at);
    const name = buffer.readUInt32LE(at + 4);
    if (!name) break;
    // Attribute bit 0 marks RVAs; old linkers wrote virtual addresses instead.
    const nameRva = attributes & 1 ? name : Number(BigInt(name) - imageBase);
    const nameOffset = toOffset(nameRva);
    if (nameOffset >= 0) delayImports.push(readCString(buffer, nameOffset));
    at += DELAY_IMPORT_DESCRIPTOR_SIZE;
  }

  return { machine, imports, delayImports };
}

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

module.exports = { MACHINE, readFileVersion, readImports };
