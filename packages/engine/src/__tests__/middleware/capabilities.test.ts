import { describe, it, expect } from 'vitest';
import { getCapabilities, CAPABILITIES } from '../../capabilities.js';

describe('capabilities', () => {
  it('claude-code has all capabilities', () => {
    const caps = getCapabilities('claude-code');
    expect(caps.mcp).toBe(true);
    expect(caps.hooks).toBe(true);
    expect(caps.sessions).toBe(true);
    expect(caps.cost).toBe(true);
  });

  it('amazon-q has no capabilities', () => {
    const caps = getCapabilities('amazon-q');
    expect(caps.mcp).toBe(false);
    expect(caps.hooks).toBe(false);
    expect(caps.sessions).toBe(false);
    expect(caps.streamJson).toBe(false);
  });

  it('covers all 10 engines', () => {
    expect(Object.keys(CAPABILITIES)).toHaveLength(10);
  });

  it('copilot has mcp and sessions', () => {
    const caps = getCapabilities('copilot');
    expect(caps.mcp).toBe(true);
    expect(caps.sessions).toBe(true);
    expect(caps.streamJson).toBe(true);
    expect(caps.hooks).toBe(false);
  });
});
