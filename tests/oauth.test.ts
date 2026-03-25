/**
 * Tests for OAuth authentication (src/oauth.ts)
 */

// Mock inquirer — must match `import inquirer from 'inquirer'` with esModuleInterop
const mockPrompt = jest.fn();
jest.mock('inquirer', () => ({
  __esModule: true,
  default: { prompt: mockPrompt }
}));

// Mock global fetch
const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

import {
  OAuthToken,
  isTokenExpired,
  oauthTokenToEnv,
  getOAuthToken,
  refreshOAuthToken
} from '../src/oauth';

beforeEach(() => {
  mockFetch.mockReset();
  mockPrompt.mockReset();
});

// ---------------------------------------------------------------------------
// isTokenExpired
// ---------------------------------------------------------------------------

describe('isTokenExpired', () => {
  it('should return false for tokens with no expiration', () => {
    const token: OAuthToken = {
      accessToken: 'test-token',
      tokenType: 'Bearer',
      provider: 'anthropic'
    };

    expect(isTokenExpired(token)).toBe(false);
  });

  it('should return false for tokens that expire in the future (>5 min)', () => {
    const token: OAuthToken = {
      accessToken: 'test-token',
      tokenType: 'Bearer',
      provider: 'anthropic',
      expiresAt: Date.now() + 10 * 60 * 1000 // 10 minutes from now
    };

    expect(isTokenExpired(token)).toBe(false);
  });

  it('should return true for tokens that expire within 5 minutes', () => {
    const token: OAuthToken = {
      accessToken: 'test-token',
      tokenType: 'Bearer',
      provider: 'anthropic',
      expiresAt: Date.now() + 2 * 60 * 1000 // 2 minutes from now
    };

    expect(isTokenExpired(token)).toBe(true);
  });

  it('should return true for tokens that have already expired', () => {
    const token: OAuthToken = {
      accessToken: 'test-token',
      tokenType: 'Bearer',
      provider: 'anthropic',
      expiresAt: Date.now() - 1000 // 1 second ago
    };

    expect(isTokenExpired(token)).toBe(true);
  });

  it('should return false when expiresAt is undefined', () => {
    const token: OAuthToken = {
      accessToken: 'test-token',
      tokenType: 'Bearer',
      provider: 'openai',
      expiresAt: undefined
    };

    expect(isTokenExpired(token)).toBe(false);
  });

  it('should return true when expiresAt is exactly now (within 5-min buffer)', () => {
    const token: OAuthToken = {
      accessToken: 'test-token',
      tokenType: 'Bearer',
      provider: 'anthropic',
      expiresAt: Date.now()
    };

    expect(isTokenExpired(token)).toBe(true);
  });

  it('should return false at just over the 5-minute boundary', () => {
    const token: OAuthToken = {
      accessToken: 'test-token',
      tokenType: 'Bearer',
      provider: 'anthropic',
      expiresAt: Date.now() + 5 * 60 * 1000 + 100
    };

    expect(isTokenExpired(token)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// oauthTokenToEnv
// ---------------------------------------------------------------------------

describe('oauthTokenToEnv', () => {
  it('should convert Anthropic OAuth token with bearer_ prefix', () => {
    const token: OAuthToken = {
      accessToken: 'test-access-token',
      tokenType: 'Bearer',
      provider: 'anthropic'
    };

    const env = oauthTokenToEnv(token, 'claude');

    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('bearer_test-access-token');
    expect(env.ANTHROPIC_BEARER_TOKEN).toBe('test-access-token');
    expect(Object.keys(env)).toHaveLength(2);
  });

  it('should convert OpenAI OAuth token with sk-oauth- prefix', () => {
    const token: OAuthToken = {
      accessToken: 'test-access-token',
      tokenType: 'Bearer',
      provider: 'openai'
    };

    const env = oauthTokenToEnv(token, 'codex');

    expect(env.OPENAI_API_KEY).toBe('sk-oauth-test-access-token');
    expect(env.OPENAI_BEARER_TOKEN).toBe('test-access-token');
    expect(Object.keys(env)).toHaveLength(2);
  });

  it('should throw for unsupported CLI types', () => {
    const token: OAuthToken = {
      accessToken: 'test-token',
      tokenType: 'Bearer',
      provider: 'anthropic'
    };

    expect(() => oauthTokenToEnv(token, 'unsupported')).toThrow('Unsupported CLI type');
    expect(() => oauthTokenToEnv(token, '')).toThrow('Unsupported CLI type');
    expect(() => oauthTokenToEnv(token, 'gemini')).toThrow('Unsupported CLI type');
  });

  it('should not include OpenAI keys for claude cliType', () => {
    const token: OAuthToken = {
      accessToken: 'abc',
      tokenType: 'Bearer',
      provider: 'anthropic'
    };
    const env = oauthTokenToEnv(token, 'claude');
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.OPENAI_BEARER_TOKEN).toBeUndefined();
  });

  it('should not include Anthropic keys for codex cliType', () => {
    const token: OAuthToken = {
      accessToken: 'abc',
      tokenType: 'Bearer',
      provider: 'openai'
    };
    const env = oauthTokenToEnv(token, 'codex');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_BEARER_TOKEN).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getOAuthToken — routing
// ---------------------------------------------------------------------------

describe('getOAuthToken', () => {
  let consoleLogSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
  });

  it('should throw for unsupported CLI type', async () => {
    await expect(getOAuthToken('unsupported', 'someprovider')).rejects.toThrow(
      'OAuth not supported for CLI type: unsupported'
    );
  });

  it('should throw for empty CLI type', async () => {
    await expect(getOAuthToken('', 'someprovider')).rejects.toThrow(
      'OAuth not supported for CLI type: '
    );
  });

  it('should route claude cliType to Anthropic flow', async () => {
    mockPrompt.mockResolvedValueOnce({ authCode: 'test-auth-code' });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: 'anthropic-token-123',
        refresh_token: 'ref-123',
        expires_in: 3600,
        token_type: 'Bearer'
      })
    });

    const token = await getOAuthToken('claude', 'anthropic');

    expect(token.provider).toBe('anthropic');
    expect(token.accessToken).toBe('anthropic-token-123');
    expect(token.refreshToken).toBe('ref-123');
    expect(token.tokenType).toBe('Bearer');
    expect(token.expiresAt).toBeDefined();
    // Verify fetch was called with Anthropic endpoint
    expect(mockFetch).toHaveBeenCalledWith(
      'https://claude.ai/api/oauth/token',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      })
    );
  });

  it('should route codex cliType to OpenAI flow', async () => {
    mockPrompt.mockResolvedValueOnce({ authCode: 'openai-auth-code' });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: 'openai-token-456',
        refresh_token: 'ref-456',
        expires_in: 7200,
        token_type: 'Bearer'
      })
    });

    const token = await getOAuthToken('codex', 'openai');

    expect(token.provider).toBe('openai');
    expect(token.accessToken).toBe('openai-token-456');
    expect(token.refreshToken).toBe('ref-456');
    // Verify fetch was called with OpenAI endpoint
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.openai.com/oauth/token',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('should handle token exchange failure', async () => {
    mockPrompt.mockResolvedValueOnce({ authCode: 'bad-code' });

    mockFetch.mockResolvedValueOnce({
      ok: false,
      text: async () => 'invalid_grant: authorization code expired'
    });

    await expect(getOAuthToken('claude', 'anthropic')).rejects.toThrow(
      'Token exchange failed'
    );
  });

  it('should handle missing expires_in gracefully', async () => {
    mockPrompt.mockResolvedValueOnce({ authCode: 'auth-code' });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: 'token-no-expiry',
        token_type: 'Bearer'
        // no expires_in, no refresh_token
      })
    });

    const token = await getOAuthToken('claude', 'anthropic');

    expect(token.accessToken).toBe('token-no-expiry');
    expect(token.expiresAt).toBeUndefined();
    expect(token.refreshToken).toBeUndefined();
  });

  it('should trim whitespace from pasted auth code', async () => {
    mockPrompt.mockResolvedValueOnce({ authCode: '  spaced-code  ' });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: 'tok',
        token_type: 'Bearer'
      })
    });

    await getOAuthToken('claude', 'anthropic');

    // Verify the fetch body contains the trimmed code
    const fetchCall = mockFetch.mock.calls[0];
    const body = fetchCall[1].body as string;
    expect(body).toContain('code=spaced-code');
  });

  it('should include code_verifier in token exchange (PKCE)', async () => {
    mockPrompt.mockResolvedValueOnce({ authCode: 'my-code' });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: 'tok',
        token_type: 'Bearer'
      })
    });

    await getOAuthToken('claude', 'anthropic');

    const body = mockFetch.mock.calls[0][1].body as string;
    expect(body).toContain('code_verifier=');
    expect(body).toContain('grant_type=authorization_code');
  });

  it('should default token_type to Bearer when not returned', async () => {
    mockPrompt.mockResolvedValueOnce({ authCode: 'code' });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: 'tok'
        // no token_type
      })
    });

    const token = await getOAuthToken('codex', 'openai');

    expect(token.tokenType).toBe('Bearer');
  });
});

