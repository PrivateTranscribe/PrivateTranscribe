// PowerShell ends a single-quoted literal at ' and also at U+2018, U+2019, U+201A
// and U+201B. Doubling each one keeps it literal, the same rule as PowerShell's
// own CodeGeneration.EscapeSingleQuotedStringContent.
const SINGLE_QUOTES = /['\u2018\u2019\u201A\u201B]/g;

function psQuote(value) {
  return `'${String(value).replace(SINGLE_QUOTES, (quote) => quote + quote)}'`;
}

// Windows PowerShell 5.1 reads a .ps1 without a byte order mark in the ANSI code
// page, where the UTF-8 bytes of a character such as "Ò" decode to a curly quote
// and end a literal early. With the mark it reads the file as UTF-8.
function withUtf8Bom(script) {
  return `\uFEFF${script}`;
}

module.exports = { psQuote, withUtf8Bom };
