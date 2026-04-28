/**
 * Tests for scrubSecrets — API key/token scrubbing for error output
 */

import { scrubSecrets } from '../src/scrubSecrets';

describe('scrubSecrets', () => {
  it('scrubs Anthropic API keys', () => {
    const msg = 'Failed with key sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890';
    expect(scrubSecrets(msg)).toBe('Failed with key [REDACTED]');
  });

  it('scrubs OpenAI OAuth tokens', () => {
    const msg = 'Token: sk-oauth-abcdef1234567890abcdef1234567890';
    expect(scrubSecrets(msg)).toBe('Token: [REDACTED]');
  });

  it('scrubs OpenAI project keys', () => {
    const msg = 'Key sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDEFGH';
    expect(scrubSecrets(msg)).toBe('Key [REDACTED]');
  });

  it('scrubs generic long OpenAI keys', () => {
    const msg = 'key=sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890abcdefghij';
    expect(scrubSecrets(msg)).toBe('key=[REDACTED]');
  });

  it('scrubs bearer_ prefixed tokens', () => {
    const msg = 'Authorization: bearer_eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9';
    expect(scrubSecrets(msg)).toBe('Authorization: [REDACTED]');
  });

  it('scrubs Authorization Bearer headers', () => {
    const msg = 'Authorization: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9abcdef';
    expect(scrubSecrets(msg)).toBe('Authorization: [REDACTED]');
  });

  it('scrubs access_token values in JSON', () => {
    const msg = 'Token exchange failed: {"access_token":"eyJhbGciOiJSUzI1NiJ9abcdef1234567890"}';
    expect(scrubSecrets(msg)).toBe('Token exchange failed: {"access_token":"[REDACTED]"}');
  });

  it('scrubs refresh_token values in JSON', () => {
    const msg = 'Response: {"refresh_token":"rt_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890"}';
    expect(scrubSecrets(msg)).toBe('Response: {"refresh_token":"[REDACTED]"}');
  });

  it('scrubs api_key values in JSON', () => {
    const msg = 'Config: {"api_key":"sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890"}';
    expect(scrubSecrets(msg)).toBe('Config: {"api_key":"[REDACTED]"}');
  });

  it('leaves short strings intact', () => {
    const msg = 'Error: connection refused';
    expect(scrubSecrets(msg)).toBe('Error: connection refused');
  });

  it('leaves provider names intact', () => {
    const msg = 'Failed to connect to Anthropic API';
    expect(scrubSecrets(msg)).toBe('Failed to connect to Anthropic API');
  });

  it('preserves useful error context while scrubbing secrets', () => {
    const msg = 'API error 401: invalid api_key sk-ant-api03-BADKEY123456789012345678901234 for provider anthropic';
    const scrubbed = scrubSecrets(msg);
    expect(scrubbed).toContain('401');
    expect(scrubbed).toContain('anthropic');
    expect(scrubbed).toContain('[REDACTED]');
    expect(scrubbed).not.toContain('sk-ant-api03-BADKEY');
  });

  it('handles multiple secrets in one string', () => {
    const msg = 'key1=sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890 key2=bearer_eyJhbGciOiJSUzI1NiJ9token1234567890abc';
    const scrubbed = scrubSecrets(msg);
    expect(scrubbed).not.toContain('sk-ant-api03');
    expect(scrubbed).not.toContain('bearer_');
    expect((scrubbed.match(/\[REDACTED\]/g) || []).length).toBeGreaterThanOrEqual(2);
  });

  it('handles empty string', () => {
    expect(scrubSecrets('')).toBe('');
  });
});
