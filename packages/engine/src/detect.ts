import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { EngineStatus, OmnaiConfig } from './types.js';

const execFileAsync = promisify(execFile);

async function findBinary(name: string, fallbacks: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('which', [name]);
    const p = stdout.trim();
    if (p) return p;
  } catch {}
  for (const fb of fallbacks) {
    try { await access(fb); return fb; } catch {}
  }
  return undefined;
}

export async function detectEngines(config: OmnaiConfig = {}): Promise<EngineStatus[]> {
  const home = homedir();

  const [claudePath, qwenPath, geminiPath, amazonQPath, piPath, opencodePath, goosePath, codexPath, copilotPath] = await Promise.all([
    config.claudeBinaryPath
      ? Promise.resolve(config.claudeBinaryPath)
      : findBinary('claude', [
          join(home, 'dev', 'claude-code', 'cli', 'claude'),
          join(home, '.local', 'bin', 'claude'),
          '/usr/local/bin/claude',
        ]),
    findBinary('qwen', [
      join(home, '.local', 'bin', 'qwen'),
      '/opt/homebrew/bin/qwen',
    ]),
    findBinary('gemini', [
      join(home, '.local', 'bin', 'gemini'),
      '/opt/homebrew/bin/gemini',
      '/usr/local/bin/gemini',
    ]),
    findBinary('q', [
      join(home, '.local', 'bin', 'q'),
      '/usr/local/bin/q',
      '/opt/homebrew/bin/q',
    ]),
    config.piMonoBinaryPath
      ? Promise.resolve(config.piMonoBinaryPath)
      : findBinary('pi', [
          join(home, 'dev', 'pi-mono', 'pi'),
          join(home, 'dev', 'pi-mono', 'dist', 'pi'),
          join(home, '.local', 'bin', 'pi'),
        ]),
    findBinary('opencode', [
      join(home, '.opencode', 'bin', 'opencode'),
      join(home, '.local', 'bin', 'opencode'),
    ]),
    findBinary('goose', [
      join(home, '.local', 'bin', 'goose'),
      '/usr/local/bin/goose',
    ]),
    findBinary('codex', [
      join(home, '.local', 'bin', 'codex'),
      '/usr/local/bin/codex',
    ]),
    findBinary('copilot', [
      join(home, '.local', 'bin', 'copilot'),
      '/usr/local/bin/copilot',
    ]),
  ]);

  return [
    {
      engine: 'http',
      available: true,
      binaryPath: '',
      providers: ['openai', 'anthropic', 'ollama', 'openrouter', 'deepseek', 'groq', 'cerebras', 'xai', 'mistral', 'dashscope'],
    },
    {
      engine: 'claude-code',
      available: !!claudePath,
      binaryPath: claudePath,
      providers: ['claude'],
    },
    {
      engine: 'qwen-code',
      available: !!qwenPath,
      binaryPath: qwenPath,
      providers: ['qwen'],
    },
    {
      engine: 'gemini-cli',
      available: !!geminiPath,
      binaryPath: geminiPath,
      providers: ['gemini'],
    },
    {
      engine: 'amazon-q',
      available: !!amazonQPath,
      binaryPath: amazonQPath,
      providers: ['amazon-q'],
    },
    {
      engine: 'pi-mono',
      available: !!piPath,
      binaryPath: piPath,
      providers: ['anthropic', 'openai', 'google', 'ollama', 'openrouter', 'deepseek',
                  'groq', 'cerebras', 'xai', 'mistral', 'minimax', 'kimi', 'zai', 'azure', 'bedrock', 'vercel',
                  'dashscope'],
    },
    {
      engine: 'opencode',
      available: !!opencodePath,
      binaryPath: opencodePath,
      providers: ['anthropic', 'openai', 'google'],
    },
    {
      engine: 'goose',
      available: !!goosePath,
      binaryPath: goosePath,
      providers: ['anthropic', 'openai', 'google', 'ollama'],
    },
    {
      engine: 'codex',
      available: !!codexPath,
      binaryPath: codexPath,
      providers: ['codex'],
    },
    {
      engine: 'copilot',
      available: !!copilotPath,
      binaryPath: copilotPath,
      providers: ['anthropic', 'openai', 'google'],
    },
  ];
}
