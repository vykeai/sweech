import { DEFAULT_DAEMON_PORT, envOrDefaultDaemonPort } from '../src/constants';

describe('constants (T-056)', () => {
  const originalEnv = process.env.SWEECH_PORT;
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.SWEECH_PORT;
    else process.env.SWEECH_PORT = originalEnv;
  });

  test('DEFAULT_DAEMON_PORT is 7801', () => {
    expect(DEFAULT_DAEMON_PORT).toBe(7801);
  });

  test('envOrDefaultDaemonPort returns DEFAULT_DAEMON_PORT when env unset', () => {
    delete process.env.SWEECH_PORT;
    expect(envOrDefaultDaemonPort()).toBe(DEFAULT_DAEMON_PORT);
  });

  test('envOrDefaultDaemonPort honours SWEECH_PORT env override', () => {
    process.env.SWEECH_PORT = '9999';
    expect(envOrDefaultDaemonPort()).toBe(9999);
  });

  test('envOrDefaultDaemonPort falls back to default when SWEECH_PORT is non-numeric', () => {
    process.env.SWEECH_PORT = 'not-a-port';
    expect(envOrDefaultDaemonPort()).toBe(DEFAULT_DAEMON_PORT);
  });

  test('envOrDefaultDaemonPort falls back to default when SWEECH_PORT is zero or negative', () => {
    process.env.SWEECH_PORT = '0';
    expect(envOrDefaultDaemonPort()).toBe(DEFAULT_DAEMON_PORT);
    process.env.SWEECH_PORT = '-1';
    expect(envOrDefaultDaemonPort()).toBe(DEFAULT_DAEMON_PORT);
  });
});
