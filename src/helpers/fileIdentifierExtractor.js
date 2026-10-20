/**
 * fileIdentifierExtractor — main process helper for Smart Context file identifiers.
 *
 * Extracts camelCase, snake_case, and function-name identifiers from a source file.
 * All safety checks (home-dir scope, file-size limit) live here as pure functions
 * so they can be unit-tested without the Electron runtime.
 *
 * @module fileIdentifierExtractor
 */

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

/** Maximum file size (bytes) we will read. Files larger than this are skipped. */
const MAX_FILE_BYTES = 500 * 1024; // 500 KB

/** Maximum number of identifiers returned (keeps Whisper prompt terse). */
const MAX_IDENTIFIERS = 50;

/**
 * Returns true when `filePath` is safely inside `homeDir`.
 * Prevents reading sensitive files outside the user's home directory.
 *
 * @param {string} filePath
 * @param {string} [homeDir]  Defaults to os.homedir(). Injected for testing.
 * @returns {boolean}
 */
function isSafeFilePath(filePath, homeDir) {
  const home = homeDir || os.homedir();
  const resolved = path.resolve(filePath);
  // Must be strictly inside home (not a path that merely starts with the home prefix
  // on a system where another user has a home that's a prefix of this one).
  return resolved === home || resolved.startsWith(home + path.sep);
}

/**
 * Returns true when the file is too large to read.
 *
 * @param {number} fileSizeBytes
 * @param {number} [maxBytes]  Defaults to MAX_FILE_BYTES (500 KB).
 * @returns {boolean}
 */
function isFileTooLarge(fileSizeBytes, maxBytes) {
  return fileSizeBytes > (maxBytes !== undefined ? maxBytes : MAX_FILE_BYTES);
}

/** File names that hold credentials, so nothing is read from them at all. */
const CREDENTIAL_FILE_PATTERNS = [
  /(?:^|\.)env(?:\.|$)/i, // .env, .env.local, prod.env
  /\.(?:pem|key|ppk|pfx|p12|jks|keystore|tfvars)(?:\.json)?$/i,
  /^id_/i, // id_rsa, id_ed25519
  /^[._](?:npmrc|netrc|pgpass|htpasswd|pypirc)$/i,
];

/** Source code, where a name such as secretManager.ts names code about secrets. */
const SOURCE_FILE_EXTENSION =
  /\.(?:[cm]?[jt]sx?|py|rb|go|rs|java|kt|kts|cs|swift|c|cc|cpp|h|hpp|php|vue|svelte|dart|scala)$/i;

/**
 * Words that, right after "Secret" or "Credential" in a source file's
 * camelCase name, make it code about secrets rather than a file of them.
 * Words such as Key, Config, Settings or Values are left out on purpose.
 */
const CODE_ROLE_AFTER_SECRET_WORD =
  /^s?(?:Manager|Provider|Panel|Service|Dialog|View|Form|Page|Screen|Modal|Button|Input|Field|List|Card|Section|Handler|Helper|Validator|Scanner|Detector|Redactor|Client|Reader|Loader|Picker|Editor)(?![a-z])/;

/**
 * Returns true when "credential" or "secret" in the name names the file's
 * contents. In a source file where the word is followed by a word naming
 * code, as in secretManager.ts or CredentialsPanel.tsx, it names code about
 * secrets instead. Every other use counts: secrets.ts, secretKey.ts,
 * aws-credentials.ts, client_secret.json, secretManager.json.
 *
 * @param {string} name
 * @returns {boolean}
 */
function namesSecrets(name) {
  const source = SOURCE_FILE_EXTENSION.test(name);
  for (const match of name.matchAll(/credential|secret/gi)) {
    const rest = name.slice(match.index + match[0].length);
    if (!source || !CODE_ROLE_AFTER_SECRET_WORD.test(rest)) return true;
  }
  return false;
}

/**
 * Returns true when the file's name says it holds credentials: .env files,
 * key and certificate stores, SSH keys, Terraform variables, and any name
 * with "credential" or "secret" in it other than source code about secrets.
 *
 * @param {string} filePath
 * @returns {boolean}
 */
function isCredentialFile(filePath) {
  const name = path.basename(String(filePath || ""));
  return CREDENTIAL_FILE_PATTERNS.some((pattern) => pattern.test(name)) || namesSecrets(name);
}

/**
 * Extract unique identifiers from source code content.
 *
 * Captures:
 *  - camelCase tokens (e.g. `getContext`, `myVariable`)
 *  - snake_case tokens (e.g. `my_variable`, `http_client`)
 *  - named function declarations (`function foo(`)
 *  - const/let/var arrow-function names (`const foo = (`, `const foo = async (`)
 *
 * @param {string} content
 * @returns {string[]}
 */
function extractIdentifiers(content) {
  const seen = new Set();

  const addAll = (re) => {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(content)) !== null) {
      const id = m[1] || m[0];
      if (id && id.length >= 3 && id.length <= 60) seen.add(id);
    }
  };

  // camelCase (at least one lowercase-to-uppercase transition)
  addAll(/\b([a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*)\b/g);

  // snake_case (at least one underscore between lowercase words)
  addAll(/\b([a-z][a-z0-9]*(?:_[a-z][a-z0-9]*)+)\b/g);

  // function keyword declarations
  addAll(/\bfunction\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/g);

  // const/let/var arrow-function patterns
  addAll(/\b(?:const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*(?:async\s+)?\(/g);

  return Array.from(seen).slice(0, MAX_IDENTIFIERS);
}

/**
 * Read a file from disk and extract identifiers.
 * Returns a result object; never throws.
 *
 * @param {string} filePath   Absolute path to the file.
 * @param {string} [homeDir]  Injected for testing (defaults to os.homedir()).
 * @param {{ statSync?: Function, readFileSync?: Function }} [fsMod]
 *   Injectable fs module for unit tests (defaults to Node's built-in `fs`).
 *
 * @returns {{ blocked: boolean, reason?: string, identifiers: string[], filename?: string }}
 */
function extractFromFilePath(filePath, homeDir, fsMod) {
  const fsImpl = fsMod || fs;

  if (!isSafeFilePath(filePath, homeDir)) {
    return { blocked: true, reason: "outside home dir", identifiers: [] };
  }
  if (isCredentialFile(filePath)) {
    return { blocked: true, reason: "credentials file", identifiers: [] };
  }

  try {
    const stat = fsImpl.statSync(filePath);
    if (isFileTooLarge(stat.size)) {
      return { blocked: true, reason: "file too large", identifiers: [] };
    }
    const content = fsImpl.readFileSync(filePath, "utf8");
    return {
      blocked: false,
      identifiers: extractIdentifiers(content),
      filename: path.basename(filePath),
    };
  } catch (err) {
    return { blocked: false, identifiers: [], reason: `could not read file: ${err.message}` };
  }
}

module.exports = {
  isSafeFilePath,
  isFileTooLarge,
  isCredentialFile,
  extractIdentifiers,
  extractFromFilePath,
};
