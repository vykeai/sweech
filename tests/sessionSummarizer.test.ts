import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionsDb } from '../src/sessionsDb';
import {
  buildSummaryPrompt,
  parseSummaryResponse,
  readJsonlDigest,
  redactPromptForCloud,
  SessionSummarizer,
  shouldEagerlySummarize,
  type SummaryCommandRunner,
} from '../src/sessionSummarizer';

describe('SessionSummarizer', () => {
  let tmp: string;
  let db: SessionsDb;
  let jsonlPath: string;
  let priorRoots: string | undefined;

  beforeEach(() => {
    jest.useFakeTimers();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sweech-session-summary-'));
    priorRoots = process.env.SWEECH_SUMMARY_JSONL_ROOTS;
    process.env.SWEECH_SUMMARY_JSONL_ROOTS = path.join(tmp, '.claude');
    db = new SessionsDb(path.join(tmp, '.sweech', 'sessions.db'));
    jsonlPath = path.join(tmp, '.claude', 'projects', '-repo-sweech', 'session.jsonl');
    fs.mkdirSync(path.dirname(jsonlPath), { recursive: true });
    fs.writeFileSync(jsonlPath, [
      JSON.stringify({ message: { role: 'user', content: [{ type: 'text', text: 'Fix the failing dashboard test.' }] } }),
      JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'Updated the sessions query and reran Jest.' }] } }),
      JSON.stringify({ aiTitle: 'Dashboard sessions repair' }),
    ].join('\n'));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    if (priorRoots === undefined) delete process.env.SWEECH_SUMMARY_JSONL_ROOTS;
    else process.env.SWEECH_SUMMARY_JSONL_ROOTS = priorRoots;
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  function insertSession(overrides = {}) {
    return db.insert({
      id: 's1',
      workspace: 'claude-work',
      cwd: path.join(tmp, 'project-a'),
      machine: 'macbook',
      jsonlPath,
      messageCount: 50,
      msgCountFirst: 1,
      msgCountLast: 50,
      summaryStale: true,
      ...overrides,
    });
  }

  test('readJsonlDigest extracts recent text and aiTitle from Claude jsonl', () => {
    const digest = readJsonlDigest(jsonlPath, 2);

    expect(digest.map((event) => event.text)).toEqual([
      'Updated the sessions query and reran Jest.',
      'Dashboard sessions repair',
    ]);
  });

  test('readJsonlDigest returns empty for missing files', () => {
    expect(readJsonlDigest(path.join(tmp, 'missing.jsonl'))).toEqual([]);
  });

  test('readJsonlDigest rejects files outside configured jsonl roots', () => {
    const outside = path.join(tmp, 'outside.jsonl');
    fs.writeFileSync(outside, JSON.stringify({ message: { role: 'user', content: 'secret' } }));

    expect(readJsonlDigest(outside)).toEqual([]);
  });

  test('readJsonlDigest ignores malformed jsonl lines', () => {
    fs.writeFileSync(jsonlPath, [
      '{not-json',
      JSON.stringify({ message: { role: 'user', content: 'valid event' } }),
    ].join('\n'));

    expect(readJsonlDigest(jsonlPath)).toEqual([{ role: 'user', text: 'valid event', at: undefined }]);
  });

  test('readJsonlDigest caps events to the requested limit', () => {
    fs.writeFileSync(jsonlPath, Array.from({ length: 40 }, (_, index) => JSON.stringify({
      message: { role: 'user', content: `event ${index}` },
    })).join('\n'));

    const digest = readJsonlDigest(jsonlPath, 30);

    expect(digest).toHaveLength(30);
    expect(digest[0].text).toBe('event 10');
    expect(digest[29].text).toBe('event 39');
  });

  test('buildSummaryPrompt includes session metadata and transcript events', () => {
    const session = insertSession();
    const prompt = buildSummaryPrompt(session, readJsonlDigest(jsonlPath));

    expect(prompt).toContain('Workspace: claude-work');
    expect(prompt).toContain('Message count: 50');
    expect(prompt).toContain('Fix the failing dashboard test.');
    expect(prompt).toContain('Return strict JSON');
  });

  test('parseSummaryResponse accepts JSON embedded in tool output', () => {
    expect(parseSummaryResponse('ok\n{"summary_one":"Fixed tests","bullets":["read logs","patched query"],"model":"llama3","cost_usd":0}')).toEqual({
      summaryOne: 'Fixed tests',
      summaryBullets: ['read logs', 'patched query'],
      model: 'llama3',
      costUsd: 0,
    });
  });

  test('parseSummaryResponse rejects missing bullets', () => {
    expect(() => parseSummaryResponse('{"summary_one":"No activities"}')).toThrow('summary response missing bullets');
  });

  test('parseSummaryResponse rejects non-json output', () => {
    expect(() => parseSummaryResponse('plain text summary')).toThrow('summary response was not JSON');
  });

  test('shouldEagerlySummarize fires every 50 messages after last summary', () => {
    expect(shouldEagerlySummarize(insertSession({ messageCount: 49, summaryMsgAt: null }))).toBe(false);
    expect(shouldEagerlySummarize(insertSession({ id: 's2', messageCount: 50, summaryMsgAt: null }))).toBe(true);
    expect(shouldEagerlySummarize(insertSession({ id: 's3', messageCount: 99, summaryMsgAt: 50 }))).toBe(false);
    expect(shouldEagerlySummarize(insertSession({ id: 's4', messageCount: 100, summaryMsgAt: 50 }))).toBe(true);
  });

  test('summarizeNow tries ollama first and writes summary fields to sessions.db', async () => {
    insertSession();
    const publish = jest.fn();
    const runCommand: SummaryCommandRunner = jest.fn(async (args) => ({
      ok: true,
      stdout: JSON.stringify({
        summary_one: 'Dashboard tests were repaired.',
        bullets: ['Inspected session state', 'Patched the query', 'Reran Jest'],
        model: args.includes('ollama') ? 'llama3.2' : 'fallback',
        cost_usd: 0,
      }),
    }));
    const summarizer = new SessionSummarizer({ db, runCommand, publish, now: () => 12345 });

    const result = await summarizer.summarizeNow('s1');

    expect(result).toMatchObject({
      summaryOne: 'Dashboard tests were repaired.',
      summaryProvider: 'ollama',
      summaryModel: 'llama3.2',
      summaryCostUsd: 0,
      summaryAt: 12345,
      summaryMsgAt: 50,
    });
    expect(db.byId('s1')).toMatchObject({
      summaryOne: 'Dashboard tests were repaired.',
      summaryProvider: 'ollama',
      summaryModel: 'llama3.2',
      summaryCostUsd: 0,
      summaryAt: 12345,
      summaryMsgAt: 50,
      summaryStale: false,
    });
    expect(runCommand).toHaveBeenCalledWith(['auto', '--provider', 'ollama', '--json'], expect.stringContaining('Dashboard sessions repair'));
    expect(publish).toHaveBeenCalledWith('summary.updated', expect.objectContaining({ session: expect.objectContaining({ id: 's1' }) }));
  });

  test('summarizeNow falls back to budgeted auto route when ollama fails', async () => {
    insertSession();
    const calls: string[][] = [];
    const runCommand: SummaryCommandRunner = jest.fn(async (args) => {
      calls.push(args);
      if (args.includes('ollama')) return { ok: false, stdout: '', stderr: 'ollama unavailable' };
      return {
        ok: true,
        stdout: JSON.stringify({
          summary_one: 'Fallback summary landed.',
          bullets: ['Tried local first', 'Used budget fallback'],
          model: 'sonnet',
          cost_usd: 0.003,
        }),
      };
    });
    const summarizer = new SessionSummarizer({ db, runCommand, publish: jest.fn(), now: () => 222 });

    const result = await summarizer.summarizeNow('s1');

    expect(calls).toEqual([
      ['auto', '--provider', 'ollama', '--json'],
      ['auto', '--budget', '0.005', '--json'],
    ]);
    expect(result).toMatchObject({
      summaryProvider: 'auto-budget',
      summaryModel: 'sonnet',
      summaryCostUsd: 0.003,
    });
  });

  test('summarizeNow surfaces provider failure when both routes fail', async () => {
    insertSession();
    const runCommand: SummaryCommandRunner = jest.fn(async (args) => ({
      ok: false,
      stdout: '',
      stderr: args.includes('ollama') ? 'ollama unavailable' : 'budget route unavailable',
    }));
    const summarizer = new SessionSummarizer({ db, runCommand, publish: jest.fn() });

    await expect(summarizer.summarizeNow('s1')).rejects.toThrow('summary provider failed');
  });

  test('redactPromptForCloud removes high-risk secret shapes', () => {
    const prompt = 'OPENAI_API_KEY=sk-1234567890abcdefghijkl Bearer abcdefghijklmnop ANTHROPIC_AUTH_TOKEN=secret-value';

    expect(redactPromptForCloud(prompt)).toBe('OPENAI_API_KEY=[redacted] Bearer [redacted] ANTHROPIC_AUTH_TOKEN=[redacted]');
  });

  test('default local runner calls Ollama and writes the returned summary JSON', async () => {
    jest.useRealTimers();
    insertSession();
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        response: JSON.stringify({
          summary_one: 'Ollama produced a local summary.',
          bullets: ['Posted to localhost Ollama', 'Parsed model JSON'],
          model: 'llama-test',
          cost_usd: 0,
        }),
      }),
    } as Response);
    const summarizer = new SessionSummarizer({
      db,
      publish: jest.fn(),
      ollamaUrl: 'http://127.0.0.1:11434/api/generate',
      ollamaModel: 'llama-test',
      now: () => 555,
    });

    await expect(summarizer.summarizeNow('s1')).resolves.toMatchObject({
      summaryOne: 'Ollama produced a local summary.',
      summaryProvider: 'ollama',
    });
    expect(fetchSpy).toHaveBeenCalledWith('http://127.0.0.1:11434/api/generate', expect.objectContaining({
      method: 'POST',
      body: expect.stringContaining('llama-test'),
    }));
  });

  test('close resolves queued debounce promises without hanging', async () => {
    insertSession();
    const summarizer = new SessionSummarizer({ db, runCommand: jest.fn(), publish: jest.fn(), debounceMs: 1000 });

    const queued = summarizer.enqueue('s1');
    summarizer.close();

    await expect(queued).resolves.toBeNull();
  });

  test('summary stays stale if messages advanced after the summarized count', async () => {
    insertSession({ messageCount: 55 });
    const runCommand: SummaryCommandRunner = jest.fn(async () => ({
      ok: true,
      stdout: JSON.stringify({
        summary_one: 'Older summary.',
        bullets: ['Covered earlier messages'],
      }),
    }));
    const summarizer = new SessionSummarizer({ db, runCommand, publish: jest.fn(), now: () => 444 });
    await summarizer.summarizeNow('s1');
    db.markActivity('s1', { messageCount: 56 });

    expect(db.byId('s1')).toMatchObject({ summaryMsgAt: 55, summaryStale: true });
  });

  test('summarizeNow skips sessions without jsonl path', async () => {
    insertSession({ jsonlPath: null });
    const runCommand = jest.fn();
    const summarizer = new SessionSummarizer({ db, runCommand, publish: jest.fn() });

    await expect(summarizer.summarizeNow('s1', 'session-end')).resolves.toBeNull();
    expect(runCommand).not.toHaveBeenCalled();
  });

  test('enqueue debounces duplicate summary work', async () => {
    insertSession();
    const runCommand: SummaryCommandRunner = jest.fn(async () => ({
      ok: true,
      stdout: JSON.stringify({
        summary_one: 'Debounced summary.',
        bullets: ['Queued twice', 'Ran once'],
      }),
    }));
    const summarizer = new SessionSummarizer({ db, runCommand, publish: jest.fn(), debounceMs: 100, now: () => 333 });

    const first = summarizer.enqueue('s1');
    const second = summarizer.enqueue('s1');
    jest.advanceTimersByTime(100);
    await Promise.resolve();

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(runCommand).toHaveBeenCalledTimes(1);
  });

  test('session-end trigger refreshes stale low-message sessions', async () => {
    insertSession({ messageCount: 12, summaryMsgAt: 10, summaryStale: true });
    const runCommand: SummaryCommandRunner = jest.fn(async () => ({
      ok: true,
      stdout: JSON.stringify({
        summary_one: 'Closed session summary.',
        bullets: ['Captured final state'],
      }),
    }));
    const summarizer = new SessionSummarizer({ db, runCommand, publish: jest.fn() });

    await expect(summarizer.summarizeNow('s1', 'session-end')).resolves.toMatchObject({
      summaryOne: 'Closed session summary.',
    });
  });
});
