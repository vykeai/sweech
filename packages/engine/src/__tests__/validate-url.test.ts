import { describe, it, expect } from 'vitest';
import { validateBaseUrl } from '../runner/validate-url.js';

describe('validateBaseUrl', () => {
  it('accepts https URLs', () => {
    expect(validateBaseUrl('https://api.example.com/v1/chat')).toBe('https://api.example.com/v1/chat');
  });

  it('accepts http URLs', () => {
    expect(validateBaseUrl('http://localhost:11434/v1')).toBe('http://localhost:11434/v1');
  });

  it('accepts localhost', () => {
    expect(validateBaseUrl('http://localhost:3000/api')).toBe('http://localhost:3000/api');
  });

  it('accepts 127.0.0.1', () => {
    expect(validateBaseUrl('http://127.0.0.1:8080/v1')).toBe('http://127.0.0.1:8080/v1');
  });

  it('accepts LAN IPs', () => {
    expect(validateBaseUrl('http://192.168.1.100:11434/v1')).toBe('http://192.168.1.100:11434/v1');
  });

  it('rejects file:// protocol', () => {
    expect(() => validateBaseUrl('file:///etc/passwd')).toThrow('only http: and https: protocols are allowed');
  });

  it('rejects ftp:// protocol', () => {
    expect(() => validateBaseUrl('ftp://evil.com/payload')).toThrow('only http: and https: protocols are allowed');
  });

  it('rejects data: protocol', () => {
    expect(() => validateBaseUrl('data:text/html,<script>alert(1)</script>')).toThrow('only http: and https: protocols are allowed');
  });

  it('rejects javascript: protocol', () => {
    expect(() => validateBaseUrl('javascript:alert(1)')).toThrow('only http: and https: protocols are allowed');
  });

  it('rejects completely invalid URL', () => {
    expect(() => validateBaseUrl('not-a-url')).toThrow('not a valid URL');
  });

  it('rejects empty string', () => {
    expect(() => validateBaseUrl('')).toThrow('not a valid URL');
  });

  it('rejects scheme-only URL (https://)', () => {
    expect(() => validateBaseUrl('https://')).toThrow('not a valid URL');
  });
});
