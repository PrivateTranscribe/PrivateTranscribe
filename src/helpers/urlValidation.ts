// The renderer makes these requests, and its content security policy in
// index.html lets plain http reach only these hosts. https reaches any host.
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

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

  if (hostname === "0.0.0.0") {
    return {
      valid: false,
      reason: "0.0.0.0 is where a server listens. Use localhost or 127.0.0.1 to reach it.",
    };
  }

  // Link-local holds the cloud metadata service (169.254.169.254) and no AI server.
  if (/^169\.254\./.test(hostname)) {
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
