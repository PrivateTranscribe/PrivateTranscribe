/**
 * Pull complete sentences out of a growing stream of text deltas, so TTS can
 * start on the FIRST finished sentence instead of waiting for the whole answer.
 *
 * Ported from the validated voice-loop spike's lib/sentences.cjs. Read Aloud
 * splits a finished document with kokoro-js's
 * own splitter; that splitter needs the whole text up front, which is exactly
 * what a streaming reply does not have. This one is incremental and never waits
 * for the tail.
 */

/**
 * The voice system prompt asks for plain speech, but a model still slips in the
 * odd asterisk or backtick. Strip the ones TTS would read out loud.
 */
function despeak(s) {
  return s
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*?([^*]*)\*\*?/g, "$1")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

const BOUNDARY = /([.!?…]["')\]]?)(\s)|(\n+)/;

function joinSpoken(a, b) {
  return a && b ? `${a} ${b}` : a || b;
}

class SentenceStream {
  constructor() {
    this.buf = "";
    /** A fragment too short to speak alone, waiting to open the next sentence. */
    this.carry = "";
  }

  /** Feed a delta. Returns an array of complete sentences (possibly empty). */
  push(text) {
    this.buf += text;
    const out = [];
    // Every pass cuts at least one character off buf, so the loop ends on its
    // own. The cap is a backstop: this runs in the main process, where a loop
    // that stops making progress freezes the whole app.
    let passes = this.buf.length;
    for (;;) {
      const m = BOUNDARY.exec(this.buf);
      if (!m) break;
      if (passes-- <= 0) {
        // The rest stays in buf for the next push or flush().
        console.warn("[converse-sentences] no progress; leaving the rest for flush");
        break;
      }
      const end = m.index + (m[3] ? m[3].length : m[1].length + m[2].length);
      const raw = this.buf.slice(0, end);
      this.buf = this.buf.slice(end);
      const clean = joinSpoken(this.carry, despeak(raw));
      // A one-or-two character fragment ("1.", "A.") is not worth its own
      // synthesis call; it opens the next sentence. It is held in carry, not put
      // back in buf: there the same boundary matched it again, forever.
      if (clean.length < 3) {
        this.carry = clean;
        continue;
      }
      this.carry = "";
      out.push(clean);
    }
    return out;
  }

  /** Anything left over at the end of the stream. */
  flush() {
    const clean = joinSpoken(this.carry, despeak(this.buf));
    this.buf = "";
    this.carry = "";
    return clean.length >= 2 ? [clean] : [];
  }
}

module.exports = { SentenceStream, despeak };
