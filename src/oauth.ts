/**
 * OAuth 2.0 authentication support for Claude Code and Codex
 * Handles PKCE flow for both Anthropic and OpenAI APIs
 */

import * as url from 'url';
import { randomBytes } from 'crypto';
import chalk from 'chalk';
import inquirer from 'inquirer';

export interface OAuthToken {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  tokenType: string;
  provider: 'anthropic' | 'openai';
}

export interface OAuthConfig {
  env: {
    [key: string]: string;
  };
}

/**
 * Get OAuth authentication token via browser flow
 */
export async function getOAuthToken(
  cliType: string,
  provider: string
): Promise<OAuthToken> {
  console.log(chalk.cyan('\n🔐 Starting OAuth authentication...\n'));

  if (cliType === 'claude') {
    return getAnthropicOAuthToken();
  } else if (cliType === 'codex') {
    return getOpenAIOAuthToken();
  } else {
    throw new Error(`OAuth not supported for CLI type: ${cliType}`);
  }
}

/**
 * Anthropic OAuth flow using PKCE (manual code paste)
 */
async function getAnthropicOAuthToken(): Promise<OAuthToken> {
  const clientId = process.env.ANTHROPIC_CLIENT_ID || 'sweech-cli';
  const redirectUri = 'urn:ietf:wg:oauth:2.0:oob'; // Out-of-band (manual)

  // Create PKCE challenge
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);

  // Build authorization URL (using claude.ai, not api.anthropic.com)
  const authUrl = new url.URL('https://claude.ai/oauth/authorize');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', 'openid profile email');
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');

  console.log(chalk.yellow('\n📋 Manual OAuth Authentication\n'));
  console.log(chalk.cyan('Step 1:'), 'Copy this URL and open it in your browser');
  console.log(chalk.cyan('        '), '(Use incognito mode to select a different account)\n');
  console.log(chalk.gray(authUrl.toString()));
  console.log();

  // Prompt user to paste the authorization code
  const { authCode } = await inquirer.prompt([
    {
      type: 'input',
      name: 'authCode',
      message: 'Step 2: After logging in, paste the authorization code here:',
      validate: (input: string) => {
        if (!input || input.trim().length === 0) {
          return 'Authorization code is required';
        }
        return true;
      }
    }
  ]);

  // Exchange code for token
  const tokenResponse = await exchangeCodeForToken(
    clientId,
    redirectUri,
    authCode.trim(),
    codeVerifier,
    'anthropic'
  );

  return {
    accessToken: tokenResponse.access_token,
    refreshToken: tokenResponse.refresh_token,
    expiresAt: tokenResponse.expires_in
      ? Date.now() + tokenResponse.expires_in * 1000
      : undefined,
    tokenType: tokenResponse.token_type || 'Bearer',
    provider: 'anthropic'
  };
}

/**
 * OpenAI OAuth flow using PKCE (manual code paste)
 */
async function getOpenAIOAuthToken(): Promise<OAuthToken> {
  const clientId = process.env.OPENAI_CLIENT_ID || 'sweech-cli';
  const redirectUri = 'urn:ietf:wg:oauth:2.0:oob'; // Out-of-band (manual)

  // Create PKCE challenge
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);

  // Build authorization URL
  const authUrl = new url.URL('https://platform.openai.com/oauth/authorize');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', 'read:models');
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');

  console.log(chalk.yellow('\n📋 Manual OAuth Authentication\n'));
  console.log(chalk.cyan('Step 1:'), 'Copy this URL and open it in your browser');
  console.log(chalk.cyan('        '), '(Use incognito mode to select a different account)\n');
  console.log(chalk.gray(authUrl.toString()));
  console.log();

  // Prompt user to paste the authorization code
  const { authCode } = await inquirer.prompt([
    {
      type: 'input',
      name: 'authCode',
      message: 'Step 2: After logging in, paste the authorization code here:',
      validate: (input: string) => {
        if (!input || input.trim().length === 0) {
          return 'Authorization code is required';
        }
        return true;
      }
    }
  ]);

  // Exchange code for token
  const tokenResponse = await exchangeCodeForToken(
    clientId,
    redirectUri,
    authCode.trim(),
    codeVerifier,
    'openai'
  );

  return {
    accessToken: tokenResponse.access_token,
    refreshToken: tokenResponse.refresh_token,
    expiresAt: tokenResponse.expires_in
      ? Date.now() + tokenResponse.expires_in * 1000
      : undefined,
    tokenType: tokenResponse.token_type || 'Bearer',
    provider: 'openai'
  };
}


