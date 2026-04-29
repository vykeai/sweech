import type { AgentEvent, RunOptions, ModelRunner } from '../types.js';
import type { Middleware, ToolPolicyAuditRecord } from './types.js';
import { applyToolPolicyToOptions, evaluateToolPolicy } from './tool-policy.js';

type ToolEventWithIds = AgentEvent & {
  name: string;
  toolCallId?: string;
  tool_call_id?: string;
  toolUseId?: string;
  tool_use_id?: string;
  id?: string;
};

function getToolCallKey(event: ToolEventWithIds): string {
  return (
    event.toolCallId ??
    event.tool_call_id ??
    event.toolUseId ??
    event.tool_use_id ??
    event.id ??
    ''
  );
}

export type NormalizedToolEvent = AgentEvent & {
  startedAt?: number;
  durationMs?: number;
  policyAudit?: ToolPolicyAuditRecord;
};

export const toolTimingMiddleware: Middleware = async function* (runner, prompt, opts, next) {
  const pending = new Map<string, number>();
  const pendingAudit = new Map<string, ToolPolicyAuditRecord>();
  const blocked = new Set<string>();
  const pendingNames = new Map<string, string[]>();
  const syntheticCounters = new Map<string, number>();
  const normalizedOpts = applyToolPolicyToOptions(opts);

  const makeAnonymousKey = (name: string) => {
    const next = (syntheticCounters.get(name) ?? 0) + 1;
    syntheticCounters.set(name, next);
    return `${name}:anon:${next}`;
  };

  const enqueueAnonymous = (name: string, key: string) => {
    const queue = pendingNames.get(name) ?? [];
    queue.push(key);
    pendingNames.set(name, queue);
  };

  const popAnonymous = (name: string): string | undefined => {
    const queue = pendingNames.get(name);
    if (!queue || queue.length === 0) return undefined;
    const key = queue.shift();
    if (queue.length === 0) {
      pendingNames.delete(name);
    }
    return key;
  };

  for await (const event of next(prompt, normalizedOpts)) {
    if (event.type === 'tool_use') {
      const rawEvent = event as ToolEventWithIds;
      const callId = getToolCallKey(rawEvent);
      const key = callId ? `${event.name}:${callId}` : makeAnonymousKey(event.name);

      if (!callId) {
        enqueueAnonymous(event.name, key);
      }

      const startedAt = Date.now();
      pending.set(key, startedAt);
      const decision = evaluateToolPolicy({
        toolName: event.name,
        input: event.input,
        opts: normalizedOpts,
        actor: runner.engine,
        target: event.name,
        source: 'tool',
      });
      pendingAudit.set(key, decision.audit);

      if (decision.decision === 'deny') {
        blocked.add(key);
        yield {
          type: 'error',
          code: 'tool_policy_denied',
          message: `Tool "${event.name}" blocked by policy: ${decision.audit.reasonCode}`,
          policyAudit: decision.audit,
        } as AgentEvent;
        continue;
      }

      yield { ...event, startedAt, policyAudit: decision.audit } as AgentEvent;
    } else if (event.type === 'tool_result') {
      const rawEvent = event as ToolEventWithIds;
      const callId = getToolCallKey(rawEvent);
      const key = callId ? `${event.name}:${callId}` : popAnonymous(event.name);
      const startedAt = key ? pending.get(key) : undefined;
      const policyAudit = key ? pendingAudit.get(key) : undefined;

      if (key) {
        pending.delete(key);
        pendingAudit.delete(key);
      }
      if (key && blocked.has(key)) {
        blocked.delete(key);
        continue;
      }
      const durationMs = startedAt ? Date.now() - startedAt : undefined;
      yield { ...event, startedAt, durationMs, policyAudit } as AgentEvent;
    } else {
      yield event;
    }
  }
};

export const toolValidationMiddleware = toolTimingMiddleware;
