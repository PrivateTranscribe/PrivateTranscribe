/**
 * Validates that a URL is safe to use as an API base URL.
 * Blocks private/internal network addresses to prevent SSRF.
 */
export function isValidApiUrl(url: string): { valid: boolean; reason?: string } {
  if (!url || url.trim() === "") {
    return { valid: true }; // empty is fine (means use default)
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { valid: false, reason: "Invalid URL format" };
  }

  // Must be http or https
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { valid: false, reason: "Only http:// and https:// URLs are allowed" };
  }

  const hostname = parsed.hostname.toLowerCase();

  // Block localhost variations
  if (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "0.0.0.0"
  ) {
    return { valid: false, reason: "Localhost URLs are not allowed" };
  }

  // Block private IP ranges (10.x, 172.16-31.x, 192.168.x)
  if (/^10\./.test(hostname) || /^192\.168\./.test(hostname)) {
    return { valid: false, reason: "Private network URLs are not allowed" };
  }
  if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(hostname)) {
    return { valid: false, reason: "Private network URLs are not allowed" };
  }

  // Block link-local
  if (/^169\.254\./.test(hostname)) {
    return { valid: false, reason: "Link-local URLs are not allowed" };
  }

  // Block .local, .internal, .localhost TLDs
  if (/\.(local|internal|localhost)$/i.test(hostname)) {
    return { valid: false, reason: "Internal network URLs are not allowed" };
  }

  // Block hostnames without a TLD (e.g., "myserver")
  if (!hostname.includes(".") || hostname.endsWith(".")) {
    return { valid: false, reason: "URL must have a valid domain name" };
  }

  return { valid: true };
}
