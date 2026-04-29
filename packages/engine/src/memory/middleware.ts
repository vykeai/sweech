import type { ModelRunner, AgentEvent, RunOptions } from '../types.js';
import type { ConversationStore, AgentMemoryStore } from './types.js';

// ── conversationMiddleware ────────────────────────────────────────────────────

/**
 * Manages conversation history around each runner invocation.
 *
 * - Before run: loads history from the store and prepends it to the prompt
 *   as Human/Assistant turns. Skipped if `resumeSessionId` or `continueSession`
 *   is set (those engines handle history natively).
 * - After run: saves the new [user, assistant] turn back to the store.
 *
 * @example
 * const runner = wrapRunner(
 *   await select({ provider: 'claude' }),
 *   conversationMiddleware(new FileConversationStore('~/.myapp/sessions'), sessionId),
 * )
 */
export function conversationMiddleware(
  store: ConversationStore,
  sessionId: string,
): (runner: ModelRunner) => ModelRunner {
  return (runner) => ({
    engine: runner.engine,
    isAvailable: () => runner.isAvailable(),
    async *run(prompt: string, opts: RunOptions): AsyncGenerator<AgentEvent> {
      const history = await store.load(sessionId);

      // Build the full prompt — prepend history unless the engine handles sessions natively
      let fullPrompt = prompt;
      if (history.length > 0 && !opts.resumeSessionId && !opts.continueSession) {
        const turns = history
          .map(m => `${m.role === 'user' ? 'Human' : 'Assistant'}: ${m.content}`)
          .join('\n\n');
        fullPrompt = `${turns}\n\nHuman: ${prompt}`;
      }

      // Run and collect assistant text
      let assistantText = '';
      for await (const event of runner.run(fullPrompt, opts)) {
        if (event.type === 'text') assistantText += event.content;
        if (event.type === 'result' && !assistantText) assistantText = event.output;
        yield event;
      }

      // Persist the new turn
      const ts = new Date().toISOString();
      await store.save(sessionId, [
        ...history,
        { role: 'user', content: prompt, ts },
        { role: 'assistant', content: assistantText, ts },
      ]);
    },
  });
}

// ── memoryMiddleware ──────────────────────────────────────────────────────────

export interface MemoryMiddlewareOptions {
  /**
   * Called after the run completes with the agent's final output.
   * Return a string to append to the memory store, or null to skip.
   *
   * @example
   * autoAppend: (output) => output.includes('decision:')
   *   ? `Decision recorded: ${output.slice(0, 200)}`
   *   : null
   */
  autoAppend?: (output: string) => string | null;
}

/**
 * Injects persistent agent memory into the system prompt before each run.
 *
 * - Before run: reads the agent's markdown memory blob and appends it to
 *   `runOptions.systemPrompt` inside `<memory>` tags.
 * - After run: if `opts.autoAppend` returns a string, appends it to the store.
 *
 * @example
 * const runner = wrapRunner(
 *   await select({ provider: 'claude' }),
 *   memoryMiddleware(new FileAgentMemoryStore('~/.myapp/memory'), 'twin', {
 *     autoAppend: (output) => extractInsight(output),
 *   }),
 * )
 */
export function memoryMiddleware(
  store: AgentMemoryStore,
  agentId: string,
  opts: MemoryMiddlewareOptions = {},
): (runner: ModelRunner) => ModelRunner {
  return (runner) => ({
    engine: runner.engine,
    isAvailable: () => runner.isAvailable(),
    async *run(prompt: string, runOpts: RunOptions): AsyncGenerator<AgentEvent> {
      // Load memory and inject into system prompt
      const memoryBlob = await store.read(agentId);
      const enrichedOpts: RunOptions = memoryBlob
        ? {
            ...runOpts,
            systemPrompt: runOpts.systemPrompt
              ? `${runOpts.systemPrompt}\n\n<memory>\n${memoryBlob}\n</memory>`
              : `<memory>\n${memoryBlob}\n</memory>`,
          }
        : runOpts;

      // Run and collect final output for autoAppend
      let resultOutput = '';
      for await (const event of runner.run(prompt, enrichedOpts)) {
        if (event.type === 'result') resultOutput = event.output;
        yield event;
      }

      // Optionally append new insight
      if (opts.autoAppend && resultOutput) {
        const insight = opts.autoAppend(resultOutput);
        if (insight) await store.append(agentId, insight);
      }
    },
  });
}
