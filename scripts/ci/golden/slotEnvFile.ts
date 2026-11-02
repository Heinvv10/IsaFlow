/**
 * Writes the shared CI env file without exposing a half-written one: the golden-paths job on another runner may be
 * copying it while the provisioner runs. The text goes to a temp file beside the real file and is renamed over it.
 * A symlink (/home/hein/isaflow-ci.env points at the main checkout's .env.local) is followed, never replaced.
 *
 * The replacement must keep the file's mode, owner AND GROUP: the runners read it through the group (hein:gha-isaflow,
 * 0640), and a file that came out hein:hein would lock every runner out. A user who is not in that group cannot give
 * the temp file the group (chown fails with EPERM), so then the real file is overwritten in place, which keeps its
 * inode, group and mode. That write is one small write(2), not atomic against a reader, but it never changes who can read.
 */
import { chmodSync, chownSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';

export function writeEnvFileAtomic(path: string, text: string): void {
  const real = realpathSync(path);
  const { mode, uid, gid } = statSync(real);
  const temp = `${real}.tmp-${process.pid}`;
  writeFileSync(temp, text, { mode: mode & 0o777 });
  try {
    chmodSync(temp, mode & 0o777);
    chownSync(temp, uid, gid);
  } catch (err) {
    rmSync(temp, { force: true });
    if ((err as NodeJS.ErrnoException).code !== 'EPERM') throw err;
    writeFileSync(real, text);
    return;
  }
  try {
    renameSync(temp, real);
  } catch (err) {
    rmSync(temp, { force: true });
    throw err;
  }
}
