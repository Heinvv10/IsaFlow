/**
 * R27-2 / B27-1: the CLI's console writes synchronously, so `process.exit` right after a large message cannot drop what a pipe whose
 * reader lags did not take yet (bun kept it in its own buffer and process.exit dropped it: a stop message cut at 64 KiB, mid-line).
 *   - Through a REAL pipe: the CLI refuses a 100 KB argument (the refusal echoes it, then process.exit(2)), its stderr read by a reader
 *     that sleeps 2 s first. The whole message arrives, and the exit code is 2. A reader that is gone (EPIPE) still ends it at once, 2.
 *   - The writer itself (Console, fake system calls): partial writes looped; EAGAIN waited on and retried, bounded in all; past the bound,
 *     or on EPIPE, the stream is given up (never written again), and nothing is thrown.
 */
import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { CONSOLE_WAIT_MS, Console } from '../../../../scripts/sage-migration/runConsole';

const BIG = 'x'.repeat(100_000);
function shell(script: string): Promise<{ text: string; ms: number }> {
  const t0 = Date.now();
  const env: NodeJS.ProcessEnv = { ...process.env, BIG, DATABASE_URL: 'postgresql://postgres@127.0.0.1:5433/isaflow_test' };
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

const fail = (code: string) => Object.assign(new Error(code), { code });
function fake(script: Array<number | string>) {
  const calls: Array<{ fd: number; text: string }> = [];
  let pauses = 0;
  const c = new Console({
    write: (fd, buf, offset, length) => {
      const step = script.length > 0 ? script.shift()! : length;
      if (typeof step === 'string') throw fail(step);
      const n = Math.min(step, length);
      calls.push({ fd, text: buf.subarray(offset, offset + n).toString('utf8') });
      return n;
    },
    pause: () => { pauses++; },
  });
  return { c, calls, pauses: () => pauses };
}

describe('R27-2: the writer', () => {
  it('loops on partial writes until all of it is written, to fd 2 for stderr and fd 1 for stdout', () => {
    const f = fake([3, 3, 3]);
    expect(f.c.write('stderr', 'abcdefghij\n')).toBe('written');
    expect(f.calls.map((x) => x.text).join('')).toBe('abcdefghij\n');
    expect(new Set(f.calls.map((x) => x.fd))).toEqual(new Set([2]));
    expect(f.c.write('stdout', 'out\n')).toBe('written');
    expect(f.calls.at(-1)).toEqual({ fd: 1, text: 'out\n' });
  });

  it('waits on EAGAIN and retries, without losing a byte', () => {
    const f = fake([4, 'EAGAIN', 'EAGAIN', 'EAGAIN']);
    expect(f.c.write('stderr', 'committed: batch 881\n')).toBe('written');
    expect(f.calls.map((x) => x.text).join('')).toBe('committed: batch 881\n');
    expect(f.pauses()).toBe(3);
  });

  it('gives a stream up past the bound (in all, for the process), throws nothing, and never writes it again', () => {
    const f = fake(Array.from({ length: CONSOLE_WAIT_MS }, () => 'EAGAIN'));
    expect(f.c.write('stderr', 'stop message\n')).toEqual({ gone: `no reader within ${CONSOLE_WAIT_MS / 1000} s` });
    expect(f.pauses()).toBe(CONSOLE_WAIT_MS / 5);
    const before = f.calls.length;
    expect(f.c.write('stderr', 'closing line\n')).toBe('skipped');
    expect(f.calls.length).toBe(before);
    expect(f.c.gone).toEqual({ stdout: false, stderr: true });
  });

  it('gives a stream up at once on EPIPE, no wait; the other stream is still written', () => {
    const f = fake(['EPIPE']);
    expect(f.c.write('stdout', 'summary\n')).toEqual({ gone: 'EPIPE' });
    expect(f.pauses()).toBe(0);
    expect(f.c.write('stderr', 'note\n')).toBe('written');
  });
});
