"use strict";

/**
 * Context sanitization utilities.
 *
 * Goal: allow us to capture useful window/app context while reducing the risk of
 * accidental collection of sensitive values (passwords, API keys, secrets).
 *
 * This module is intentionally dependency-free and safe to use in both Electron
 * main/renderer.
 */

// A name that ends in a secret word, whatever comes before it: DB_PASS,
// JWT_SECRET, AWS_SECRET_ACCESS_KEY, x-api-key, spring.datasource.password,
// Ocp-Apim-Subscription-Key, and the password labels of Danish, Norwegian,
// Swedish, German and French screens. Words that only end in "pass", such as
// BYPASS and COMPASS, are not secret names.
const SECRET_NAME = String.raw`[A-Z0-9_.-]*(?:SECRET|TOKEN|PASS(?:W(?:OR)?D|WORT|ORD)|(?<!BY|COM|SUR|TRES|OVER|UNDER)PASS|PASSPHRASE|PWD|CREDENTIALS?|(?:SECRET|API|ACCESS|PRIVATE|ACCOUNT|AUTH|SIGNING|ENCRYPTION|MASTER|SUBSCRIPTION|FUNCTIONS?)[_-]?KEY|ADGANGSKODE|KODEORD|LÖSENORD|KENNWORT|MOT[ _-]DE[ _-]PASSE)`;
// ":", "=" or ":=" after a name. "==", "=>" and "::" are code, not
// assignments.
const ASSIGNMENT = String.raw`(?::=|[:=](?![=>:]))`;
// A quoted value, where a backslash escapes the next character. When the
// closing quote is missing, as in a read cut off at a length, it ends at the
// end of the line. Written as a run of plain characters between escapes, so
// a long value does not grow the regex engine's backtracking stack one entry
// per character: alternating per character overflowed it at 10 MB.
const QUOTED_VALUE = String.raw`"[^"\\\n]*(?:\\.[^"\\\n]*)*"?|'[^'\\\n]*(?:\\.[^'\\\n]*)*'?`;
// The text of an XML element: a CDATA section up to its "]]>" or the end of
// the text, or plain text up to the next tag or the end of the line.
const XML_TEXT = String.raw`<!\[CDATA\[[\s\S]*?(?:\]\]>|$)|[^<\s][^<\n\r]*`;
// A name="..." attribute that holds a secret name, as in
// <property name="password">.
const SECRET_NAME_ATTRIBUTE = new RegExp(
  String.raw`(?<![\w:.-])name[ \t]*=[ \t]*(["'])${SECRET_NAME}\1`,
  "i"
);
// A type annotation in place of a value: "token: string;", "apiKey: string |
// null", "f(token: string, secret: Buffer)", "password: str" at the end of a
// line. It counts only when what follows the type is what code puts there:
// the end of the line, the next parameter's name, or a closing bracket. With
// a default after it, as in "password: str = 'x'", it is not one, and the
// line is redacted.
const TYPE_WORD = String.raw`(?:string|number|boolean|bigint|any|unknown|object|never|void|null|undefined|str|int|bytes|bool|Buffer|Uint8Array|SecretStr|SecretString)(?:\[\])?`;
const LINE_END = String.raw`[ \t]*(?:\r?\n|$)`;
const TYPE_ANNOTATION = String.raw`${TYPE_WORD}(?:[ \t]*[|&][ \t]*${TYPE_WORD})*[ \t]*(?:[;,]?${LINE_END}|[;,][ \t]*[A-Z_$][\w$]*\??[ \t]*:|\)[ \t]*(?:[:{;,)=]|->|${LINE_END})|\}[ \t]*(?:[;,)}=]|${LINE_END}))`;

