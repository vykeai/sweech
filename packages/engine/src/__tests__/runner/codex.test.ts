import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

import { execa } from 'execa';
import { CodexRunner } from '../../runner/codex.js';

const mockExeca = vi.mocked(execa);

function makeJsonlProcess(lines: string[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const line of lines) {
        yield line;
      }
    },
  };
}

describe('CodexRunner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses positional session ID for resume', async () => {
    mockExeca.mockReturnValueOnce(
      makeJsonlProcess([
        JSON.stringify({
          type: 'turn.completed',
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      ]) as any,
    );

    const runner = new CodexRunner('/usr/local/bin/codex');
    const events = [];
    for await (const event of runner.run('ignored', { cwd: '/tmp', resumeSessionId: 'session-123' })) {
      events.push(event);
    }

    expect(events.some((e: any) => e.type === 'result')).toBe(true);
    expect(mockExeca).toHaveBeenCalledWith(
      '/usr/local/bin/codex',
      ['exec', '--json', '--full-auto', '--cd', '/tmp', 'resume', 'session-123'],
      expect.objectContaining({ cwd: '/tmp', lines: true }),
    );
  });
});
