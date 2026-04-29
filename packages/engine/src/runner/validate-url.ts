/**
 * Shared URL validation for HTTP runners.
 * Prevents SSRF by rejecting non-HTTP protocols and malformed URLs.
 *
 * Rules:
 *  - Only http: and https: schemes are allowed
 *  - URL must have a non-empty hostname after parsing
 *  - localhost / 127.0.0.1 / LAN IPs are permitted (local LLMs like ollama)
 *  - Returns the validated URL string
 *  - Throws Error on any violation
 */

export function validateBaseUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid baseUrl: "${url}" is not a valid URL`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `Invalid baseUrl: "${url}" — only http: and https: protocols are allowed, got ${parsed.protocol}`,
    );
  }

  if (!parsed.hostname) {
    throw new Error(`Invalid baseUrl: "${url}" — URL has no hostname`);
  }

  return url;
}
