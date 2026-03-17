"use strict";
/**
 * OAuth 2.0 authentication support for Claude Code and Codex
 * Handles PKCE flow for both Anthropic and OpenAI APIs
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getOAuthToken = getOAuthToken;
exports.refreshOAuthToken = refreshOAuthToken;
exports.isTokenExpired = isTokenExpired;
exports.oauthTokenToEnv = oauthTokenToEnv;
const url = __importStar(require("url"));
const crypto_1 = require("crypto");
const chalk_1 = __importDefault(require("chalk"));
const inquirer_1 = __importDefault(require("inquirer"));
/**
 * Get OAuth authentication token via browser flow
 */
async function getOAuthToken(cliType, provider) {
    console.log(chalk_1.default.cyan('\n🔐 Starting OAuth authentication...\n'));
    if (cliType === 'claude') {
        return getAnthropicOAuthToken();
    }
    else if (cliType === 'codex') {
        return getOpenAIOAuthToken();
    }
    else {
        throw new Error(`OAuth not supported for CLI type: ${cliType}`);
    }
}
/**
 * Anthropic OAuth flow using PKCE (manual code paste)
 */
async function getAnthropicOAuthToken() {
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
    console.log(chalk_1.default.yellow('\n📋 Manual OAuth Authentication\n'));
    console.log(chalk_1.default.cyan('Step 1:'), 'Copy this URL and open it in your browser');
    console.log(chalk_1.default.cyan('        '), '(Use incognito mode to select a different account)\n');
    console.log(chalk_1.default.gray(authUrl.toString()));
    console.log();
    // Prompt user to paste the authorization code
    const { authCode } = await inquirer_1.default.prompt([
        {
            type: 'input',
            name: 'authCode',
            message: 'Step 2: After logging in, paste the authorization code here:',
            validate: (input) => {
                if (!input || input.trim().length === 0) {
                    return 'Authorization code is required';
                }
                return true;
            }
        }
    ]);
    // Exchange code for token
    const tokenResponse = await exchangeCodeForToken(clientId, redirectUri, authCode.trim(), codeVerifier, 'anthropic');
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
async function getOpenAIOAuthToken() {
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
    console.log(chalk_1.default.yellow('\n📋 Manual OAuth Authentication\n'));
    console.log(chalk_1.default.cyan('Step 1:'), 'Copy this URL and open it in your browser');
    console.log(chalk_1.default.cyan('        '), '(Use incognito mode to select a different account)\n');
    console.log(chalk_1.default.gray(authUrl.toString()));
    console.log();
    // Prompt user to paste the authorization code
    const { authCode } = await inquirer_1.default.prompt([
        {
            type: 'input',
            name: 'authCode',
            message: 'Step 2: After logging in, paste the authorization code here:',
            validate: (input) => {
                if (!input || input.trim().length === 0) {
                    return 'Authorization code is required';
                }
                return true;
            }
        }
    ]);
    // Exchange code for token
    const tokenResponse = await exchangeCodeForToken(clientId, redirectUri, authCode.trim(), codeVerifier, 'openai');
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
async function exchangeCodeForToken(clientId, redirectUri, code, codeVerifier, provider) {
    const tokenEndpoint = provider === 'anthropic'
        ? 'https://claude.ai/api/oauth/token'
        : 'https://api.openai.com/oauth/token';
    const clientSecret = process.env.ANTHROPIC_CLIENT_SECRET || process.env.OPENAI_CLIENT_SECRET;
    // Build token request params (client_secret optional for PKCE public clients)
    const params = {
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
async function refreshOAuthToken(token) {
    if (!token.refreshToken) {
        throw new Error('No refresh token available');
    }
    const tokenEndpoint = token.provider === 'anthropic'
        ? 'https://platform.claude.com/v1/oauth/token'
        : 'https://api.openai.com/oauth/token';
    // Use the real Claude Code OAuth client ID so refresh tokens issued by Claude Code work
    const clientId = token.provider === 'anthropic'
        ? (process.env.ANTHROPIC_CLIENT_ID || '9d1c250a-e61b-44d9-88ed-5944d1962f5e')
        : (process.env.OPENAI_CLIENT_ID || 'sweech-cli');
    const clientSecret = process.env.ANTHROPIC_CLIENT_SECRET || process.env.OPENAI_CLIENT_SECRET;
    // Build refresh request params (client_secret optional for PKCE public clients)
    const paramsObj = {
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
    const data = (await response.json());
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
function isTokenExpired(token) {
    if (!token.expiresAt)
        return false;
    // Consider token expired if less than 5 minutes remaining
    return token.expiresAt - Date.now() < 5 * 60 * 1000;
}
/**
 * Convert OAuth token to environment variables
 */
function oauthTokenToEnv(token, cliType) {
    if (cliType === 'claude') {
        return {
            ANTHROPIC_AUTH_TOKEN: `bearer_${token.accessToken}`,
            ANTHROPIC_BEARER_TOKEN: token.accessToken
        };
    }
    else if (cliType === 'codex') {
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
function generateCodeVerifier() {
    return (0, crypto_1.randomBytes)(32).toString('base64url').slice(0, 128);
}
/**
 * Generate PKCE code challenge from verifier
 */
function generateCodeChallenge(verifier) {
    const crypto = require('crypto');
    return crypto.createHash('sha256').update(verifier).digest('base64url');
}
