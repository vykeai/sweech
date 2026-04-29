import type { EngineId } from './types.js';

export type Capability = 'vision' | 'code' | 'reasoning' | 'mcp' | 'hooks' | 'sessions' | 'cost' | 'streamJson';

export interface EngineCapabilities {
  mcp: boolean;
  hooks: boolean;
  sessions: boolean;
  cost: boolean;
  streamJson: boolean;
  vision: boolean;
  code: boolean;
  reasoning: boolean;
}

export const CAPABILITIES: Record<EngineId, EngineCapabilities> = {
  'claude-code': { mcp: true,  hooks: true,  sessions: true,  cost: true,  streamJson: true,  vision: true,  code: true,  reasoning: true  },
  'qwen-code':   { mcp: false, hooks: false, sessions: false, cost: false, streamJson: true,  vision: false, code: true,  reasoning: false },
  'gemini-cli':  { mcp: true,  hooks: false, sessions: false, cost: false, streamJson: true,  vision: true,  code: true,  reasoning: true  },
  'amazon-q':    { mcp: false, hooks: false, sessions: false, cost: false, streamJson: false, vision: false, code: true,  reasoning: false },
  'pi-mono':     { mcp: false, hooks: false, sessions: true,  cost: true,  streamJson: false, vision: true,  code: true,  reasoning: false },
  'opencode':    { mcp: false, hooks: false, sessions: true,  cost: false, streamJson: false, vision: true,  code: true,  reasoning: false },
  'goose':       { mcp: false, hooks: false, sessions: false, cost: false, streamJson: true,  vision: true,  code: true,  reasoning: false },
  'codex':       { mcp: false, hooks: false, sessions: true,  cost: false, streamJson: false, vision: false, code: true,  reasoning: false },
  'copilot':     { mcp: true,  hooks: false, sessions: true,  cost: false, streamJson: true,  vision: true,  code: true,  reasoning: false },
  'http':        { mcp: false, hooks: false, sessions: false, cost: false, streamJson: true,  vision: false, code: false, reasoning: false },
};

export function getCapabilities(engine: EngineId): EngineCapabilities {
  return CAPABILITIES[engine];
}
