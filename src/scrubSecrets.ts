/**
 * Scrub API keys, tokens, and secrets from strings before display.
 * Prevents accidental leakage via error messages, logs, and stderr.
 */

type ScrubRule = {
  pattern: RegExp;
  replacement: string | ((match: string, ...groups: string[]) => string);
};

const RULES: ScrubRule[] = [
  { pattern: /\bsk-ant-api03-[A-Za-z0-9_-]{20,}\b/g, replacement: '[REDACTED]' },
  { pattern: /\bsk-oauth-[A-Za-z0-9_-]{20,}\b/g, replacement: '[REDACTED]' },
  { pattern: /\bsk-proj-[A-Za-z0-9_-]{20,}\b/g, replacement: '[REDACTED]' },
  { pattern: /\bsk-[A-Za-z0-9]{40,}\b/g, replacement: '[REDACTED]' },
  { pattern: /\bbearer_[A-Za-z0-9_-]{20,}\b/g, replacement: '[REDACTED]' },
  { pattern: /\bAuthorization:\s*Bearer\s+[A-Za-z0-9_.-]{20,}/gi, replacement: 'Authorization: [REDACTED]' },
  { pattern: /"access_token"\s*:\s*"[A-Za-z0-9_.-]{20,}"/gi, replacement: '"access_token":"[REDACTED]"' },
  { pattern: /"refresh_token"\s*:\s*"[A-Za-z0-9_.-]{20,}"/gi, replacement: '"refresh_token":"[REDACTED]"' },
  { pattern: /"api_key"\s*:\s*"[A-Za-z0-9_.-]{20,}"/gi, replacement: '"api_key":"[REDACTED]"' },
];

export function scrubSecrets(input: string): string {
  let result = input;
  for (const rule of RULES) {
    result = result.replace(rule.pattern, rule.replacement as string & ((substring: string, ...args: any[]) => string));
  }
  return result;
}
