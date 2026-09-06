/** Keep readable, contiguous source spans so highlighting can still find them. */
function isOpaqueToken(raw) {
  const token = raw.replace(/^[`"'([{]+|[`"'),.;\]}]+$/g, "");
  if (/^[a-f\d]{24,}$/i.test(token)) return true;
  if (/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(token)) return true;
  if (/^\d{20,}$/.test(token)) return true;
  if (/^https?:\/\/[^\s]+$/i.test(token) && token.length < 100) return false;
  if (
    token.length >= 40 &&
    /^[A-Za-z\d+/_=-]+$/.test(token) &&
    /[a-z]/.test(token) &&
    /[A-Z]/.test(token) &&
    /\d/.test(token)
  )
    return true;
  const symbols = token.match(/[^\p{L}\p{N}\s]/gu)?.length ?? 0;
  return token.length >= 8 && symbols / token.length >= 0.45;
}

function isCodeLine(line) {
  const text = line.trim();
  return (
    /^(?:const|let|var)\s+[\w$]+\s*=/.test(text) ||
    /^(?:async\s+)?function\s+[\w$]+\s*\(/.test(text) ||
    /^(?:import\s+.+\s+from\s+["']|(?:def|class)\s+\w+.*[:{]\s*$)/.test(text) ||
    /^["'][^"']+["']\s*:\s*(?:["'\d{\[]|true\b|false\b|null\b)/.test(text) ||
    /^[\w$.]+\([^\n]*\);?\s*$/.test(text) ||
    /^[\s{}\[\]();,`~]+$/.test(text)
  );
}

function readableSpans(value) {
  const text = String(value ?? "");
  const excluded = [];
  let fence = null;
  for (const match of text.matchAll(/[^\r\n]+/g)) {
    const line = match[0];
    const marker = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      excluded.push([match.index, match.index + line.length]);
      if (
        marker &&
        marker[1][0] === fence[0] &&
        marker[1].length >= fence.length &&
        !marker[2].trim()
      )
        fence = null;
      continue;
    }
    if (marker) {
      fence = marker[1];
      excluded.push([match.index, match.index + line.length]);
    } else if (isCodeLine(line)) {
      excluded.push([match.index, match.index + line.length]);
    } else {
      for (const token of line.matchAll(/\S+/g)) {
        if (isOpaqueToken(token[0])) {
          const start = match.index + token.index;
          excluded.push([start, start + token[0].length]);
        }
      }
    }
  }
  const spans = [];
  let start = 0;
  for (const [from, to] of [...excluded, [text.length, text.length]]) {
    const span = text.slice(start, from).trim();
    if (/[\p{L}\p{N}]/u.test(span)) spans.push(span);
    start = to;
  }
  return spans;
}

async function splitReadableText(text, split) {
  const sentences = [];
  // Split each retained span separately. Joining across removed code would
  // create a sentence that does not exist anywhere in the source document.
  for (const span of readableSpans(text)) sentences.push(...(await split(span)));
  return sentences;
}

module.exports = { readableSpans, splitReadableText };
