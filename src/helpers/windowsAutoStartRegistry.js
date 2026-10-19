const { execFileSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Electron's `getLoginItemSettings` is not trustworthy on Windows:
// `executableWillLaunchAtLogin` reports true for an installed app that has no Run entry at
// all, and `launchItems` silently omits every entry whose stored path is quoted — which is
// exactly how Electron writes ours. Both made the settings toggle claim auto-start was on
// when nothing was registered, so it could never be switched on for real.
// The registry is the only authority, so read it directly.
const RUN_KEY = ["HKCU", "Software", "Microsoft", "Windows", "CurrentVersion", "Run"].join("\\");
const APPROVED_KEY = [
  "HKCU",
  "Software",
  "Microsoft",
  "Windows",
  "CurrentVersion",
  "Explorer",
  "StartupApproved",
  "Run",
].join("\\");

// The `hex(n):` value types in a .reg file that we read back; others are skipped.
const HEX_VALUE_TYPES = {
  "": "REG_BINARY",
  1: "REG_SZ",
  2: "REG_EXPAND_SZ",
  7: "REG_MULTI_SZ",
};

/** A "quoted" .reg string starting at `start`, unescaped, and the index after it. */
function readQuoted(text, start) {
  let value = "";
  for (let i = start + 1; i < text.length; i += 1) {
    if (text[i] === "\\" && i + 1 < text.length) {
      i += 1;
      value += text[i];
    } else if (text[i] === '"') {
      return { value, end: i + 1 };
    } else {
      value += text[i];
    }
  }
  return null;
}

function parseValueLine(line) {
  let name = "";
  let data;
  if (line.startsWith("@=")) {
    data = line.slice(2);
  } else if (line.startsWith('"')) {
    const quoted = readQuoted(line, 0);
    if (!quoted || line[quoted.end] !== "=") return null;
    name = quoted.value;
    data = line.slice(quoted.end + 1);
  } else {
    return null;
  }

  if (data.startsWith('"')) {
    const quoted = readQuoted(data, 0);
    return quoted ? { name, type: "REG_SZ", data: quoted.value } : null;
  }

  const hex = data.match(/^hex(?:\(([0-9a-f]+)\))?:([0-9a-f,]*)$/i);
  const type = hex && HEX_VALUE_TYPES[hex[1] || ""];
  if (!type) return null;
  const bytes = Buffer.from(hex[2].replace(/,/g, ""), "hex");
  // Binary keeps the bare hex string `reg query` used to print; text is UTF-16.
  return type === "REG_BINARY"
    ? { name, type, data: bytes.toString("hex").toUpperCase() }
    : { name, type, data: bytes.toString("utf16le").replace(/\0+$/, "") };
}

/**
 * Parse `reg export` output into { name, type, data } rows for the exported key.
 * Its subkeys follow in later [sections] and are left out.
 */
function parseRegExport(text) {
  const lines = String(text || "")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/);
  const rows = [];
  let sections = 0;
  for (let i = 0; i < lines.length; i += 1) {
    let line = lines[i];
    if (line.startsWith("[")) {
      sections += 1;
      if (sections > 1) break;
      continue;
    }
    if (sections === 0) continue;
    // Long hex values wrap: a line ending in ",\" continues on the next one.
    while (line.endsWith(",\\") && i + 1 < lines.length) {
      i += 1;
      line = line.slice(0, -1) + lines[i].trim();
    }
    const row = parseValueLine(line);
    if (row) rows.push(row);
  }
  return rows;
}

/**
 * Pull the executable out of a Run value's data.
 * Quoted is the common case; unquoted paths containing spaces have to be cut at `.exe`,
 * which is the same guess Windows itself makes.
 */
function extractExecutable(data) {
  const value = String(data || "").trim();
  if (!value) return "";

  if (value.startsWith('"')) {
    const closing = value.indexOf('"', 1);
    return closing === -1 ? value.slice(1) : value.slice(1, closing);
  }

  const exeMatch = value.match(/^(.*?\.exe)(\s|$)/i);
  return exeMatch ? exeMatch[1] : value.split(" ")[0];
}

function normalizePath(value) {
  return String(value || "")
    .replace(/^"|"$/g, "")
    .replace(/\//g, "\\")
    .toLowerCase();
}

/**
 * Task Manager / Windows Settings record their switch in StartupApproved as a binary blob
 * whose first byte carries the state: even means enabled, odd means the user disabled it.
 * A missing value means no one has ever touched it, which Windows treats as enabled.
 */
function isApprovedBinary(hex) {
  const cleaned = String(hex || "")
    .trim()
    .replace(/^0x/i, "");
  if (cleaned.length < 2) return true;
  const firstByte = parseInt(cleaned.slice(0, 2), 16);
  return Number.isNaN(firstByte) ? true : (firstByte & 1) === 0;
}

/**
 * The key's values as `reg export` writes them: UTF-16 text in the Registry Editor format.
 *
 * Not `reg query`, which writes the OEM code page (850 on Danish Windows). Read as UTF-8,
 * a Run entry under C:\Users\Søren came back with a replacement character for the "ø" and
 * never matched our executable, so the app re-registered and re-approved itself at every
 * launch and the toggle read off. Letters outside that code page, such as Ω or 李, cannot be
 * recovered from it at all.
 */
function defaultRegReader(key) {
  const file = path.join(os.tmpdir(), `privatetranscribe-reg-${crypto.randomUUID()}.reg`);
  try {
    execFileSync("reg", ["export", key, file, "/y"], {
      timeout: 5000,
      windowsHide: true,
      stdio: "ignore",
    });
    return fs.readFileSync(file).toString("utf16le");
  } finally {
    fs.rmSync(file, { force: true });
  }
}

/**
 * What Windows will actually do with this executable at login.
 *
 * Returns null when the registry could not be read at all, so callers can fall back
 * instead of reporting a confident "off" they cannot back up.
 */
function readAutoStartRegistryState({ execPath, readKey = defaultRegReader } = {}) {
  const target = normalizePath(execPath);
  if (!target) return null;

  let runRows;
  try {
    runRows = parseRegExport(readKey(RUN_KEY));
  } catch {
    // A missing Run key throws in reg.exe the same way a real failure does. Treating it as
    // "unreadable" is the safe reading: callers fall back rather than guess.
    return null;
  }

  const entry = runRows.find((row) => normalizePath(extractExecutable(row.data)) === target);
  if (!entry) {
    return { registered: false, approved: false, name: null };
  }

  let approved = true;
  try {
    const approvedRow = parseRegExport(readKey(APPROVED_KEY)).find(
      (row) => row.name === entry.name
    );
    if (approvedRow) {
      approved = isApprovedBinary(approvedRow.data);
    }
  } catch {
    // No StartupApproved key means nothing has been disabled — enabled stands.
  }

  return { registered: true, approved, name: entry.name };
}

/** True only when Windows will really launch it: registered AND not disabled by the user. */
function registryAutoStartEnabled(state) {
  return Boolean(state && state.registered && state.approved);
}

module.exports = {
  RUN_KEY,
  APPROVED_KEY,
  parseRegExport,
  defaultRegReader,
  extractExecutable,
  isApprovedBinary,
  readAutoStartRegistryState,
  registryAutoStartEnabled,
};
