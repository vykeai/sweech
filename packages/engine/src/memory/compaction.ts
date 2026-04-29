import type { ModelRunner, AgentEvent, RunOptions } from '../types.js';
import type { ConversationStore, ChatMessage } from './types.js';

export interface CompactionOptions {
  /**
   * Trigger compaction when message count exceeds this threshold.
   * Defaults to 20 turns (40 messages).
   */
  maxMessages?: number;

  /**
   * How many recent messages to keep verbatim after compaction.
   * The rest are replaced with a summary. Defaults to 6.
   */
  keepRecent?: number;

  /**
   * The runner to use for summarisation. Defaults to the same runner
   * as the main conversation — pass a lighter/cheaper runner if desired.
   *
   * Must be a ModelRunner (any engine — not claude-code specific).
   */
  summaryRunner?: ModelRunner;

  /**
   * Custom prompt used to generate the summary.
   * Receives the conversation text; should return a compact markdown summary.
   */
  summaryPrompt?: (conversation: string) => string;

  /**
   * Called when compaction fires, with the before/after message counts.
   * Useful for logging or UI feedback.
   */
  onCompact?: (before: number, after: number) => void;
}

const DEFAULT_SUMMARY_PROMPT = (conversation: string) => `\
Summarise the following conversation into a compact set of bullet points.
Capture: key facts established, decisions made, user preferences stated, \
important context the assistant should remember. Be concise — this summary \
replaces the conversation history.

<conversation>
${conversation}
</conversation>

Respond with only the bullet-point summary, no preamble.`;

/**
 * Automatically compacts conversation history when it grows too long.
 *
 * Works with any engine — provider-agnostic. Compaction runs a separate
 * summarisation call (using summaryRunner, or the main runner) to collapse
 * old turns into a compact markdown summary, then replaces those messages
 * in the ConversationStore.
 *
 * Stack order: place AFTER conversationMiddleware so it sees the loaded history.
 *
 * @example
 * const runner = wrapRunner(
 *   await select(),
 *   conversationMiddleware(convStore, sessionId),
 *   compactionMiddleware(convStore, sessionId, {
 *     maxMessages: 20,
 *     keepRecent: 6,
 *     summaryRunner: await select({ provider: 'gemini' }), // cheap summariser
 *   }),
 * )
 */
export function compactionMiddleware(
  store: ConversationStore,
  sessionId: string,
  opts: CompactionOptions = {},
): (runner: ModelRunner) => ModelRunner {
  const maxMessages = opts.maxMessages ?? 40;
  const keepRecent = opts.keepRecent ?? 6;
  const buildPrompt = opts.summaryPrompt ?? DEFAULT_SUMMARY_PROMPT;

  return (runner) => ({
    engine: runner.engine,
    isAvailable: () => runner.isAvailable(),
    async *run(prompt: string, runOpts: RunOptions): AsyncGenerator<AgentEvent> {
      // Check if compaction is needed before this turn
      const history = await store.load(sessionId);

      if (history.length >= maxMessages) {
        const toSummarise = history.slice(0, history.length - keepRecent);
        const recent = history.slice(history.length - keepRecent);

        // Build conversation text for summarisation
        const conversation = toSummarise
          .map(m => `${m.role === 'user' ? 'Human' : 'Assistant'}: ${m.content}`)
          .join('\n\n');

        // Run summarisation — use summaryRunner if provided, else main runner
        const summaryRunner = opts.summaryRunner ?? runner;
        let summary = '';
        try {
          for await (const event of summaryRunner.run(buildPrompt(conversation), {
            // Use a fast/cheap config for the summary call
            model: runOpts.model,
            permissionMode: 'bypass',
            maxTurns: 1,
          })) {
            if (event.type === 'text') summary += event.content;
            if (event.type === 'result' && !summary) summary = event.output;
          }
        } catch {
          // Compaction failure is non-fatal — continue with uncompacted history
          summary = '';
        }

        if (summary) {
          // Replace old turns with a summary message pair
          const compacted: ChatMessage[] = [
            {
              role: 'user',
              content: '[Earlier conversation — compacted]',
              ts: new Date().toISOString(),
            },
            {
              role: 'assistant',
              content: `**Summary of earlier conversation:**\n\n${summary.trim()}`,
              ts: new Date().toISOString(),
            },
            ...recent,
          ];
          await store.save(sessionId, compacted);
          opts.onCompact?.(history.length, compacted.length);
        }
      }

      // Yield the main run unchanged — conversationMiddleware handles history prepend
      yield* runner.run(prompt, runOpts);
    },
  });
}