/**
 * Exchange authorization code for access token
 */
async function exchangeCodeForToken(
  clientId: string,
  redirectUri: string,
  code: string,
  codeVerifier: string,
  provider: 'anthropic' | 'openai'
): Promise<any> {
  const tokenEndpoint =
    provider === 'anthropic'
      ? 'https://claude.ai/api/oauth/token'
      : 'https://api.openai.com/oauth/token';

  const clientSecret = process.env.ANTHROPIC_CLIENT_SECRET || process.env.OPENAI_CLIENT_SECRET;

  // Build token request params (client_secret optional for PKCE public clients)
  const params: Record<string, string> = {
    grant_type: 'authorization_code',
    client_id: clientId,
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier
  };

  // Add client_secret if available (required for some providers)
  if (clientSecret) {
    params.client_secret = clientSecret;
  }

  const urlParams = new url.URLSearchParams(params);

  const response = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: urlParams.toString()
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Token exchange failed: ${error}`);
  }

  return response.json();
}

/**
 * Refresh OAuth token
 */
export async function refreshOAuthToken(token: OAuthToken): Promise<OAuthToken> {
  if (!token.refreshToken) {
    throw new Error('No refresh token available');
  }

  const tokenEndpoint =
    token.provider === 'anthropic'
      ? 'https://platform.claude.com/v1/oauth/token'
      : 'https://api.openai.com/oauth/token';

  // Use the real Claude Code OAuth client ID so refresh tokens issued by Claude Code work
  const clientId = token.provider === 'anthropic'
    ? (process.env.ANTHROPIC_CLIENT_ID || '9d1c250a-e61b-44d9-88ed-5944d1962f5e')
    : (process.env.OPENAI_CLIENT_ID || 'sweech-cli');

  const clientSecret = process.env.ANTHROPIC_CLIENT_SECRET || process.env.OPENAI_CLIENT_SECRET;

  // Build refresh request params (client_secret optional for PKCE public clients)
  const paramsObj: Record<string, string> = {
    grant_type: 'refresh_token',
    client_id: clientId,
    refresh_token: token.refreshToken
  };

  // Add client_secret if available (required for some providers)
  if (clientSecret) {
    paramsObj.client_secret = clientSecret;
  }

  const params = new url.URLSearchParams(paramsObj);

  const response = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });

  if (!response.ok) {
    throw new Error('Token refresh failed');
  }

  const data = (await response.json()) as any;

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || token.refreshToken,
    expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
    tokenType: data.token_type || 'Bearer',
    provider: token.provider
  };
}

/**
 * Check if OAuth token is expired
 */
export function isTokenExpired(token: OAuthToken): boolean {
  if (!token.expiresAt) return false;
  // Consider token expired if less than 5 minutes remaining
  return token.expiresAt - Date.now() < 5 * 60 * 1000;
}

/**
 * Convert OAuth token to environment variables
 */
export function oauthTokenToEnv(
  token: OAuthToken,
  cliType: string
): { [key: string]: string } {
  if (cliType === 'claude') {
    return {
      ANTHROPIC_AUTH_TOKEN: `bearer_${token.accessToken}`,
      ANTHROPIC_BEARER_TOKEN: token.accessToken
    };
  } else if (cliType === 'codex') {
    return {
      OPENAI_API_KEY: `sk-oauth-${token.accessToken}`,
      OPENAI_BEARER_TOKEN: token.accessToken
    };
  }

  throw new Error(`Unsupported CLI type: ${cliType}`);
}

/**
 * Generate PKCE code verifier (43-128 characters)
 */
function generateCodeVerifier(): string {
  return randomBytes(32).toString('base64url').slice(0, 128);
}

/**
 * Generate PKCE code challenge from verifier
 */
function generateCodeChallenge(verifier: string): string {
  const crypto = require('crypto');
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}
