import type { AgentEvent, HookEntry, FnHook } from '../types.js';
import { getCapabilities } from '../capabilities.js';
import type { Middleware } from './types.js';

const DEFAULT_HOOK_TIMEOUT_MS = 30_000;
const RECOVERABLE_HOOK_ERROR_CODES = new Set(['hook_timeout', 'hook_skip']);

type HookEventName = 'PreToolUse' | 'PostToolUse' | 'Stop';
type HookExecutionId = `${HookEventName}:${string}:${number}`;

interface HookContext {
  toolName?: string;
  sessionId?: string;
  payload: Record<string, unknown>;
  signal: AbortSignal;
}

interface NormalizedHookError {
  code: string;
  message: string;
  recoverable: boolean;
}

interface HookExecutionResult {
  events: AgentEvent[];
  fatal?: AgentEvent;
}

function makeHookError(
  hookEvent: HookEventName,
  hookId: HookExecutionId,
  context: HookContext,
  code: string,
  message: string,
  recoverable: boolean,
): AgentEvent {
  return {
    type: 'hook_error',
    hookEvent,
    hookId,
    code,
    message,
    recoverable,
    toolName: context.toolName,
    sessionId: context.sessionId,
  };
}

function toErrorCode(error: unknown): string {
  if (error && typeof error === 'object') {
    if ('code' in error && typeof error.code === 'string' && error.code.length > 0) {
      return error.code;
    }
    if ('name' in error && typeof error.name === 'string' && error.name.length > 0) {
      return error.name;
    }
  }
  return 'hook_execution_error';
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error && typeof (error as Record<string, unknown>).message === 'string') {
    return (error as Record<string, unknown>).message as string;
  }
  return 'Hook execution failed';
}

function normalizeHookErrorCode(code: string): string {
  return code.toLowerCase();
}

function classifyHookError(error: unknown): NormalizedHookError {
  const code = normalizeHookErrorCode(toErrorCode(error));
  const message = toErrorMessage(error);
  return {
    code,
    message,
    recoverable: RECOVERABLE_HOOK_ERROR_CODES.has(code),
  };
}

async function withHookTimeout<T>(task: () => Promise<T>, timeoutMs: number, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    throw signal.reason ?? { code: 'abort', message: 'Hook execution aborted' };
  }

  let timer: NodeJS.Timeout | undefined;
  let abortHandler: (() => void) | undefined;
  try {
    return await Promise.race([
      task(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject({ code: 'hook_timeout', message: 'Hook execution timed out' }), timeoutMs);
      }),
      new Promise<T>((_, reject) => {
        abortHandler = () => {
          reject(signal.reason ?? { code: 'abort', message: 'Hook execution aborted' });
        };
        signal.addEventListener('abort', abortHandler, { once: true });
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (abortHandler) signal.removeEventListener('abort', abortHandler);
  }
}

export const hooksMiddleware: Middleware = async function* (runner, prompt, opts, next) {
  let hookQueue = Promise.resolve<void>(undefined);
  const caps = getCapabilities(runner.engine);
  const queueHookWork = (work: () => Promise<HookExecutionResult>) => {
    // Enforce max-in-flight hooks = 1 for deterministic ordering and bounded concurrency.
    const next = hookQueue.then(() => work());
    hookQueue = next.then(() => undefined, () => undefined);
    return next;
  };

  // Native hook support — pass through
  if (caps.hooks || !opts.hooks) {
    yield* next(prompt, opts);
    return;
  }

  const preToolUse = opts.hooks.PreToolUse ?? [];
  const postToolUse = opts.hooks.PostToolUse ?? [];
  const stop = opts.hooks.Stop ?? [];
  const hookTimeout = DEFAULT_HOOK_TIMEOUT_MS;
  const hookSignal = opts.abortSignal ?? new AbortController().signal;

  const executeHooks = async (
    hookEvent: HookEventName,
    hooks: Array<{ matcher: string; hooks: Array<HookEntry | FnHook> }>,
    matchValue: string,
    context: HookContext,
  ): Promise<HookExecutionResult> => {
    const errors: AgentEvent[] = [];
    let fatal: AgentEvent | undefined;
    for (const matcher of hooks) {
      if (matcher.matcher !== '*' && matcher.matcher !== matchValue) continue;
      for (const [hookIndex, hook] of matcher.hooks.entries()) {
        if (typeof hook !== 'function') {
          continue;
        }
        const fnHook = hook as FnHook;
        const hookId = `${hookEvent}:${matcher.matcher}:${hookIndex}` as HookExecutionId;
        try {
          await withHookTimeout(() => fnHook(context.payload, context.toolName, { signal: context.signal }), hookTimeout, context.signal);
        } catch (error) {
          const normalized = classifyHookError(error);
          const hookError = makeHookError(hookEvent, hookId, context, normalized.code, normalized.message, normalized.recoverable);
          errors.push(hookError);
          if (!normalized.recoverable) {
            fatal = hookError;
          }
        }
      }
    }
    return { events: errors, ...(fatal ? { fatal } : {}) };
  };

  for await (const event of next(prompt, opts)) {
    // PreToolUse hooks for stream-json engines
    if (event.type === 'tool_use' && caps.streamJson && preToolUse.length > 0) {
      const hookExecution = await queueHookWork(() => executeHooks(
        'PreToolUse',
        preToolUse,
        event.name,
        {
          toolName: event.name,
          payload: { tool_name: event.name, tool_input: event.input },
          signal: hookSignal,
        },
      ));
      for (const hookEvent of hookExecution.events) {
        yield hookEvent;
      }
      if (hookExecution.fatal) throw hookExecution.fatal;
    }

    // PostToolUse hooks
    if (event.type === 'tool_result' && caps.streamJson && postToolUse.length > 0) {
      const hookExecution = await queueHookWork(() => executeHooks(
        'PostToolUse',
        postToolUse,
        event.name,
        {
          toolName: event.name,
          payload: { tool_name: event.name, tool_result: event.content },
          signal: hookSignal,
        },
      ));
      for (const hookEvent of hookExecution.events) {
        yield hookEvent;
      }
      if (hookExecution.fatal) throw hookExecution.fatal;
    }

    yield event;

    // Stop hooks on result
    if (event.type === 'result' && stop.length > 0) {
      const hookExecution = await queueHookWork(() => executeHooks(
        'Stop',
        stop,
        'Stop',
        {
          payload: { output: event.output },
          signal: hookSignal,
        },
      ));
      for (const hookEvent of hookExecution.events) {
        yield hookEvent;
      }
      if (hookExecution.fatal) throw hookExecution.fatal;
    }
  }
};
