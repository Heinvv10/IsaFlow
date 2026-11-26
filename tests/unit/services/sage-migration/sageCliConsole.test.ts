/**
 * The CLI's console through REAL pipes (the writer itself, with a fake clock: sageCliConsoleWriter.test.ts):
 *   - R27-2 / B27-1: the CLI refuses a 100 KB argument (the refusal echoes it, then exits 2), its stderr read by a reader that sleeps 2 s
 *     first: the whole message arrives, and the exit code is 2. A reader that is gone (EPIPE) still ends it at once, 2.
 *   - R28-1: stdout and stderr on one pipe (2>&1) whose reader pauses 20 s, reads a little, pauses 20 s again: 40 s in all, never 30 s
 *     without progress, so the stdout output AND the stop message after it arrive whole (a budget per stream, of no progress).
 *   - B28-1: a second SIGINT while the stop message waits for a reader ends the process at once, with the refusal's exit code (2).
 *   - R28-6: after prepareConsole, fd 1 and fd 2 (pipes) are O_NONBLOCK, and nothing is reported blocking.
 */
import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BIG = 'x'.repeat(100_000);
function shell(script: string, extra: NodeJS.ProcessEnv = {}): Promise<{ text: string; ms: number }> {
  const t0 = Date.now();
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra, BIG, DATABASE_URL: 'postgresql://postgres@127.0.0.1:5433/isaflow_test' };
  for (const name of ['SERVICE_DATABASE_URL', 'PLATFORM_ADMIN_DATABASE_URL', 'MIGRATION_ADMIN_DATABASE_URL']) delete env[name];
  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['-c', script], { env, stdio: ['ignore', 'pipe', 'inherit'] });
    let text = '';
    child.stdout.on('data', (b: Buffer) => { text += b.toString('utf8'); });
    child.on('error', reject);
    child.on('close', () => resolve({ text, ms: Date.now() - t0 }));
  });
}
const CLI = 'bun --no-env-file scripts/sage-migration/run.ts --company 00000000-0000-4000-8000-000000000001 '
  + '--user 00000000-0000-4000-8000-000000000002 --file x.json --expect-items "$BIG"';

describe('R27-2: the console through a real pipe', () => {
  it('a reader that lags gets the whole message, and the exit code stands', async () => {
    const { text } = await shell(`${CLI} 2>&1 >/dev/null | { sleep 2; cat; }; echo "exit=\${PIPESTATUS[0]}"`);
    const message = `not a count: ${BIG}\n`;
    expect(text.length).toBe(message.length + 'exit=2\n'.length);
    expect(text).toBe(`${message}exit=2\n`);
  }, 30_000);

  it('a reader that is gone (EPIPE) ends nothing early and holds nothing up: exit 2 at once', async () => {
    const { text, ms } = await shell(`${CLI} 2>&1 >/dev/null | head -c 10 >/dev/null; echo "exit=\${PIPESTATUS[0]}"`);
    expect(text).toBe('exit=2\n');
    expect(ms).toBeLessThan(10_000);
  }, 30_000);
});

const CHILD = 'bun --no-env-file tests/unit/services/sage-migration/fixtures/consoleChild.ts';
describe('R28-1: one pipe for both streams (2>&1), a reader that pauses twice', () => {
  it('stdout first, then the stop message: both arrive whole, 40 s of pauses in all, and the exit code stands', async () => {
    const reader = '{ sleep 20; dd bs=1000 count=70 iflag=fullblock status=none; sleep 20; cat; }';
    const { text } = await shell(`${CHILD} 2>&1 | ${reader}; echo "exit=\${PIPESTATUS[0]}"`, { OUT: '100000', ERR: '100000' });
    expect(text.length).toBe(100_001 + 100_000 + '\nSTOP-END\n'.length + 'exit=4\n'.length);
    expect(text).toBe(`${'o'.repeat(100_000)}\n${'e'.repeat(100_000)}\nSTOP-END\nexit=4\n`);
  }, 90_000);
});

describe('B28-1: a second SIGINT while the stop message waits for a reader', () => {
  it('ends the process at once, exit 2 (the refusal\'s), not after the console\'s 30 s', async () => {
    const d = mkdtempSync(join(tmpdir(), 'sage-console-int2-'));
    try {
      const run = shell(`( ${CLI} 2>&1 >/dev/null & echo $! > ${d}/pid; wait $!; echo "exit=$?" > ${d}/exit ) | { sleep 40; cat > /dev/null; }`);
      const until = async (p: string, ms = 15_000) => { for (const t = Date.now(); Date.now() - t < ms && !existsSync(p);) await new Promise((r) => setTimeout(r, 50)); };
      await until(join(d, 'pid'));
      const pid = Number(readFileSync(join(d, 'pid'), 'utf8'));
      await new Promise((r) => setTimeout(r, 2_000)); // the refusal is said by now, and waits on the paused reader
      const t0 = Date.now();
      process.kill(pid, 'SIGINT');
      await new Promise((r) => setTimeout(r, 300));
      process.kill(pid, 'SIGINT');
      await until(join(d, 'exit'));
      expect(readFileSync(join(d, 'exit'), 'utf8')).toBe('exit=2\n');
      expect(Date.now() - t0).toBeLessThan(10_000);
      await run;
    } finally { rmSync(d, { recursive: true, force: true }); }
  }, 90_000);
});

describe('R28-6: the O_NONBLOCK precondition', () => {
  it('after prepareConsole, fd 1 and fd 2 (pipes) are non-blocking, and none is reported blocking', async () => {
    // Two pipes, two open files (2>&1 would make them one, whose flags touching either stream sets).
    const { text } = await shell(`( ${CHILD} | cat > /dev/null ) 2>&1 | cat`, { FLAGS: '1' });
    const got = JSON.parse(text) as { blocking: number[] | null; fd1: string; fd2: string };
    expect(got.blocking).toEqual([]);
    for (const f of [got.fd1, got.fd2]) expect(Number.parseInt(f, 8) & 0o4000).toBe(0o4000);
  }, 30_000);
  it('before anything touched them, fd 1 and fd 2 (pipes) ARE blocking, and blockingFds says so (what prepareConsole guards against)', async () => {
    const { text } = await shell(`( ${CHILD} | cat > /dev/null ) 2>&1 | cat`, { FLAGS: '2' });
    expect(JSON.parse(text)).toEqual({ blocking: [1, 2] });
  }, 30_000);
});