// ---------------------------------------------------------------------------
// refreshOAuthToken
// ---------------------------------------------------------------------------

describe('refreshOAuthToken', () => {
  it('should throw when no refresh token is available', async () => {
    const token: OAuthToken = {
      accessToken: 'test-token',
      tokenType: 'Bearer',
      provider: 'anthropic'
      // no refreshToken
    };

    await expect(refreshOAuthToken(token)).rejects.toThrow(
      'No refresh token available'
    );
  });

  it('should refresh an Anthropic token successfully', async () => {
    const token: OAuthToken = {
      accessToken: 'old-token',
      refreshToken: 'refresh-abc',
      tokenType: 'Bearer',
      provider: 'anthropic'
    };

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: 'new-anthropic-token',
        refresh_token: 'new-refresh-token',
        expires_in: 3600,
        token_type: 'Bearer'
      })
    });

    const refreshed = await refreshOAuthToken(token);

    expect(refreshed.accessToken).toBe('new-anthropic-token');
    expect(refreshed.refreshToken).toBe('new-refresh-token');
    expect(refreshed.provider).toBe('anthropic');
    expect(refreshed.expiresAt).toBeDefined();
    expect(refreshed.expiresAt!).toBeGreaterThan(Date.now());
    // Verify the correct endpoint
    expect(mockFetch).toHaveBeenCalledWith(
      'https://platform.claude.com/v1/oauth/token',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('should refresh an OpenAI token successfully', async () => {
    const token: OAuthToken = {
      accessToken: 'old-openai-token',
      refreshToken: 'refresh-openai',
      tokenType: 'Bearer',
      provider: 'openai'
    };

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: 'new-openai-token',
        refresh_token: 'new-openai-refresh',
        expires_in: 7200,
        token_type: 'Bearer'
      })
    });

    const refreshed = await refreshOAuthToken(token);

    expect(refreshed.accessToken).toBe('new-openai-token');
    expect(refreshed.refreshToken).toBe('new-openai-refresh');
    expect(refreshed.provider).toBe('openai');
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.openai.com/oauth/token',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('should keep old refresh token when server does not return a new one', async () => {
    const token: OAuthToken = {
      accessToken: 'old-token',
      refreshToken: 'keep-this-refresh',
      tokenType: 'Bearer',
      provider: 'anthropic'
    };

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: 'new-token',
        // no refresh_token returned
        expires_in: 3600,
        token_type: 'Bearer'
      })
    });

    const refreshed = await refreshOAuthToken(token);

    expect(refreshed.refreshToken).toBe('keep-this-refresh');
  });

  it('should throw when refresh request fails', async () => {
    const token: OAuthToken = {
      accessToken: 'old-token',
      refreshToken: 'bad-refresh',
      tokenType: 'Bearer',
      provider: 'anthropic'
    };

    mockFetch.mockResolvedValueOnce({
      ok: false,
      text: async () => 'invalid_grant'
    });

    await expect(refreshOAuthToken(token)).rejects.toThrow('Token refresh failed');
  });

  it('should handle missing expires_in in refresh response', async () => {
    const token: OAuthToken = {
      accessToken: 'old-token',
      refreshToken: 'refresh-ok',
      tokenType: 'Bearer',
      provider: 'openai'
    };

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: 'refreshed-token',
        token_type: 'Bearer'
        // no expires_in
      })
    });

    const refreshed = await refreshOAuthToken(token);

    expect(refreshed.expiresAt).toBeUndefined();
  });

  it('should default token_type to Bearer when not provided', async () => {
    const token: OAuthToken = {
      accessToken: 'old-token',
      refreshToken: 'refresh-ok',
      tokenType: 'Bearer',
      provider: 'anthropic'
    };

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: 'refreshed-token'
        // no token_type
      })
    });

    const refreshed = await refreshOAuthToken(token);

    expect(refreshed.tokenType).toBe('Bearer');
  });

  it('should send grant_type=refresh_token in request body', async () => {
    const token: OAuthToken = {
      accessToken: 'old-token',
      refreshToken: 'my-refresh',
      tokenType: 'Bearer',
      provider: 'anthropic'
    };

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: 'new-tok',
        token_type: 'Bearer'
      })
    });

    await refreshOAuthToken(token);

    const body = mockFetch.mock.calls[0][1].body as string;
    expect(body).toContain('grant_type=refresh_token');
    expect(body).toContain('refresh_token=my-refresh');
  });

  it('should send client_id in refresh request', async () => {
    const token: OAuthToken = {
      accessToken: 'old-token',
      refreshToken: 'my-refresh',
      tokenType: 'Bearer',
      provider: 'anthropic'
    };

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: 'new-tok',
        token_type: 'Bearer'
      })
    });

    await refreshOAuthToken(token);

    const body = mockFetch.mock.calls[0][1].body as string;
    expect(body).toContain('client_id=');
  });
});

