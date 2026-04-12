"use strict";
/**
 * Pure helpers for `sweech launch` — extracted for testability.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SWEECH_LAUNCH_FLAGS = void 0;
exports.buildLaunchArgs = buildLaunchArgs;
exports.shouldUseTmux = shouldUseTmux;
/**
 * Build the arg list to pass to the underlying CLI.
 * Sweech-level flags (--yolo, --resume) are expanded to CLI-native equivalents.
 * Extra passthrough args are appended as-is.
 */
function buildLaunchArgs(opts, cli, extraArgs = []) {
    const args = [];
    if (opts.yolo)
        args.push(cli.yoloFlag || '--dangerously-skip-permissions');
    if (opts.resume)
        args.push(cli.resumeFlag || '--continue');
    args.push(...extraArgs);
    return args;
}
/**
 * Decide whether to use tmux for this launch.
 * tmux is used when it is available AND the user hasn't passed --no-tmux.
 */
function shouldUseTmux(tmuxAvailable, opts) {
    return tmuxAvailable && opts.tmux !== false;
}
/** Flags that sweech consumes itself and must not be forwarded to the CLI. */
exports.SWEECH_LAUNCH_FLAGS = new Set([
    '--yolo', '-y', '--resume', '-r', '--no-tmux', '--tmux',
]);
