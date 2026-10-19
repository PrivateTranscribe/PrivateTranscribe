// The renderer makes these requests, and its content security policy in
// index.html lets plain http reach only these hosts. https reaches any host.
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The eight 16-bit groups of an IPv6 literal as the URL parser writes it, such as "[fe80::1]". */
function ipv6Groups(hostname: string): number[] | null {
  if (!hostname.startsWith("[") || !hostname.endsWith("]")) return null;
  const [head, tail] = hostname.slice(1, -1).split("::");
  const parse = (text?: string) => (text ? text.split(":").map((g) => parseInt(g, 16)) : []);
  const front = parse(head);
  const back = parse(tail);
  const groups =
    tail === undefined
      ? front
      : [...front, ...Array(8 - front.length - back.length).fill(0), ...back];
  return groups.length === 8 && groups.every(Number.isInteger) ? groups : null;
}

/**
 * The IPv4 address an IPv6 literal stands for, so [::] and [::ffff:169.254.169.254]
 * meet the same checks as 0.0.0.0 and 169.254.169.254. Other hosts pass through.
 */
function comparableHost(hostname: string, groups: number[] | null): string {
  if (!groups || !groups.slice(0, 5).every((g) => g === 0)) return hostname;
  if (groups.every((g) => g === 0)) return "0.0.0.0";
  const mapped = groups[5] === 0xffff;
  const compatible = groups[5] === 0 && (groups[6] !== 0 || groups[7] > 1);
  if (!mapped && !compatible) return hostname;
  return [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join(".");
}

/**
 * Decides whether a custom API base URL can be saved and used. The rules match
 * what the renderer can reach, so an address that saves is one that works:
 * plain http for a server on this PC, such as Ollama, https for anything else.
 */
export function isValidApiUrl(url: string): { valid: boolean; reason?: string } {
  if (!url || url.trim() === "") {
    return { valid: true }; // empty is fine (means use default)
  }

  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return { valid: false, reason: "Enter a full address, such as http://localhost:11434/v1." };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { valid: false, reason: "Only http:// and https:// addresses work." };
  }

  const hostname = parsed.hostname.toLowerCase();
  const groups = ipv6Groups(hostname);
  const comparable = comparableHost(hostname, groups);

  if (comparable === "0.0.0.0") {
    return {
      valid: false,
      reason: "That is where a server listens, not where to reach it. Use localhost or 127.0.0.1.",
    };
  }

  // Link-local holds the cloud metadata service (169.254.169.254) and no AI server.
  // IPv6 has its own link-local range, fe80::/10.
  if (/^169\.254\./.test(comparable) || (groups !== null && (groups[0] & 0xffc0) === 0xfe80)) {
    return { valid: false, reason: "Link-local addresses are not allowed." };
  }

  if (LOOPBACK_HOSTS.has(hostname)) {
    return { valid: true };
  }

  if (parsed.protocol === "http:") {
    return {
      valid: false,
      reason:
        "Use https:// for this address. Plain http:// only reaches a server on this PC, such as http://localhost:11434/v1.",
    };
  }

  // A name without a domain, such as "myserver", has no certificate to match.
  const isIpv6Literal = hostname.startsWith("[");
  if (!isIpv6Literal && (!hostname.includes(".") || hostname.endsWith("."))) {
    return { valid: false, reason: "The address needs a full domain name." };
  }

  return { valid: true };
}
