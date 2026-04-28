/**
 * Atomic file write utility.
 *
 * Writes data to a temporary file (named with PID + timestamp to avoid
 * collisions across restarts), then renames it to the target path.
 * On POSIX systems, rename is atomic, so readers never see a partial write.
 * Temp files are cleaned up on failure.
 */

import * as fs from 'fs';

export function atomicWriteFileSync(filePath: string, data: string | Buffer): void {
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  try {
    fs.writeFileSync(tmpPath, data, typeof data === 'string' ? 'utf-8' : undefined);
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* already gone */ }
    throw err;
  }
}
