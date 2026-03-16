/**
 * Local HTTP server for OAuth callback redirects.
 * Starts a temporary server on port 19284 to receive the authorization code
 * from the browser-based OAuth flow, replacing the manual code-paste approach.
 */

import * as http from 'node:http';
import { exec } from 'node:child_process';

const OAUTH_CALLBACK_PORT = 19284;
const OAUTH_CALLBACK_PATH = '/callback';
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

const SUCCESS_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>sweech - Authentication Successful</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #1a1a2e;
      color: #e0e0e0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
    }
    .container {
      text-align: center;
      padding: 2rem;
    }
    .checkmark {
      font-size: 4rem;
      color: #4ecca3;
      margin-bottom: 1rem;
    }
    h1 {
      font-size: 1.5rem;
      font-weight: 600;
      margin-bottom: 0.5rem;
      color: #ffffff;
    }
    p {
      font-size: 1rem;
      color: #a0a0b0;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="checkmark">&#x2714;</div>
    <h1>Authentication successful!</h1>
    <p>You can close this tab.</p>
  </div>
</body>
</html>`;

/**
 * Returns the full OAuth callback URL for this server.
 */
export function getCallbackUrl(): string {
  return `http://localhost:${OAUTH_CALLBACK_PORT}${OAUTH_CALLBACK_PATH}`;
}

/**
 * Opens the given URL in the user's default browser.
 * Uses `open` on macOS, `xdg-open` on Linux.
 * Falls back to printing the URL to stderr if the command fails.
 */
export function openBrowserForAuth(url: string): void {
  const command =
    process.platform === 'darwin'
      ? `open "${url}"`
      : `xdg-open "${url}"`;

  exec(command, (error) => {
    if (error) {
      console.error(`Could not open browser automatically.`);
      console.error(`Open this URL in your browser:\n  ${url}`);
    }
  });
}

/**
 * Starts a local HTTP server that waits for an OAuth callback.
 *
 * The caller provides the expected `state` value for CSRF validation.
 * The server listens for GET /callback?code=...&state=... and resolves
 * once a valid callback is received.
 *
 * Rejects if:
 * - The `state` parameter does not match `expectedState`
 * - No callback is received within `timeoutMs` (default: 5 minutes)
 *
 * The server auto-closes ~1s after serving the success response.
 */
export async function waitForOAuthCallback(
  expectedState: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<{ code: string }> {
  return new Promise<{ code: string }>((resolve, reject) => {
    let settled = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    const server = http.createServer((req, res) => {
      if (!req.url) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Bad request');
        return;
      }

      const parsed = new URL(req.url, `http://localhost:${OAUTH_CALLBACK_PORT}`);

      if (req.method !== 'GET' || parsed.pathname !== OAUTH_CALLBACK_PATH) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
      }

      const code = parsed.searchParams.get('code');
      const state = parsed.searchParams.get('state');
      const error = parsed.searchParams.get('error');

      // Provider returned an error
      if (error) {
        const description = parsed.searchParams.get('error_description') || error;
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end(`Authentication failed: ${description}`);
        cleanup();
        if (!settled) {
          settled = true;
          reject(new Error(`OAuth error from provider: ${description}`));
        }
        return;
      }

      // Missing required params
      if (!code || !state) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Missing required parameters: code and state');
        return;
      }

      // CSRF check: state must match
      if (state !== expectedState) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('State mismatch — possible CSRF attack. Authentication rejected.');
        return;
      }

      // Success — serve the HTML page, then shut down
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      res.end(SUCCESS_HTML);

      // Delay shutdown so the browser receives the full response
      setTimeout(() => {
        cleanup();
        if (!settled) {
          settled = true;
          resolve({ code });
        }
      }, 1000);
    });

    server.on('error', (err) => {
      cleanup();
      if (!settled) {
        settled = true;
        reject(new Error(`OAuth callback server error: ${err.message}`));
      }
    });

    function cleanup() {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = undefined;
      }
      server.close();
    }

    // Timeout — reject if no callback arrives in time
    timeoutHandle = setTimeout(() => {
      cleanup();
      if (!settled) {
        settled = true;
        reject(
          new Error(
            `OAuth callback timed out after ${Math.round(timeoutMs / 1000)}s. No authorization code received.`
          )
        );
      }
    }, timeoutMs);

    server.listen(OAUTH_CALLBACK_PORT, '127.0.0.1', () => {
      // Server is ready to receive the callback
    });
  });
}
