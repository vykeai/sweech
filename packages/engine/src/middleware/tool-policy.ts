import { createHash } from 'node:crypto';
import type { RunOptions } from '../types.js';
import type { ToolDecision, ToolIntent, ToolPolicyAuditRecord } from './types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeToolName(name: string): string {
  return name.trim().toLowerCase();
}

function extractCommandText(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  if (typeof input.cmd === 'string') return input.cmd;
  if (typeof input.script === 'string') return input.script;
  if (typeof input.command === 'string' && Array.isArray(input.args)) {
    return [input.command, ...input.args.filter((arg): arg is string => typeof arg === 'string')].join(' ');
  }
  if (typeof input.command === 'string') return input.command;
  if (typeof input.command === 'string' && typeof input.arguments === 'string') {
    return `${input.command} ${input.arguments}`;
  }
  return undefined;
}

function hashValue(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function inferIntent(toolName: string, source: 'tool' | 'mcp', input: unknown): ToolIntent {
  const normalized = normalizeToolName(toolName);
  const command = extractCommandText(input);

  if (source === 'mcp') return 'mcp';
  if (command || /bash|shell|exec|command/.test(normalized)) return 'exec';
  if (/write|edit|patch|apply|create|delete|remove|rename/.test(normalized)) return 'write';
  if (/fetch|web|http|url|browser|request|download/.test(normalized)) return 'network';
  if (/read|search|grep|glob|list|open|view|cat/.test(normalized)) return 'read';
  return 'unknown';
}

function getDangerReason(command: string | undefined): string | null {
  if (!command) return null;
  if (/\b(curl|wget)\b.*\|\s*(sh|bash)\b/i.test(command)) return 'download_exec_chain';
  if (/\b(rm\s+-rf|mkfs|shutdown|reboot|poweroff|dd\s+if=|sudo\b)/i.test(command)) return 'destructive_command';
  if (/(;|&&|\|\||`|\$\(|\n)/.test(command)) return 'dangerous_shell_operator';
  return null;
}

export interface ToolPolicyEvaluation {
  decision: ToolDecision;
  audit: ToolPolicyAuditRecord;
}

export function applyToolPolicyToOptions(opts: RunOptions): RunOptions {
  const denyTools = new Set([
    ...(opts.disallowedTools ?? []),
    ...(opts.toolPolicy?.denyTools ?? []),
  ]);

  if (denyTools.size === 0) return opts;

  return {
    ...opts,
    disallowedTools: Array.from(denyTools),
  };
}

export function evaluateToolPolicy(options: {
  toolName: string;
  input: unknown;
  opts: RunOptions;
  actor: string;
  target: string;
  source: 'tool' | 'mcp';
}): ToolPolicyEvaluation {
  const policy = options.opts.toolPolicy;
  const normalizedToolName = normalizeToolName(options.toolName);
  const explicitAllow = new Set([
    ...(options.opts.allowedTools ?? []).map(normalizeToolName),
    ...(policy?.allowTools ?? []).map(normalizeToolName),
  ]);
  const explicitDeny = new Set([
    ...(options.opts.disallowedTools ?? []).map(normalizeToolName),
    ...(policy?.denyTools ?? []).map(normalizeToolName),
  ]);
  const intent = inferIntent(options.toolName, options.source, options.input);
  const command = extractCommandText(options.input);
  const dangerReason = getDangerReason(command);

  let decision: ToolDecision = 'allow';
  let reasonCode = 'allowed';
  let requiresApproval = false;

  if (explicitDeny.has(normalizedToolName)) {
    decision = 'deny';
    reasonCode = 'tool_explicitly_denied';
  } else if (options.opts.allowedTools !== undefined && !explicitAllow.has(normalizedToolName)) {
    decision = 'deny';
    reasonCode = 'tool_not_in_allowlist';
  } else if (dangerReason && !policy?.allowHighRisk && !explicitAllow.has(normalizedToolName)) {
    decision = 'deny';
    reasonCode = dangerReason;
    requiresApproval = true;
  } else if (intent === 'unknown' && !explicitAllow.has(normalizedToolName)) {
    decision = 'deny';
    reasonCode = 'unknown_intent_denied';
    requiresApproval = true;
  } else if (explicitAllow.has(normalizedToolName)) {
    reasonCode = 'allowed_by_explicit_allow';
  } else if (intent === 'exec' || intent === 'mcp') {
    reasonCode = policy?.allowHighRisk ? 'allowed_high_risk_override' : 'allowed_observed_exec';
  } else {
    reasonCode = `allowed_${intent}`;
  }

  const commandHashSource = command ?? JSON.stringify(options.input ?? {});
  const audit: ToolPolicyAuditRecord = {
    policyId: policy?.policyId ?? 'default-tool-policy',
    actor: policy?.actor ?? options.actor,
    target: options.target,
    toolName: options.toolName,
    intent,
    decision,
    reasonCode,
    commandHash: hashValue(commandHashSource),
    requiresApproval,
  };

  policy?.auditSink?.(audit);

  return { decision, audit };
}

export function classifyToolIntent(toolName: string, source: 'tool' | 'mcp', input: unknown): ToolIntent {
  return inferIntent(toolName, source, input);
}