const DEFAULT_REDACTION_PATTERNS = [
  // PEM and PGP private key blocks. A block with no END line, as in a read
  // cut off at a length, is redacted to the end of the text. The BEGIN line
  // must end in "PRIVATE KEY-----", or "PRIVATE KEY BLOCK-----" for PGP, as
  // every real one does, so source code that only mentions
  // "-----BEGIN RSA PRIVATE KEY" keeps the code after it. That check has a
  // fixed length, so text repeating "BEGIN" lines or "PRIVATE KEY" is still
  // scanned in linear time. First in the list, so a field rule redacting
  // PRIVATE_KEY=-----BEGIN cannot take the BEGIN line and leave the key body.
  {
    name: "privateKeyBlock",
    regex:
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?:[A-Z ]*-----)?|$)/g,
    replacement: "[REDACTED_PRIVATE_KEY]",
  },
  // A value given to any name that ends in a secret word, whatever comes
  // before it and with or without quotes: password: "hunter two", DB_PASS=,
  // JWT_SECRET=, AWS_SECRET_ACCESS_KEY=, x-api-key:, "client_secret": "x",
  // spring.datasource.password=, AccountKey=, config["password"] = "x". The
  // name, and a scheme word such as "Bearer", are kept, so the text still
  // reads. An unquoted value runs to the end of the line, since a password
  // can hold spaces and a name left empty can be followed by another, as in
  // "API_KEY: SECRET: x". A YAML block ("password: |") takes the indented
  // lines under it. A quoted value ends at its closing quote or, when that
  // is missing, at the end of the line, so it never takes the next line's
  // name with it. A quoted value followed by an assignment was a name, as in
  // "API_KEY: 'SECRET': x", so the rest of its line goes too. A type
  // annotation in place of the value, as in "token: string;", is left alone.
  // The lookbehind lets a match start only where a name starts, so a long
  // run is scanned once.
  {
    name: "secretAssignment",
    regex: new RegExp(
      String.raw`((?<![A-Z0-9_.-])["']?${SECRET_NAME}["']?\]?[ \t]*${ASSIGNMENT}[ \t]*(?:(?:bearer|basic|token|digest)[ \t]+)?)(?!${TYPE_ANNOTATION})((?:${QUOTED_VALUE})(?:[ \t]*${ASSIGNMENT}[^\n\r]*)?|[|>][-+0-9]*[ \t]*(?:(?:\r?\n)+[ \t]+[^\r\n]*)+|[^\s'"][^\n\r]*)`,
      "gi"
    ),
    replacement: "$1[REDACTED]",
  },
  // XML elements and attributes: <password>x</password>, the same with the
  // value in a CDATA section or one child element (<password><value>x),
  // and the .NET and Spring <add key="ApiKey" value="x"/>,
  // <property name="password" value="x"/> and
  // <setting name="Password"><value>x</value>. An element's text ends at the
  // next tag or the end of its line, a CDATA section at its "]]>". A
  // self-closing element holds no value and is left alone.
  {
    name: "secretElement",
    regex: new RegExp(
      String.raw`(<(?:[A-Z0-9_.-]+:)?${SECRET_NAME}(?:\s[^<>]*)?(?<!\/)>\s*(?:<(?![\/!])(?:[A-Z0-9_.-]+:)?[A-Z0-9_.-]+(?:\s[^<>]*)?(?<!\/)>\s*)?)(${XML_TEXT})`,
      "gi"
    ),
    replacement: "$1[REDACTED]",
  },
  // The secret name is checked in the tag's attributes after the match, so
  // a match starts only at "<" and each tag is scanned once. Attributes
  // start with whitespace, so the tag name and attributes never share
  // characters.
  {
    name: "secretNamedValueElement",
    regex: new RegExp(
      String.raw`(<[\w:.-]+(\s[^<>]*)>\s*<value(?:\s[^<>]*)?>\s*)(${XML_TEXT})`,
      "gi"
    ),
    replacement: (match, head, attributes) =>
      SECRET_NAME_ATTRIBUTE.test(attributes) ? `${head}[REDACTED]` : match,
  },
  {
    name: "secretAttribute",
    regex: new RegExp(
      String.raw`(\b(?:key|name)[ \t]*=[ \t]*(["'])${SECRET_NAME}\2\s+value[ \t]*=[ \t]*)("[^"\n]*"?|'[^'\n]*'?)`,
      "gi"
    ),
    replacement: "$1[REDACTED]",
  },
  // Command-line flags followed by their value: --password x, -storepass x.
  // "--password=x" is an assignment and is redacted above.
  {
    name: "secretFlag",
    regex: new RegExp(
      String.raw`((?<![\w.-])-${SECRET_NAME}[ \t]+)(${QUOTED_VALUE}|[^\s'"]+)`,
      "gi"
    ),
    replacement: "$1[REDACTED]",
  },
  // mysql, mariadb, 7-Zip and RAR take the password glued to -p, as in
  // "mysql -uroot -phunter2". Only on a line that runs one of them, since
  // -p means something else to most commands (-pthread, -print).
  {
    name: "gluedPasswordFlag",
    regex: /(\b(?:mysql\w*|mariadb[\w-]*|7z[az]?|unrar|rar)\b)([^\n]*)/gi,
    replacement: (match, tool, rest) =>
      tool + rest.replace(/((?<![\w-])-p)(?:"[^"]*"?|'[^']*'?|[^\s'"]+)/g, "$1[REDACTED]"),
  },
  // Secrets passed to a call: setPassword("x"), withApiKey('x'), a quoted
  // secret name and its value in define('DB_PASSWORD', 'x') or
  // headers.set("X-Api-Key", "x"), and the second argument of a login call,
  // login("admin", "x"). Only a quoted value is redacted, so code passing a
  // variable reads as before.
  {
    name: "secretCallArgument",
    regex: new RegExp(
      String.raw`((?<![A-Z0-9_.-])${SECRET_NAME}[ \t]*\([ \t]*)(${QUOTED_VALUE}|\x60[^\x60\n]*\x60?)`,
      "gi"
    ),
    replacement: "$1[REDACTED]",
  },
  {
    name: "secretNameArgument",
    regex: new RegExp(
      String.raw`(\([ \t]*(["'])${SECRET_NAME}\2[ \t]*,[ \t]*)(${QUOTED_VALUE})`,
      "gi"
    ),
    replacement: "$1[REDACTED]",
  },
  {
    name: "loginCallPassword",
    regex: new RegExp(
      String.raw`((?<![\w$])[\w$]*(?:log_?in|sign_?in|authenticate)[ \t]*\([ \t]*(?:"[^"\\\n]*(?:\\.[^"\\\n]*)*"|'[^'\\\n]*(?:\\.[^'\\\n]*)*'|[\w.$]+)[ \t]*,[ \t]*)(${QUOTED_VALUE})`,
      "gi"
    ),
    replacement: "$1[REDACTED]",
  },
  // Phone numbers are personally identifying; only redact when clearly labeled
  // to reduce false positives.
  {
    name: "phoneField",
    regex:
      /(\b(?:phone|mobile|tel(?:ephone)?)\s*[:=]\s*)("[^"]*"|'[^']*'|[+\d][0-9 ()-]{6,}[0-9])/gi,
    replacement: "$1[REDACTED_PHONE]",
  },
  // National IDs / SSNs are personally identifying; redact only when clearly labeled
  // to reduce false positives (dates, invoice numbers, etc.). Includes DK CPR.
  {
    name: "nationalIdField",
    regex:
      /(\b(?:ssn|social\s*security|national\s*(?:id|identification)|cpr)\s*[:=]\s*)("[^"]*"|'[^']*'|\d{6}[- ]?\d{4}|[0-9][0-9 ()-]{6,}[0-9])\b/gi,
    replacement: "$1[REDACTED_NATIONAL_ID]",
  },
  // 2FA / verification codes (keep narrow to avoid redacting dates/times)
  {
    name: "verificationCode",
    regex:
      /((?:verification|one[-\s]?time|security|auth|otp|2fa)\s*(?:code|passcode)\s*[:=]\s*)(\d{4,8})\b/gi,
    replacement: "$1[REDACTED_CODE]",
  },
  // OAuth authorization codes can grant access (keep narrow: require explicit auth/oauth wording).
  {
    name: "oauthAuthorizationCode",
    regex: /(\b(?:authorization[_-]?code|auth[_-]?code)\s*[:=]\s*)([^\s'"\n\r]+)/gi,
    replacement: "$1[REDACTED]",
  },
  {
    name: "oauthAuthCodePhrase",
    regex: /(\b(?:oauth|authorization)\s*code\s*[:=]\s*)([^\s'"\n\r]+)/gi,
    replacement: "$1[REDACTED]",
  },
  // Bearer tokens in logs/headers, and in JSON ("Authorization": "Bearer x").
  {
    name: "bearerToken",
    regex: /(authorization["']?\s*[:=]\s*["']?bearer\s+)([^\s'"\n\r]+)/gi,
    replacement: "$1[REDACTED]",
  },
  // Basic auth tokens in logs/headers.
  {
    name: "basicAuthToken",
    regex: /(authorization["']?\s*[:=]\s*["']?basic\s+)([^\s'"\n\r]+)/gi,
    replacement: "$1[REDACTED]",
  },
  // Token auth scheme (commonly used by GitHub and various APIs).
  {
    name: "tokenAuthToken",
    regex: /(authorization["']?\s*[:=]\s*["']?token\s+)([^\s'"\n\r]+)/gi,
    replacement: "$1[REDACTED]",
  },
  // Proxy auth headers can also carry bearer/basic credentials.
  {
    name: "proxyBearerToken",
    regex: /(proxy-authorization["']?\s*[:=]\s*["']?bearer\s+)([^\s'"\n\r]+)/gi,
    replacement: "$1[REDACTED]",
  },
  {
    name: "proxyBasicAuthToken",
    regex: /(proxy-authorization["']?\s*[:=]\s*["']?basic\s+)([^\s'"\n\r]+)/gi,
    replacement: "$1[REDACTED]",
  },
  // Cookie headers can contain session identifiers and auth state.
  {
    name: "cookieHeader",
    regex: /(\bcookie\s*[:=]\s*)([^\n\r]+)/gi,
    replacement: "$1[REDACTED_COOKIES]",
  },
  {
    name: "setCookieHeader",
    regex: /(\bset-cookie\s*[:=]\s*)([^\n\r]+)/gi,
    replacement: "$1[REDACTED_COOKIES]",
  },
  // Generic "Bearer <token>" fragments (often show up without the Authorization label).
  // Keep it conservative by requiring a token-like shape and minimum length.
  {
    name: "genericBearerToken",
    regex: /(\bbearer\s+)([A-Za-z0-9._-]{10,})\b/gi,
    replacement: "$1[REDACTED]",
  },
  // OpenAI and Anthropic keys: sk-..., sk-proj-..., sk-svcacct-..., sk-ant-api03-...
  // Their bodies hold "_" and "-", where a word boundary can stop the match
  // inside the key or miss it entirely, so the whole run of key characters is
  // matched instead. The lookbehind keeps words like "task-" out.
  {
    name: "skKey",
    regex: /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}/g,
    replacement: "[REDACTED]",
  },
  // Groq keys
  {
    name: "groqKey",
    regex: /(?<![A-Za-z0-9])gsk_[A-Za-z0-9_-]{20,}/g,
    replacement: "[REDACTED_GROQ_KEY]",
  },
  // Stripe keys / secrets (sk_ secret keys, rk_ restricted keys)
  {
    name: "stripeSecretKey",
    regex: /\b[rs]k_(?:live|test)_[0-9A-Za-z]{10,}\b/g,
    replacement: "[REDACTED_STRIPE_KEY]",
  },
  {
    name: "stripePublishableKey",
    regex: /\bpk_(?:live|test)_[0-9A-Za-z]{10,}\b/g,
    replacement: "[REDACTED_STRIPE_KEY]",
  },
  {
    name: "stripeWebhookSecret",
    regex: /\bwhsec_[0-9A-Za-z]{10,}\b/g,
    replacement: "[REDACTED_STRIPE_WEBHOOK_SECRET]",
  },
  // Google API keys (often show up in URLs/config)
  {
    name: "googleApiKey",
    // Typical Google API keys are 39 chars total ("AIza" + 35); accept 30 or
    // more so a slightly different length is not missed. Matched to the end of
    // the run of key characters, since a key ending in "-" has no word
    // boundary where it ends.
    regex: /(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{30,}/g,
    replacement: "[REDACTED_GOOGLE_API_KEY]",
  },
  // Google OAuth access tokens (often start with ya29.)
  {
    name: "googleOAuthToken",
    regex: /\bya29\.[0-9A-Za-z_-]{20,}\b/g,
    replacement: "[REDACTED_GOOGLE_OAUTH_TOKEN]",
  },
  // JWTs (common in auth headers, logs, debug output)
  {
    name: "jwt",
    regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    replacement: "[REDACTED_JWT]",
  },
  // AWS access key ids (often pasted into terminals, logs, dashboards)
  {
    name: "awsAccessKeyId",
    regex: /\b(?:AKIA|ABIA|ACCA|ASIA)[0-9A-Z]{16}\b/g,
    replacement: "[REDACTED_AWS_KEY]",
  },
  // GitHub tokens: personal (ghp_), OAuth (gho_), user (ghu_), server (ghs_),
  // refresh (ghr_) and fine-grained (github_pat_)
  {
    name: "githubTokenClassic",
    regex: /\bgh[opsur]_[A-Za-z0-9]{20,}\b/g,
    replacement: "[REDACTED_GITHUB_TOKEN]",
  },
  {
    name: "githubTokenFineGrained",
    regex: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
    replacement: "[REDACTED_GITHUB_TOKEN]",
  },
  // GitLab personal access tokens
  {
    name: "gitlabToken",
    regex: /(?<![A-Za-z0-9])glpat-[A-Za-z0-9_-]{20,}/g,
    replacement: "[REDACTED_GITLAB_TOKEN]",
  },
  // npm and Hugging Face access tokens
  {
    name: "npmToken",
    regex: /\bnpm_[A-Za-z0-9]{36,}\b/g,
    replacement: "[REDACTED_NPM_TOKEN]",
  },
  {
    name: "huggingFaceToken",
    regex: /\bhf_[A-Za-z0-9]{30,}\b/g,
    replacement: "[REDACTED_HF_TOKEN]",
  },
  // Slack tokens (bot/user/app tokens commonly start with xox*)
  {
    name: "slackToken",
    regex: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g,
    replacement: "[REDACTED_SLACK_TOKEN]",
  },
  // Slack and Discord webhook URLs: the path is what lets anyone post.
  {
    name: "slackWebhook",
    regex: /(https:\/\/hooks\.slack\.com\/(?:services|workflows|triggers)\/)[A-Za-z0-9_/-]+/gi,
    replacement: "$1[REDACTED]",
  },
  {
    name: "discordWebhook",
    regex:
      /(https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api\/webhooks\/)[0-9]+\/[A-Za-z0-9_-]+/gi,
    replacement: "$1[REDACTED]",
  },
  // Emails (can appear in window titles, docs, tickets, etc.)
  // The lookbehind lets a match start only where a run of address characters
  // starts. With \b it could start at every "." of a run like "a.a.a.", and
  // each start rescanned the rest of the run.
  {
    name: "email",
    regex: /(?<![A-Z0-9._%+-])[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    replacement: "[REDACTED_EMAIL]",
  },
  // URLs with query strings (query params often contain tokens/ids/search
  // terms) or fragments (OAuth implicit flow tokens sometimes appear after #).
  // Every URL is matched, with or without a "?" or "#", so the scan moves past
  // it. Requiring the "?" made a URL without one fail and get rescanned from
  // each later "http" in it.
  {
    name: "urlQueryOrFragment",
    regex: /(https?:\/\/[\w\-._~%!$&'()*+,;=:@/]+)(?:([?#])([^\s'"\n\r]*))?/gi,
    replacement: (match, url, mark, tail) => {
      if (!mark || !tail) return match;
      return `${url}${mark}${mark === "?" ? "[REDACTED_QUERY]" : "[REDACTED_FRAGMENT]"}`;
    },
  },
  // Long base64-ish strings wrapped in quotes (often API keys / tokens in JSON)
  {
    name: "longQuotedSecret",
    regex: /(["'])([A-Za-z0-9+/=_-]{32,})(["'])/g,
    replacement: "$1[REDACTED_SECRET]$3",
  },
  // Long hex tokens (hashes, ids, secrets). Keep it conservative.
  {
    name: "longHexToken",
    regex: /\b[a-f0-9]{32,}\b/gi,
    replacement: "[REDACTED]",
  },
  // Long runs of letters and digits, such as 84-character Azure keys. Text
  // rarely holds one this long that is not a key or a token.
  {
    name: "longAlphanumericToken",
    regex: /(?<![A-Za-z0-9])[A-Za-z0-9]{80,}/g,
    replacement: "[REDACTED]",
  },
];

function truncateUtf8Safe(text, maxChars) {
  if (typeof text !== "string") return "";
  if (!Number.isFinite(maxChars) || maxChars <= 0) return "";
  if (text.length <= maxChars) return text;

  // This truncation is code-unit based; good enough for our use (we want to
  // avoid huge payloads), but keep the function separate so we can improve it
  // later if needed.
  return text.slice(0, maxChars);
}

function luhnCheck(digits) {
  if (typeof digits !== "string" || !/^\d+$/.test(digits)) return false;
  let sum = 0;
  let shouldDouble = false;

  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (shouldDouble) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    shouldDouble = !shouldDouble;
  }

  return sum % 10 === 0;
}

function redactLikelyCardNumbers(text) {
  if (typeof text !== "string" || !text) return "";

  // Look for sequences that could be PANs with optional spaces/hyphens.
  // We Luhn-check to reduce false positives.
  const panLike = /\b(?:\d[ -]?){13,19}\d\b/g;

  return text.replace(panLike, (match) => {
    const digits = match.replace(/[^0-9]/g, "");
    if (digits.length < 13 || digits.length > 19) return match;
    if (!luhnCheck(digits)) return match;
    return "[REDACTED_CARD]";
  });
}

function redactUrlCredentials(text) {
  if (typeof text !== "string" || !text) return "";

  // Redact `scheme://user:pass@host` style credentials. Common in database URLs,
  // cloud service DSNs, and dev configs. The match starts at "://" and leaves
  // whatever scheme comes before it as text: matching the scheme too either
  // rescanned runs like "a.a.a." from every character or missed a scheme
  // that follows "-", "." or "+".
  const urlCredsRegex = /(:\/\/)([^\s\/:@]+):([^\s@\/]+)@/g;

  return text.replace(urlCredsRegex, "$1$2:[REDACTED]@");
}

/**
 * @param {string} text
 * @param {{
 *   maxChars?: number,
 *   redactionPatterns?: Array<{name?: string, regex: RegExp, replacement: string | Function}>
 * }} [options]
 */
function sanitizeContextText(text, options = {}) {
  const maxChars = Number.isFinite(options.maxChars) ? options.maxChars : 8000;
  const patterns = Array.isArray(options.redactionPatterns)
    ? options.redactionPatterns
    : DEFAULT_REDACTION_PATTERNS;

  let output = typeof text === "string" ? text : "";

  // A pattern can run out of regex engine stack on text of many megabytes,
  // such as a huge focused field. Nothing is returned then, rather than text
  // that was redacted only in part.
  try {
    // Redact embedded URL credentials early so later patterns (like email
    // redaction) don't partially mask/alter the URL.
    output = redactUrlCredentials(output);

    for (const pattern of patterns) {
      const replacementType = typeof pattern?.replacement;
      if (
        !(pattern?.regex instanceof RegExp) ||
        (replacementType !== "string" && replacementType !== "function")
      ) {
        continue;
      }
      output = output.replace(pattern.regex, pattern.replacement);
    }

    // PAN-like numbers can show up in focused fields or titles. Luhn-check to
    // reduce false positives before redacting.
    output = redactLikelyCardNumbers(output);
  } catch {
    return "";
  }

  output = truncateUtf8Safe(output, maxChars);
  return output;
}

module.exports = {
  DEFAULT_REDACTION_PATTERNS,
  sanitizeContextText,
};
