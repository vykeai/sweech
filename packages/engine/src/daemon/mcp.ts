import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import { detectEngines } from '../detect.js';
import { loadProvidersWithCache } from '../providers.js';
import { resolveSelectionTarget, makeRunner } from '../select.js';
import { wrapRunner, costMiddleware, toolTimingMiddleware, mcpMiddleware } from '../middleware/index.js';
import type { RunOptions, EngineId } from '../types.js';
import { getDaemonLifecycleState, startRunSession, endRunSession, getCachedQuotaTracker } from './server.js';

const SERVER_INFO = { name: 'omnai', version: '0.1.0' };

function createMcpServer(): McpServer {
  const server = new McpServer(SERVER_INFO);

  server.registerTool('omnai_status', {
    description: 'Get omnai daemon lifecycle state and active session count.',
    inputSchema: undefined,
  }, async () => {
    const state = getDaemonLifecycleState();
    return { content: [{ type: 'text' as const, text: JSON.stringify(state) }] };
  });

  server.registerTool('omnai_engines', {
    description: 'Detect locally installed AI engines (claude-code, codex, gemini-cli, etc.).',
    inputSchema: undefined,
  }, async () => {
    const engines = await detectEngines();
    return { content: [{ type: 'text' as const, text: JSON.stringify(engines) }] };
  });

  server.registerTool('omnai_accounts', {
    description: 'List provider accounts from providers.yaml with enabled state, models, and failover order.',
    inputSchema: undefined,
  }, async () => {
    try {
      const providers = await loadProvidersWithCache();
      const accounts = Object.entries(providers.accounts)
        .filter(([, acc]) => acc.enabled)
        .map(([id, acc]) => ({
          id,
          provider: acc.provider,
          models: acc.models ?? [],
          type: acc.type,
        }));
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ accounts, failoverOrder: providers.failoverOrder }),
        }],
      };
    } catch {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ accounts: {}, failoverOrder: [] }) }] };
    }
  });

  server.registerTool('omnai_quota', {
    description: 'Get per-account quota usage, cost, and canUse status.',
    inputSchema: undefined,
  }, async () => {
    const tracker = getCachedQuotaTracker();
    if (!tracker) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ accounts: {}, totalCostUsd: 0 }) }] };
    }
    const state = tracker.getState();
    let totalCostUsd = 0;
    const accountUsage: Record<string, unknown> = {};
    for (const [id, usage] of Object.entries(state.accounts)) {
      totalCostUsd += usage.costUsd;
      const status = tracker.getAccountStatus(id);
      accountUsage[id] = {
        ...usage,
        canUse: status.canUse,
        utilizationPct: status.utilizationPct,
        quota: status.quota,
      };
    }
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ accounts: accountUsage, totalCostUsd, lastFlushed: state.lastFlushed }),
      }],
    };
  });

  server.registerTool('omnai_select', {
    description: 'Select the best engine/account for a task without running it.',
    inputSchema: {
      taskType: z.enum(['coding', 'analysis', 'planning', 'review', 'chat', 'research'])
        .optional()
        .describe('Task type to optimise selection for'),
      engine: z.string().optional().describe('Preferred engine id (e.g. claude-code, codex)'),
      provider: z.string().optional().describe('Preferred provider (e.g. claude, codex)'),
      account: z.string().optional().describe('Preferred account id from providers.yaml'),
      capabilities: z.array(z.enum(['vision', 'code', 'reasoning', 'mcp', 'hooks', 'sessions', 'cost', 'streamJson']))
        .optional()
        .describe('Required capabilities — only engines matching ALL capabilities are considered'),
    },
  }, async (args) => {
    try {
      const target = await resolveSelectionTarget({
        taskType: args.taskType as RunOptions['taskType'],
        engine: args.engine as EngineId | undefined,
        provider: args.provider as RunOptions['provider'],
        account: args.account,
        capabilities: args.capabilities as import('../capabilities.js').Capability[] | undefined,
      });
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            engine: target.engine,
            ...(target.account ? { account: target.account } : {}),
            ...(target.provider ? { provider: target.provider } : {}),
            ...(target.fallbackReason ? { fallbackReason: target.fallbackReason } : {}),
          }),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: (err as Error).message }) }],
        isError: true,
      };
    }
  });

  server.registerTool('omnai_run', {
    description: 'Run a prompt through the best available AI engine. Returns final text output.',
    inputSchema: {
      prompt: z.string().min(1).max(500_000).describe('The prompt to execute'),
      taskType: z.enum(['coding', 'analysis', 'planning', 'review', 'chat', 'research'])
        .optional()
        .describe('Task type for engine selection'),
      engine: z.string().optional().describe('Preferred engine id'),
      provider: z.string().optional().describe('Preferred provider'),
      account: z.string().optional().describe('Preferred account id'),
      maxBudgetUsd: z.number().optional().describe('Budget cap in USD'),
      maxTurns: z.number().int().optional().describe('Max agent turns'),
    },
  }, async (args) => {
    const lifecycle = getDaemonLifecycleState();
    if (!lifecycle.ready) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: 'daemon not ready', state: lifecycle.state }) }],
        isError: true,
      };
    }

    let target;
    try {
      target = await resolveSelectionTarget({
        taskType: args.taskType as RunOptions['taskType'],
        engine: args.engine as EngineId | undefined,
        provider: args.provider as RunOptions['provider'],
        account: args.account,
      });
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: (err as Error).message }) }],
        isError: true,
      };
    }

    let runner;
    try {
      runner = makeRunner(target.engine, target.binaryPath);
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: (err as Error).message }) }],
        isError: true,
      };
    }

    const wrappedRunner = wrapRunner(runner, costMiddleware, toolTimingMiddleware, mcpMiddleware);
    const runSession = startRunSession();
    let output = '';
    let costUsd = 0;
    let durationMs = 0;

    try {
      const runOpts: RunOptions = {
        ...target.resolvedOptions,
        provider: target.provider ?? args.provider as RunOptions['provider'],
        account: target.account ?? args.account,
        ...(args.maxBudgetUsd !== undefined ? { maxBudgetUsd: args.maxBudgetUsd } : {}),
        ...(args.maxTurns !== undefined ? { maxTurns: args.maxTurns } : {}),
        abortSignal: runSession.signal,
      };

      for await (const event of wrappedRunner.run(args.prompt, runOpts)) {
        if (event.type === 'result') {
          output = event.output;
          costUsd = event.costUsd;
          durationMs = event.durationMs;
        }
      }
    } catch (err) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ error: (err as Error).message }),
        }],
        isError: true,
      };
    } finally {
      endRunSession(runSession);
    }

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ output: output || '(no output)', costUsd, durationMs }),
      }],
    };
  });

  server.registerResource('omnai://catalog', 'omnai://catalog', {
    description: 'Model catalog: all models available across enabled provider accounts.',
    mimeType: 'application/json',
  }, async () => {
    try {
      const providers = await loadProvidersWithCache();
      const models: string[] = [];
      for (const acc of Object.values(providers.accounts)) {
        if (acc.enabled && acc.models) {
          for (const m of acc.models) {
            if (!models.includes(m)) models.push(m);
          }
        }
      }
      return {
        contents: [{
          uri: 'omnai://catalog',
          mimeType: 'application/json',
          text: JSON.stringify({ models }),
        }],
      };
    } catch {
      return {
        contents: [{
          uri: 'omnai://catalog',
          mimeType: 'application/json',
          text: JSON.stringify({ models: [] }),
        }],
      };
    }
  });

  server.registerResource('omnai://routes', 'omnai://routes', {
    description: 'Active routes: which engine/account is currently selected for each provider.',
    mimeType: 'application/json',
  }, async () => {
    try {
      const providers = await loadProvidersWithCache();
      const routes: Record<string, { engine: string; account: string; type: string }> = {};
      for (const [id, acc] of Object.entries(providers.accounts)) {
        if (acc.enabled) {
          routes[id] = { engine: acc.provider, account: id, type: acc.type ?? 'free-tier' };
        }
      }
      return {
        contents: [{
          uri: 'omnai://routes',
          mimeType: 'application/json',
          text: JSON.stringify({ routes, failoverOrder: providers.failoverOrder }),
        }],
      };
    } catch {
      return {
        contents: [{
          uri: 'omnai://routes',
          mimeType: 'application/json',
          text: JSON.stringify({ routes: {} }),
        }],
      };
    }
  });

  server.registerResource('omnai://usage', 'omnai://usage', {
    description: 'Usage stats: per-account cost, request count, and quota utilization.',
    mimeType: 'application/json',
  }, async () => {
    const tracker = getCachedQuotaTracker();
    if (!tracker) {
      return {
        contents: [{
          uri: 'omnai://usage',
          mimeType: 'application/json',
          text: JSON.stringify({ accounts: {}, totalCostUsd: 0 }),
        }],
      };
    }
    const state = tracker.getState();
    let totalCostUsd = 0;
    const accounts: Record<string, unknown> = {};
    for (const [id, usage] of Object.entries(state.accounts)) {
      totalCostUsd += usage.costUsd;
      const status = tracker.getAccountStatus(id);
      accounts[id] = {
        costUsd: usage.costUsd,
        requestCount: usage.requestCount,
        tokenCount: usage.tokenCount,
        canUse: status.canUse,
        utilizationPct: status.utilizationPct,
      };
    }
    return {
      contents: [{
        uri: 'omnai://usage',
        mimeType: 'application/json',
        text: JSON.stringify({ accounts, totalCostUsd, lastFlushed: state.lastFlushed }),
      }],
    };
  });

  return server;
}

export async function handleMcpRequest(req: Request): Promise<Response> {
  const server = createMcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    await server.close();
  }
}
