/**
 * Shared header validation for HTTP runners.
 * Prevents CRLF injection and header smuggling via user-controlled custom headers.
 *
 * Rules:
 *  - Rejects \r and \n in header names and values (CRLF injection)
 *  - Rejects null bytes in header names and values
 *  - Rejects empty header names
 *  - Rejects non-string keys or values
 *  - Returns the validated headers object
 *  - Throws Error on any violation
 */

export function validateHeaders(headers: Record<string, string>): Record<string, string> {
  const validated: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof key !== 'string' || typeof value !== 'string') {
      throw new Error(`Invalid header: key and value must be strings`);
    }
    // Reject CRLF injection
    if (/[\r\n]/.test(key) || /[\r\n]/.test(value)) {
      throw new Error(`Invalid header "${key}": contains newline characters`);
    }
    // Reject null bytes
    if (key.includes('\0') || value.includes('\0')) {
      throw new Error(`Invalid header "${key}": contains null bytes`);
    }
    // Reject empty header names
    if (!key.trim()) {
      throw new Error('Header name cannot be empty');
    }
    validated[key] = value;
  }
  return validated;
}
