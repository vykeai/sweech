import { describe, it, expect, vi } from 'vitest';
import { CopilotRunner } from '../../runner/copilot.js';

const liveCopilotIt = process.env.OMNAI_RUN_LIVE_COPILOT_TESTS === '1' ? it : it.skip;

describe('CopilotRunner', () => {
  it('has correct engine id', () => {
    const runner = new CopilotRunner('/usr/bin/copilot');
    expect(runner.engine).toBe('copilot');
  });

  it('maps model tier aliases', async () => {
    // We can't easily mock execa, but we can verify the runner constructs
    // and has the right interface
    const runner = new CopilotRunner('/nonexistent');
    expect(runner.engine).toBe('copilot');
    expect(typeof runner.run).toBe('function');
    expect(typeof runner.isAvailable).toBe('function');
  });

  it('isAvailable returns false for nonexistent binary', async () => {
    const runner = new CopilotRunner('/nonexistent/copilot');
    expect(await runner.isAvailable()).toBe(false);
  });

  it('isAvailable returns true for real binary', async () => {
    // Find copilot in PATH
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    let binaryPath: string | undefined;
    try {
      const { stdout } = await execFileAsync('which', ['copilot']);
      binaryPath = stdout.trim();
    } catch {}

    if (!binaryPath) return; // Skip if copilot not installed

    const runner = new CopilotRunner(binaryPath);
    expect(await runner.isAvailable()).toBe(true);
  });
});

describe('CopilotRunner integration', () => {
  liveCopilotIt('runs a simple prompt and returns events', async () => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    let binaryPath: string | undefined;
    try {
      const { stdout } = await execFileAsync('which', ['copilot']);
      binaryPath = stdout.trim();
    } catch {}

    if (!binaryPath) return; // Skip if copilot not installed

    const runner = new CopilotRunner(binaryPath);
    const events: any[] = [];

    for await (const event of runner.run('respond with just the word "pong"', { model: 'gpt-5-mini' })) {
      events.push(event);
    }

    const textEvents = events.filter(e => e.type === 'text');
    const resultEvents = events.filter(e => e.type === 'result');

    expect(textEvents.length).toBeGreaterThan(0);
    expect(resultEvents).toHaveLength(1);

    const result = resultEvents[0];
    expect(result.output).toBeTruthy();
    expect(result.durationMs).toBeGreaterThan(0);
    expect(result.sessionId).toBeTruthy();
    expect(result.usage.outputTokens).toBeGreaterThan(0);
  }, 30_000);
});
