/**
 * Writes the shared CI env file without ever exposing a half-written one: the golden-paths job on another runner may
 * be copying it while the provisioner runs. The text goes to a temp file beside the real file, with its mode, and is
 * renamed over it. A symlink (/home/hein/isaflow-ci.env points at the main checkout's .env.local) is followed, never
 * replaced.
 */
import { chmodSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';

export function writeEnvFileAtomic(path: string, text: string): void {
  const real = realpathSync(path);
  const mode = statSync(real).mode & 0o777;
  const temp = `${real}.tmp-${process.pid}`;
  writeFileSync(temp, text, { mode });
  chmodSync(temp, mode);
  renameSync(temp, real);
}
