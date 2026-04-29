import { describe, it, expect, vi, beforeEach } from 'vitest';

// globalThis.fetch mock — same pattern as server.test.ts
globalThis.fetch = vi.fn() as typeof fetch;

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}));

import * as fsPromises from 'node:fs/promises';
import { isDaemonHealthy } from '../../cli/daemon.js';

const mockReadFile = vi.mocked(fsPromises.readFile);
const mockFetch = globalThis.fetch as ReturnType<typeof vi.fn>;

describe('isDaemonHealthy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns false when PID file is missing', async () => {
    mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    expect(await isDaemonHealthy()).toBe(false);
  });

  it('returns false when /healthz responds ok=false', async () => {
    mockReadFile.mockResolvedValue(String(process.pid) as unknown as Buffer);
    mockFetch.mockResolvedValue({ json: async () => ({ ok: false, state: 'booting' }) });
    expect(await isDaemonHealthy()).toBe(false);
  });

  it('returns true when process alive and /healthz ok', async () => {
    mockReadFile.mockResolvedValue(String(process.pid) as unknown as Buffer);
    mockFetch.mockResolvedValue({ json: async () => ({ ok: true, state: 'ready' }) });
    expect(await isDaemonHealthy()).toBe(true);
  });

  it('returns false when /healthz request throws', async () => {
    mockReadFile.mockResolvedValue(String(process.pid) as unknown as Buffer);
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
    expect(await isDaemonHealthy()).toBe(false);
  });

  it('returns false when PID is non-existent process', async () => {
    // PID 999999999 won't be alive
    mockReadFile.mockResolvedValue('999999999' as unknown as Buffer);
    expect(await isDaemonHealthy()).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
