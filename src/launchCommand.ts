/**
 * Pure helpers for `sweech launch` — extracted for testability.
 */

export interface LaunchCommandOpts {
  yolo?: boolean;
  resume?: boolean;
  /** Commander sets this to false when --no-tmux is passed */
  tmux?: boolean;
}

/**
 * Build the arg list to pass to the underlying CLI.
 * Sweech-level flags (--yolo, --resume) are expanded to CLI-native equivalents.
 * Extra passthrough args are appended as-is.
 */
export function buildLaunchArgs(
  opts: LaunchCommandOpts,
  cli: { yoloFlag?: string; resumeFlag?: string },
  extraArgs: string[] = [],
): string[] {
  const args: string[] = [];
  if (opts.yolo) args.push(cli.yoloFlag || '--dangerously-skip-permissions');
  if (opts.resume) args.push(cli.resumeFlag || '--continue');
  args.push(...extraArgs);
  return args;
}

/**
 * Decide whether to use tmux for this launch.
 * tmux is used when it is available AND the user hasn't passed --no-tmux.
 */
export function shouldUseTmux(tmuxAvailable: boolean, opts: LaunchCommandOpts): boolean {
  return tmuxAvailable && opts.tmux !== false;
}

/** Flags that sweech consumes itself and must not be forwarded to the CLI. */
export const SWEECH_LAUNCH_FLAGS = new Set([
  '--yolo', '-y', '--resume', '-r', '--no-tmux', '--tmux',
]);
