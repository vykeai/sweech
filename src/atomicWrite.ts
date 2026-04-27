/**
 * Atomic file write utility.
 *
 * Writes data to a temporary file (named with the current PID to avoid
 * collisions), then renames it to the target path. On POSIX systems,
 * rename is atomic, so readers will never see a partially-written file.
 */

import * as fs from 'fs';

export function atomicWriteFileSync(filePath: string, data: string | Buffer): void {
  const tmpPath = filePath + '.tmp.' + process.pid;
  fs.writeFileSync(tmpPath, data, typeof data === 'string' ? 'utf-8' : undefined);
  fs.renameSync(tmpPath, filePath);
}
