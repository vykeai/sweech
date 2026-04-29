import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  execFileSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(),
  readdirSync: vi.fn(),
  statSync: vi.fn(),
  mkdirSync: vi.fn(),
  realpathSync: vi.fn(),
  homedir: vi.fn(),
  userInfo: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFileSync: mocks.execFileSync,
}));

vi.mock('node:fs', () => ({
  readFileSync: mocks.readFileSync,
  writeFileSync: mocks.writeFileSync,
  existsSync: mocks.existsSync,
  readdirSync: mocks.readdirSync,
  statSync: mocks.statSync,
  mkdirSync: mocks.mkdirSync,
  realpathSync: mocks.realpathSync,
}));

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    homedir: mocks.homedir,
    userInfo: mocks.userInfo,
  };
});

type MockFsRecord = Record<string, string>;

const fsDb: MockFsRecord = Object.create(null);

function resetFs() {
  for (const key of Object.keys(fsDb)) {
    delete fsDb[key];
  }
}

function setFile(path: string, content: string) {
  fsDb[path] = content;
}

function getFile(path: string): string {
  if (path in fsDb) return fsDb[path]!;
  throw new Error(`ENOENT: no such file or directory, open '${path}'`);
}

function headers(entries: Record<string, string | undefined>) {
  return {
    get(name: string) {
      return entries[name] ?? null;
    },
  };
}

function fetchResponse(entries: Record<string, string | undefined>) {
  return { headers: headers(entries) };
}

mocks.readFileSync.mockImplementation((path: string) => getFile(path));
mocks.writeFileSync.mockImplementation((path: string, data: string) => {
  setFile(path, data);
  return undefined;
});
mocks.existsSync.mockImplementation((path: string) => path in fsDb);
mocks.readdirSync.mockReturnValue([]);
mocks.statSync.mockReturnValue({ isDirectory: () => true } as unknown);
mocks.mkdirSync.mockReturnValue(undefined);
mocks.realpathSync.mockImplementation((p: string) => p);

vi.stubGlobal('fetch', mocks.fetch);

mocks.homedir.mockReturnValue('/tmp/omnai-home');
mocks.userInfo.mockReturnValue({ username: 'alice' });

const { getLiveUsage } = await import('../usage.js');

const cachePath = '/tmp/omnai-home/.omnai/rate-limit-cache.json';
const originalUserEnv = process.env.USER;

describe('usage token retrieval', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetFs();
    setFile(cachePath, JSON.stringify({}));
    process.env.USER = 'alice';
    mocks.homedir.mockReturnValue('/tmp/omnai-home');
    mocks.userInfo.mockReturnValue({ username: 'alice' });
    mocks.execFileSync.mockReset();
    mocks.fetch.mockReset();
  });

  it('uses safe keychain exec args instead of interpolated shell command text', async () => {
    mocks.execFileSync.mockReturnValue('{"claudeAiOauth":{"accessToken":"token-abc"}}');
    mocks.fetch.mockResolvedValue(fetchResponse({
      'anthropic-ratelimit-unified-5h-utilization': '0.12',
      'anthropic-ratelimit-unified-7d-utilization': '0.4',
      'anthropic-ratelimit-unified-5h-reset': `${Math.floor(Date.now() / 1000) + 200}`,
      'anthropic-ratelimit-unified-7d-reset': `${Math.floor(Date.now() / 1000) + 500}`,
      'anthropic-ratelimit-unified-status': 'allowed',
    }));

    const data = await getLiveUsage('/tmp/omnai-home/.claude');

    expect(mocks.execFileSync).toHaveBeenCalledWith(
      'security',
      [
        'find-generic-password',
        '-a',
        'alice',
        '-s',
        'Claude Code-credentials',
        '-w',
      ],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    expect(data?.utilization5h).toBe(0.12);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it('returns cached data within TTL without extra keychain/API work', async () => {
    mocks.execFileSync.mockReturnValue('{"claudeAiOauth":{"accessToken":"token-abc"}}');
    mocks.fetch.mockResolvedValue(fetchResponse({
      'anthropic-ratelimit-unified-5h-utilization': '0.12',
      'anthropic-ratelimit-unified-7d-utilization': '0.4',
      'anthropic-ratelimit-unified-status': 'allowed',
    }));

    const first = await getLiveUsage('/tmp/omnai-home/.claude');
    expect(mocks.fetch).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    const second = await getLiveUsage('/tmp/omnai-home/.claude');

    expect(second).toEqual(first);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.execFileSync).not.toHaveBeenCalled();
  });

  it('recomputes when cache expires', async () => {
    mocks.execFileSync.mockReturnValue('{"claudeAiOauth":{"accessToken":"token-abc"}}');
    mocks.fetch.mockResolvedValue(fetchResponse({
      'anthropic-ratelimit-unified-5h-utilization': '0.12',
      'anthropic-ratelimit-unified-7d-utilization': '0.4',
      'anthropic-ratelimit-unified-status': 'allowed',
    }));

    await getLiveUsage('/tmp/omnai-home/.claude');
    const current = JSON.parse(getFile(cachePath)) as Record<string, unknown>;
    const key = Object.keys(current)[0];
    const stale = {
      ...(current[key] as Record<string, unknown>),
      capturedAt: Date.now() - 10 * 60 * 1000,
    };
    setFile(cachePath, JSON.stringify({ [key]: stale }));

    await getLiveUsage('/tmp/omnai-home/.claude');

    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(mocks.execFileSync).toHaveBeenCalledTimes(2);
  });

  it('separates cache scope by user so rotated accounts re-fetch', async () => {
    process.env.USER = 'alice';
    mocks.userInfo.mockReturnValue({ username: 'alice' });
    mocks.execFileSync.mockReturnValue('{"claudeAiOauth":{"accessToken":"token-abc"}}');
    mocks.fetch.mockResolvedValue(fetchResponse({
      'anthropic-ratelimit-unified-5h-utilization': '0.12',
      'anthropic-ratelimit-unified-7d-utilization': '0.4',
      'anthropic-ratelimit-unified-status': 'allowed',
    }));

    await getLiveUsage('/tmp/omnai-home/.claude');
    expect(mocks.fetch).toHaveBeenCalledTimes(1);

    process.env.USER = 'bob';
    mocks.userInfo.mockReturnValue({ username: 'bob' });
    vi.clearAllMocks();

    await getLiveUsage('/tmp/omnai-home/.claude');
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it('returns null on non-macOS without attempting keychain reads', async () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux' as never);
    const value = await getLiveUsage('/tmp/omnai-home/.claude');

    expect(value).toBeNull();
    expect(mocks.execFileSync).not.toHaveBeenCalled();
    platformSpy.mockRestore();
  });

  it('rejects symlinked configDir that escapes HOME via realpathSync', async () => {
    // Simulate: /tmp/omnai-home/.claude-evil is a symlink -> /etc
    mocks.realpathSync.mockImplementation((p: string) => {
      if (p === '/tmp/omnai-home/.claude-evil') return '/etc';
      return p;
    });

    await expect(getLiveUsage('/tmp/omnai-home/.claude-evil')).rejects.toThrow(
      'configDir escapes home',
    );
  });

  afterAll(() => {
    if (originalUserEnv === undefined) {
      delete process.env.USER;
      return;
    }
    process.env.USER = originalUserEnv;
  });
});
