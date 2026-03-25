/**
 * Tests for OAuth callback server (src/oauthServer.ts)
 */

import * as http from 'node:http';
import { getCallbackUrl, openBrowserForAuth, waitForOAuthCallback } from '../src/oauthServer';

// ---------------------------------------------------------------------------
// getCallbackUrl
// ---------------------------------------------------------------------------

describe('getCallbackUrl', () => {
  it('should return localhost URL with correct port and path', () => {
    const url = getCallbackUrl();
    expect(url).toBe('http://localhost:19284/callback');
  });

  it('should return a valid URL', () => {
    const url = getCallbackUrl();
    const parsed = new URL(url);
    expect(parsed.hostname).toBe('localhost');
    expect(parsed.port).toBe('19284');
    expect(parsed.pathname).toBe('/callback');
    expect(parsed.protocol).toBe('http:');
  });
});

// ---------------------------------------------------------------------------
// openBrowserForAuth
// ---------------------------------------------------------------------------

describe('openBrowserForAuth', () => {
  let execMock: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    execMock = jest.spyOn(require('node:child_process'), 'exec').mockImplementation(
      ((...args: any[]) => { const cb = args[args.length - 1]; if (typeof cb === 'function') cb(null); }) as any
    );
  });

  afterEach(() => {
    execMock.mockRestore();
  });

  it('should call exec with the URL', () => {
    openBrowserForAuth('https://example.com/auth');

    expect(execMock).toHaveBeenCalledTimes(1);
    const cmd = execMock.mock.calls[0][0] as string;
    expect(cmd).toContain('https://example.com/auth');
  });

  it('should use open command on macOS', () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin' });

    openBrowserForAuth('https://example.com/auth');

    const cmd = execMock.mock.calls[0][0] as string;
    expect(cmd).toMatch(/^open /);

    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('should use xdg-open command on Linux', () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux' });

    openBrowserForAuth('https://example.com/auth');

    const cmd = execMock.mock.calls[0][0] as string;
    expect(cmd).toMatch(/^xdg-open /);

    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('should log to stderr when exec fails', () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    execMock.mockImplementation(
      ((...args: any[]) => { const cb = args[args.length - 1]; if (typeof cb === 'function') cb(new Error('command not found')); }) as any
    );

    openBrowserForAuth('https://example.com/auth');

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Could not open browser')
    );
    errorSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// waitForOAuthCallback
//
// These tests use a real HTTP server on port 19284. Because the server binds
// to a fixed port, tests must run sequentially and fully tear down between
// runs. We use a helper that waits for the port to be free before starting
// the next test.
// ---------------------------------------------------------------------------

describe('waitForOAuthCallback', () => {
  const STATE = 'test-state-abc123';

  /**
   * Helper: make an HTTP GET request to the local OAuth callback server.
   */
  function makeCallbackRequest(
    params: Record<string, string>,
    path = '/callback'
  ): Promise<{ statusCode: number; body: string; headers: http.IncomingHttpHeaders }> {
    return new Promise((resolve, reject) => {
      const query = new URLSearchParams(params).toString();
      const reqUrl = `http://127.0.0.1:19284${path}?${query}`;
      http.get(reqUrl, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve({ statusCode: res.statusCode || 0, body: data, headers: res.headers }));
      }).on('error', reject);
    });
  }

  /**
   * Helper: wait until port 19284 is free.
   */
  async function waitForPortFree(maxWait = 5000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < maxWait) {
      const inUse = await new Promise<boolean>((resolve) => {
        const tester = http.get('http://127.0.0.1:19284/', () => resolve(true));
        tester.on('error', () => resolve(false));
        tester.setTimeout(200, () => { tester.destroy(); resolve(false); });
      });
      if (!inUse) return;
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /**
   * Helper: wait for the server to start listening.
   */
  async function waitForServerReady(maxWait = 3000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < maxWait) {
      const ready = await new Promise<boolean>((resolve) => {
        const tester = http.get('http://127.0.0.1:19284/', (res) => {
          let d = '';
          res.on('data', (c) => (d += c));
          res.on('end', () => resolve(true));
        });
        tester.on('error', () => resolve(false));
        tester.setTimeout(200, () => { tester.destroy(); resolve(false); });
      });
      if (ready) return;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  // Ensure port is free before each test
  beforeEach(async () => {
    await waitForPortFree();
  }, 10000);

  it('should resolve with code on valid callback', async () => {
    const promise = waitForOAuthCallback(STATE, 10000);
    await waitForServerReady();

    const res = await makeCallbackRequest({ code: 'auth-code-xyz', state: STATE });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Authentication successful');

    const result = await promise;
    expect(result).toEqual({ code: 'auth-code-xyz' });
  }, 15000);

  it('should reject on state mismatch (CSRF protection)', async () => {
    const promise = waitForOAuthCallback(STATE, 10000);
    await waitForServerReady();

    const res = await makeCallbackRequest({ code: 'auth-code', state: 'wrong-state' });
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain('State mismatch');

    // Send a valid request so the server shuts down cleanly
    const res2 = await makeCallbackRequest({ code: 'valid-code', state: STATE });
    expect(res2.statusCode).toBe(200);
    await promise;
  }, 15000);

  it('should return 400 when code or state is missing', async () => {
    const promise = waitForOAuthCallback(STATE, 10000);
    await waitForServerReady();

    // Missing state
    const res1 = await makeCallbackRequest({ code: 'auth-code' });
    expect(res1.statusCode).toBe(400);
    expect(res1.body).toContain('Missing required parameters');

    // Missing code
    const res2 = await makeCallbackRequest({ state: STATE });
    expect(res2.statusCode).toBe(400);
    expect(res2.body).toContain('Missing required parameters');

    // Clean up
    await makeCallbackRequest({ code: 'cleanup', state: STATE });
    await promise;
  }, 15000);

  it('should return 404 for non-callback paths', async () => {
    const promise = waitForOAuthCallback(STATE, 10000);
    await waitForServerReady();

    const res = await makeCallbackRequest({ code: 'x', state: STATE }, '/other');
    expect(res.statusCode).toBe(404);

    // Clean up
    await makeCallbackRequest({ code: 'cleanup', state: STATE });
    await promise;
  }, 15000);

  it('should handle provider error parameter and reject', async () => {
    const promise = waitForOAuthCallback(STATE, 10000);
    // Attach rejection handler early to avoid unhandled rejection
    const catchPromise = promise.catch((err) => err);
    await waitForServerReady();

    const res = await makeCallbackRequest({
      error: 'access_denied',
      error_description: 'User denied access'
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('User denied access');

    const err = await catchPromise;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('OAuth error from provider: User denied access');
  }, 15000);

  it('should handle provider error without description', async () => {
    const promise = waitForOAuthCallback(STATE, 10000);
    const catchPromise = promise.catch((err) => err);
    await waitForServerReady();

    const res = await makeCallbackRequest({
      error: 'server_error'
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('server_error');

    const err = await catchPromise;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('OAuth error from provider: server_error');
  }, 15000);

  it('should timeout when no callback is received', async () => {
    const promise = waitForOAuthCallback(STATE, 300);

    await expect(promise).rejects.toThrow(/OAuth callback timed out/);
  }, 10000);

  it('should include timeout duration in error message', async () => {
    const promise = waitForOAuthCallback(STATE, 500);

    try {
      await promise;
      fail('Expected promise to reject');
    } catch (err: any) {
      expect(err.message).toMatch(/timed out after \d+s/);
      expect(err.message).toContain('No authorization code received');
    }
  }, 10000);

  it('should serve HTML with no-store cache header on success', async () => {
    const promise = waitForOAuthCallback(STATE, 10000);
    await waitForServerReady();

    const res = await makeCallbackRequest({ code: 'test-code', state: STATE });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.headers['cache-control']).toBe('no-store');

    await promise;
  }, 15000);

  it('should handle both missing code and state as 400', async () => {
    const promise = waitForOAuthCallback(STATE, 10000);
    await waitForServerReady();

    // Send callback with neither code nor state
    const res = await makeCallbackRequest({});
    expect(res.statusCode).toBe(400);

    // Clean up
    await makeCallbackRequest({ code: 'cleanup', state: STATE });
    await promise;
  }, 15000);
});
