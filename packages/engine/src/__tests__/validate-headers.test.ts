import { describe, it, expect } from 'vitest';
import { validateHeaders } from '../runner/validate-headers.js';

describe('validateHeaders', () => {
  it('passes valid headers through unchanged', () => {
    const input = { 'X-Custom': 'value', 'Accept': 'application/json' };
    expect(validateHeaders(input)).toEqual(input);
  });

  it('rejects header with \\r\\n in value', () => {
    expect(() => validateHeaders({ 'X-Custom': 'value\r\nevil-header: injected' }))
      .toThrow('contains newline characters');
  });

  it('rejects header with \\r in value', () => {
    expect(() => validateHeaders({ 'X-Custom': 'value\revil' }))
      .toThrow('contains newline characters');
  });

  it('rejects header with \\n in value', () => {
    expect(() => validateHeaders({ 'X-Custom': 'value\nevil-header: injected' }))
      .toThrow('contains newline characters');
  });

  it('rejects header with null byte in value', () => {
    expect(() => validateHeaders({ 'X-Custom': 'value\0evil' }))
      .toThrow('contains null bytes');
  });

  it('rejects header with \\r\\n in name', () => {
    expect(() => validateHeaders({ 'X-Custom\r\nevil': 'value' }))
      .toThrow('contains newline characters');
  });

  it('rejects empty header name', () => {
    expect(() => validateHeaders({ '': 'value' }))
      .toThrow('Header name cannot be empty');
  });

  it('rejects whitespace-only header name', () => {
    expect(() => validateHeaders({ '   ': 'value' }))
      .toThrow('Header name cannot be empty');
  });

  it('returns empty object for empty input', () => {
    expect(validateHeaders({})).toEqual({});
  });

  it('allows valid special characters in values (bearer tokens)', () => {
    const input = { 'Authorization': 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc-123_XYZ~' };
    expect(validateHeaders(input)).toEqual(input);
  });

  it('rejects header with null byte in name', () => {
    expect(() => validateHeaders({ 'X-Custom\0Evil': 'value' }))
      .toThrow('contains null bytes');
  });

  it('rejects header with \\n in name', () => {
    expect(() => validateHeaders({ 'X-Custom\nevil': 'value' }))
      .toThrow('contains newline characters');
  });

  it('rejects header with \\r in name', () => {
    expect(() => validateHeaders({ 'X-Custom\revil': 'value' }))
      .toThrow('contains newline characters');
  });
});
