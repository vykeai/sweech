import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

vi.mock('node:os', () => ({
  homedir: () => '/home/test',
}));

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockRejectedValue({ code: 'ENOENT' }),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
}));

import { getKey, setKey, deleteKey, listKeys, keyExists } from '../keychain.js';

describe('keychain', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('getKey returns key from security CLI', () => {
    (execFileSync as ReturnType<typeof vi.fn>).mockReturnValue('sk-test-key-123\n');
    expect(getKey('test-profile')).toBe('sk-test-key-123');
    expect(execFileSync).toHaveBeenCalledWith(
      'security',
      ['find-generic-password', '-a', 'test-profile', '-s', 'omnai', '-w'],
      expect.any(Object),
    );
  });

  it('getKey returns null when key not found', () => {
    (execFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('not found');
    });
    expect(getKey('nonexistent')).toBeNull();
  });

  it('setKey deletes then adds', () => {
    (execFileSync as ReturnType<typeof vi.fn>).mockReturnValue('');
    setKey('test-profile', 'sk-new-key');
    const calls = (execFileSync as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0]).toBe('security');
    expect(calls[0][1][0]).toBe('delete-generic-password');
    expect(calls[1][0]).toBe('security');
    expect(calls[1][1][0]).toBe('add-generic-password');
    expect(calls[1][1]).toContain('sk-new-key');
  });

  it('deleteKey returns true on success', () => {
    (execFileSync as ReturnType<typeof vi.fn>).mockReturnValue('');
    expect(deleteKey('test-profile')).toBe(true);
  });

  it('deleteKey returns false when not found', () => {
    (execFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('not found');
    });
    expect(deleteKey('test-profile')).toBe(false);
  });

  it('keyExists returns true when key present', () => {
    (execFileSync as ReturnType<typeof vi.fn>).mockReturnValue('sk-test\n');
    expect(keyExists('test-profile')).toBe(true);
  });

  it('keyExists returns false when key absent', () => {
    (execFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('not found');
    });
    expect(keyExists('test-profile')).toBe(false);
  });

  it('listKeys parses keychain dump', () => {
    const dump = [
      'keychain: "/Users/test/Library/Keychains/login.keychain-db"',
      'class: "genp"',
      'attributes:',
      '    "acct"<blob>="my-profile"',
      '    "svce"<blob>="omnai"',
      'class: "genp"',
      'attributes:',
      '    "acct"<blob>="other-service"',
      '    "svce"<blob>="not-omnai"',
      'class: "genp"',
      'attributes:',
      '    "acct"<blob>="work-claude"',
      '    "svce"<blob>="omnai"',
    ].join('\n');
    (execFileSync as ReturnType<typeof vi.fn>).mockReturnValue(dump);
    const keys = listKeys();
    expect(keys).toEqual(['my-profile', 'work-claude']);
  });
});
