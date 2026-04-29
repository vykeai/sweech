import type { ModelRunner, AgentEvent, RunOptions, TokenUsage } from './types.js';

export type ParallelStrategy = 'race' | 'cheapest' | 'consensus';

interface RunResult {
  events: AgentEvent[];
  output: string;
  costUsd: number;
  usage: TokenUsage;
  durationMs: number;
  sessionId?: string;
  engine: string;
}

function childController(parent?: AbortSignal): AbortController {
  const ctrl = new AbortController();
  if (parent) {
    if (parent.aborted) ctrl.abort(parent.reason);
    else parent.addEventListener('abort', () => ctrl.abort(parent.reason), { once: true });
  }
  return ctrl;
}

async function drainToResult(
  runner: ModelRunner,
  prompt: string,
  opts: RunOptions,
): Promise<RunResult> {
  const events: AgentEvent[] = [];
  let output = '';
  let costUsd = 0;
  let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  let durationMs = 0;
  let sessionId: string | undefined;

  let completed = false;
  try {
    for await (const event of runner.run(prompt, opts)) {
      events.push(event);
      if (event.type === 'result') {
        output = event.output;
        costUsd = event.costUsd;
        usage = event.usage;
        durationMs = event.durationMs;
        sessionId = event.sessionId;
        completed = true;
        break;
      }
      if (event.type === 'error') {
        throw new Error(event.message);
      }
    }
  } catch (err) {
    // Swallow only abort-cancellation; re-throw real runner failures
    const isAbort = opts.abortSignal?.aborted ||
      (err instanceof Error && (err.name === 'AbortError' || err.message.includes('race-cancelled') || err.message.includes('daemon-shutdown')));
    if (!isAbort) throw err;
  }
  if (!completed && !opts.abortSignal?.aborted) {
    throw new Error(`runner ${runner.engine} did not produce a result event`);
  }

  return { events, output, costUsd, usage, durationMs, sessionId, engine: runner.engine };
}

export async function* runParallel(
  runners: ModelRunner[],
  prompt: string,
  opts: RunOptions,
  strategy: ParallelStrategy,
): AsyncGenerator<AgentEvent> {
  if (runners.length === 0) throw new Error('runParallel requires at least one runner');
  if (runners.length === 1) { yield* runners[0].run(prompt, opts); return; }

  switch (strategy) {
    case 'race':      yield* raceStrategy(runners, prompt, opts);      return;
    case 'cheapest':  yield* cheapestStrategy(runners, prompt, opts);  return;
    case 'consensus': yield* consensusStrategy(runners, prompt, opts); return;
  }
}

async function* raceStrategy(
  runners: ModelRunner[],
  prompt: string,
  opts: RunOptions,
): AsyncGenerator<AgentEvent> {
  const controllers = runners.map(() => childController(opts.abortSignal));

  const indexed = runners.map((runner, i) =>
    drainToResult(runner, prompt, { ...opts, abortSignal: controllers[i].signal }).then((r) => ({
      ...r,
      index: i,
    })),
  );

  const winner = await Promise.race(indexed);

  for (let i = 0; i < controllers.length; i++) {
    if (i !== winner.index && !controllers[i].signal.aborted) {
      controllers[i].abort('race-cancelled');
    }
  }

  for (const event of winner.events) {
    if (event.type === 'result') {
      yield { type: 'text', content: `[parallel:race] winner=${winner.engine} runners=${runners.length}` };
    }
    yield event;
  }
}

async function* cheapestStrategy(
  runners: ModelRunner[],
  prompt: string,
  opts: RunOptions,
): AsyncGenerator<AgentEvent> {
  const settled = await Promise.allSettled(
    runners.map((runner) => drainToResult(runner, prompt, opts)),
  );

  const fulfilled = settled
    .filter((r): r is PromiseFulfilledResult<RunResult> => r.status === 'fulfilled')
    .map((r) => r.value);

  if (fulfilled.length === 0) {
    yield { type: 'error', message: 'All parallel runners failed (cheapest strategy)' };
    return;
  }

  const winner = fulfilled.reduce((a, b) => (b.costUsd < a.costUsd ? b : a));

  for (const event of winner.events) {
    if (event.type === 'result') {
      yield {
        type: 'text',
        content: `[parallel:cheapest] winner=${winner.engine} cost=$${winner.costUsd.toFixed(6)} runners=${runners.length}`,
      };
    }
    yield event;
  }
}

async function* consensusStrategy(
  runners: ModelRunner[],
  prompt: string,
  opts: RunOptions,
): AsyncGenerator<AgentEvent> {
  const settled = await Promise.allSettled(
    runners.map((runner) => drainToResult(runner, prompt, opts)),
  );

  const fulfilled = settled
    .filter((r): r is PromiseFulfilledResult<RunResult> => r.status === 'fulfilled')
    .map((r) => r.value);

  if (fulfilled.length === 0) {
    yield { type: 'error', message: 'All parallel runners failed (consensus strategy)' };
    return;
  }

  const counts = new Map<string, number>();
  for (const r of fulfilled) counts.set(r.output, (counts.get(r.output) ?? 0) + 1);

  let maxCount = 0;
  let consensusOutput = fulfilled[0].output;
  for (const [output, count] of counts) {
    if (count > maxCount) { maxCount = count; consensusOutput = output; }
  }

  const winner = fulfilled.find((r) => r.output === consensusOutput) ?? fulfilled[0];

  for (const event of winner.events) {
    if (event.type === 'result') {
      yield {
        type: 'text',
        content: `[parallel:consensus] agreement=${maxCount}/${fulfilled.length} engine=${winner.engine}`,
      };
    }
    yield event;
  }
}
