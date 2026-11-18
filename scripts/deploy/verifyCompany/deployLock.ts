/**
 * The deploy locks, held for a whole real provisioning run. The run sets GoTrue passwords before it writes the env file's
 * final keys, and a deploy in that window would log in with the old password and go red (or retire a good colour). deploy.sh holds
 * /tmp/isaflow-deploy.lock for a whole deploy and bluegreen.sh /tmp/isaflow-colours.lock for anything that changes or restarts a
 * colour; this takes both, non-blocking, with flock(1) (the tool they use), and refuses when either is held.
 *
 * Node has no flock, so each lock is held by a child `flock -n <file> sh -c 'echo held; cat'`: the child prints once it holds the
 * lock and then waits on its stdin; closing the pipe (release, or this process dying) ends it and drops the lock, as a killed
 * deploy drops its own.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

export interface HeldLocks { release(): Promise<void> }

function take(file: string): Promise<ChildProcessWithoutNullStreams | null> {
  return new Promise((resolve, reject) => {
    const child = spawn('flock', ['-n', '-E', '99', file, 'sh', '-c', 'echo held; cat'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
      if (out.includes('held')) resolve(child);
    });
    child.on('error', (err) => reject(new Error(`cannot run flock to take ${file}: ${err.message}`)));
    child.on('close', (code) => {
      if (!out.includes('held')) {
        if (code === 99) resolve(null);
        else reject(new Error(`flock failed on ${file} (exit ${code})`));
      }
    });
  });
}

function end(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve) => {
    child.on('close', () => resolve());
    child.stdin.end();
  });
}

/** @throws when any of `files` is held (nothing stays held) */
export async function acquireDeployLocks(files: readonly string[]): Promise<HeldLocks> {
  const held: ChildProcessWithoutNullStreams[] = [];
  const releaseAll = async (): Promise<void> => { await Promise.all(held.splice(0).map(end)); };
  for (const file of files) {
    let child: ChildProcessWithoutNullStreams | null;
    try {
      child = await take(file);
    } catch (err) {
      await releaseAll();
      throw err;
    }
    if (child === null) {
      await releaseAll();
      throw new Error(`a deploy, rollback, restart or cutover holds ${file}: a provisioning run must not change passwords while one runs. Find the holder with \`lsof ${file}\` (or \`fuser -v ${file}\`), wait for it to finish, then run again`);
    }
    held.push(child);
  }
  return { release: releaseAll };
}
