/**
 * T-053: doctor per-check timeouts + daemon /healthz probe.
 *
 * These tests exercise the small pure helpers extracted out of runDoctor()
 * so the timeout / exit-code logic is verifiable in isolation. Hitting the
 * real `runDoctor()` would touch the keychain, the filesystem, and the
 * network — so we test the seams instead.
 */

// Mock inquirer to avoid ES-module loading issues under ts-jest (matches the
// same trick used by tests/utilityCommands.test.ts).
jest.mock('inquirer', () => ({}));

import {
  worstSeverity,
  withTimeout,
  probeDaemonHealthz,
  DOCTOR_CHECK_TIMEOUT_MS,
  type CheckSeverity,
} from '../src/utilityCommands';

describe('T-053 doctor timeouts and /healthz probe', () => {
  describe('worstSeverity (exit code derivation)', () => {
    test('empty array → 0', () => {
      expect(worstSeverity([])).toBe(0);
    });

    test('all ok → 0', () => {
      expect(worstSeverity(['ok', 'ok', 'ok'])).toBe(0);
    });

    test('any warn (no error) → 1', () => {
      expect(worstSeverity(['ok', 'warn', 'ok'])).toBe(1);
      expect(worstSeverity(['warn'])).toBe(1);
    });

    test('any error → 2', () => {
      expect(worstSeverity(['ok', 'error'])).toBe(2);
      expect(worstSeverity(['warn', 'error'])).toBe(2);
      expect(worstSeverity(['error', 'ok', 'warn'])).toBe(2);
    });

    test('error dominates warn (acceptance criterion #3)', () => {
      const mix: CheckSeverity[] = ['ok', 'warn', 'warn', 'error', 'ok'];
      expect(worstSeverity(mix)).toBe(2);
    });
  });

  describe('withTimeout', () => {
    test('resolves when the inner promise resolves before the deadline', async () => {
      const result = await withTimeout(Promise.resolve('hello'), 1_000, 'test');
      expect(result).toBe('hello');
    });

    test('rejects with code=TIMEOUT when the inner promise stalls past the deadline', async () => {
      const stalled = new Promise(() => {
        /* never resolves */
      });
      let err: (Error & { code?: string }) | undefined;
      try {
        await withTimeout(stalled, 25, 'stalled-op');
      } catch (e) {
        err = e as Error & { code?: string };
      }
      expect(err).toBeDefined();
      expect(err!.code).toBe('TIMEOUT');
      // Acceptance criterion #1: surfaced as "timeout", not "hung".
      expect(err!.message).toMatch(/timed out/);
      expect(err!.message).toMatch(/stalled-op/);
    });

    test('forwards the inner promise rejection unchanged', async () => {
      const rejected = Promise.reject(new Error('boom'));
      await expect(withTimeout(rejected, 1_000, 'test')).rejects.toThrow('boom');
    });

    test('clears the timer after resolution so the event loop does not leak', async () => {
      // If the timer were not cleared this test would still pass, but jest's
      // detectOpenHandles in CI catches the leak. The behavioural check here
      // is that resolution happens promptly without hitting the deadline.
      const start = Date.now();
      const result = await withTimeout(Promise.resolve(42), 5_000, 'fast');
      expect(result).toBe(42);
      expect(Date.now() - start).toBeLessThan(500);
    });
  });

  describe('probeDaemonHealthz', () => {
    test('returns ok when /healthz responds 200 with body.ok=true', async () => {
      const fakeFetch = jest.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: true, version: '1.2.3', uptime: 42, state: 'ready' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

      const probe = await probeDaemonHealthz({
        port: 7801,
        timeoutMs: 1_000,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        fetchImpl: fakeFetch as any,
      });

      expect(probe.status).toBe('ok');
      expect(probe.version).toBe('1.2.3');
      expect(probe.state).toBe('ready');
      expect(fakeFetch).toHaveBeenCalledWith(
        'http://127.0.0.1:7801/healthz',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    test('reports "unreachable" when fetch throws ECONNREFUSED', async () => {
      const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:7801'), {
        code: 'ECONNREFUSED',
      });
      const fakeFetch = jest.fn().mockRejectedValue(refused);

      const probe = await probeDaemonHealthz({
        port: 7801,
        timeoutMs: 1_000,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        fetchImpl: fakeFetch as any,
      });

      expect(probe.status).toBe('unreachable');
      expect(probe.message).toMatch(/not running/);
    });

    test('unwraps an AbortError nested on .cause and labels it as "timeout"', async () => {
      const abortCause = new Error('aborted');
      abortCause.name = 'AbortError';
      const wrapped = Object.assign(new TypeError('fetch failed'), { cause: abortCause });
      const fakeFetch = jest.fn().mockRejectedValue(wrapped);

      const probe = await probeDaemonHealthz({
        port: 7801,
        timeoutMs: 1_000,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        fetchImpl: fakeFetch as any,
      });

      expect(probe.status).toBe('timeout');
    });

    test('unwraps Node fetch TypeError to find ECONNREFUSED on .cause.code', async () => {
      // Node's fetch wraps connection errors in a generic TypeError whose
      // `cause` carries the real ECONNREFUSED — without unwrapping we'd
      // mislabel a closed-port daemon as a generic error. Regression guard.
      const wrapped = Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('connect ECONNREFUSED'), {
          code: 'ECONNREFUSED',
        }),
      });
      const fakeFetch = jest.fn().mockRejectedValue(wrapped);

      const probe = await probeDaemonHealthz({
        port: 7801,
        timeoutMs: 1_000,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        fetchImpl: fakeFetch as any,
      });

      expect(probe.status).toBe('unreachable');
    });

    test('reports "timeout" (not "hung") when the request exceeds the deadline (acceptance criterion #1)', async () => {
      // Simulate a fetch that respects AbortSignal: rejects with an AbortError
      // whose name === 'AbortError' when the signal fires. This mirrors how
      // Node's fetch behaves in production.
      const slowFetch = jest.fn((_url: string, init?: { signal?: AbortSignal }) => {
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) return; // would hang forever — but we always pass a signal
          signal.addEventListener('abort', () => {
            const abortErr = new Error('The operation was aborted');
            abortErr.name = 'AbortError';
            reject(abortErr);
          });
        });
      });

      const probe = await probeDaemonHealthz({
        port: 7801,
        timeoutMs: 25,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        fetchImpl: slowFetch as any,
      });

      expect(probe.status).toBe('timeout');
      expect(probe.message).toMatch(/25ms/);
      // Belt-and-braces: never call it "hung".
      expect(probe.message.toLowerCase()).not.toMatch(/hung/);
    });

    test('reports "error" when /healthz returns 503 with body.ok=false', async () => {
      const fakeFetch = jest.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: false, state: 'starting', reason: 'engines not ready' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        }),
      );

      const probe = await probeDaemonHealthz({
        port: 7801,
        timeoutMs: 1_000,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        fetchImpl: fakeFetch as any,
      });

      expect(probe.status).toBe('error');
      expect(probe.message).toMatch(/HTTP 503/);
      expect(probe.message).toMatch(/engines not ready/);
    });

    test('uses 5s as the default timeout matching the acceptance criterion', () => {
      expect(DOCTOR_CHECK_TIMEOUT_MS).toBe(5_000);
    });

    test('honours the SWEECH_PORT env var when no explicit port is given', async () => {
      const previous = process.env.SWEECH_PORT;
      process.env.SWEECH_PORT = '9999';
      const fakeFetch = jest.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: true, version: 't', uptime: 0 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

      try {
        await probeDaemonHealthz({
          timeoutMs: 1_000,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          fetchImpl: fakeFetch as any,
        });
        expect(fakeFetch).toHaveBeenCalledWith(
          'http://127.0.0.1:9999/healthz',
          expect.any(Object),
        );
      } finally {
        if (previous === undefined) {
          delete process.env.SWEECH_PORT;
        } else {
          process.env.SWEECH_PORT = previous;
        }
      }
    });
  });
});
