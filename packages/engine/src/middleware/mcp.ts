import type { AgentEvent, RunOptions, ModelRunner } from '../types.js';
import { getCapabilities } from '../capabilities.js';
import type { Middleware } from './types.js';
import { evaluateToolPolicy } from './tool-policy.js';

export const mcpMiddleware: Middleware = async function* (runner, prompt, opts, next) {
  if (!opts.mcpServers || Object.keys(opts.mcpServers).length === 0) {
    yield* next(prompt, opts);
    return;
  }

  const validatedServers: NonNullable<RunOptions['mcpServers']> = {};
  for (const [name, config] of Object.entries(opts.mcpServers)) {
    const decision = evaluateToolPolicy({
      toolName: name,
      input: { command: config.command, args: config.args, env: config.env },
      opts,
      actor: runner.engine,
      target: name,
      source: 'mcp',
    });
    if (decision.decision === 'deny') {
      yield {
        type: 'error',
        code: 'mcp_policy_denied',
        message: `MCP server "${name}" blocked by policy: ${decision.audit.reasonCode}`,
        policyAudit: decision.audit,
      } as AgentEvent;
      continue;
    }
    validatedServers[name] = config;
  }

  if (Object.keys(validatedServers).length === 0) {
    const { mcpServers: _, ...cleanOpts } = opts;
    yield* next(prompt, cleanOpts);
    return;
  }

  const caps = getCapabilities(runner.engine);
  const nextOpts = { ...opts, mcpServers: validatedServers };

  if (caps.mcp) {
    // Native MCP support — pass through
    yield* next(prompt, nextOpts);
    return;
  }

  // No MCP support — warn and strip
  yield { type: 'error', message: `Engine "${runner.engine}" does not support MCP servers. MCP config ignored.` } as AgentEvent;
  const { mcpServers: _, ...cleanOpts } = nextOpts;
  yield* next(prompt, cleanOpts);
};
