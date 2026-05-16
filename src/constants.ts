/**
 * Project-wide CLI constants.
 *
 * Cross-workspace note: `packages/engine/src/constants.ts` mirrors the
 * daemon-port value. The two stay in sync manually because the CLI and
 * engine are independent npm workspaces with separate module systems.
 */

export const DEFAULT_DAEMON_PORT = 7801;

/**
 * Resolve the daemon port honouring only the `SWEECH_PORT` env override.
 * Use this in code paths that do not also read `~/.fed/config.json`.
 */
export function envOrDefaultDaemonPort(): number {
  const envPort = parseInt(process.env.SWEECH_PORT ?? '', 10);
  if (Number.isFinite(envPort) && envPort > 0) return envPort;
  return DEFAULT_DAEMON_PORT;
}