// ---------------------------------------------------------------------------
// OAuth Token Structure
// ---------------------------------------------------------------------------

describe('OAuth Token Structure', () => {
  it('should support Anthropic OAuth tokens', () => {
    const token: OAuthToken = {
      accessToken: 'ac-xxx',
      refreshToken: 'ref-xxx',
      expiresAt: Date.now() + 3600000,
      tokenType: 'Bearer',
      provider: 'anthropic'
    };

    expect(token.provider).toBe('anthropic');
    expect(token.refreshToken).toBeDefined();
    expect(token.expiresAt).toBeDefined();
  });

  it('should support OpenAI OAuth tokens', () => {
    const token: OAuthToken = {
      accessToken: 'sk-oauth-xxx',
      refreshToken: 'refresh-xxx',
      expiresAt: Date.now() + 3600000,
      tokenType: 'Bearer',
      provider: 'openai'
    };

    expect(token.provider).toBe('openai');
    expect(token.refreshToken).toBeDefined();
    expect(token.expiresAt).toBeDefined();
  });

  it('should allow optional refreshToken and expiresAt', () => {
    const token: OAuthToken = {
      accessToken: 'min-token',
      tokenType: 'Bearer',
      provider: 'anthropic'
    };

    expect(token.refreshToken).toBeUndefined();
    expect(token.expiresAt).toBeUndefined();
  });
});
