/**
 * A child for sageCliConsole.test.ts (run with bun, through real pipes): OUT bytes to stdout, then ERR bytes and "STOP-END" to stderr
 * through the CLI's console, then the exit the CLI makes (exit 4 once the console is drained). With FLAGS=1 it prints, on stderr, what
 * prepareConsole found blocking and fd 1 / 2's flags afterwards; with FLAGS=2, what blockingFds finds before anything touched them;
 * with SPLICE=n, n logger lines and n console lines interleaved, then a closing line; WRITECB=1: 300 KB through process.stdout.write and
 * exit in its callback; ENC=1: encodings, a split character and a null chunk through process.stdout.write; NATURAL=1: one line, then the
 * process ends by itself (no process.exit); CLEARNB=<fd>: fd 2 put back to blocking (as another program would), then a 300 KB line,
 * its time written to <fd>.
 */
import { readFileSync, writeSync } from 'node:fs';
import * as consoleModule from '../../../../../scripts/sage-migration/runConsole';

type Api = { prepareConsole?: (r: () => string | null) => { blocking: number[] }; out?: (s: string) => void; say: (s: string) => void;
  cliConsole: { write: (stream: 'stdout' | 'stderr', text: string) => unknown }; exitAfterConsole?: (code: number) => Promise<void> };
const api = consoleModule as unknown as Api;
if (process.env.FLAGS === '2') { // the streams never touched: what blockingFds finds before prepareConsole
  writeSync(2, `${JSON.stringify({ blocking: (consoleModule as unknown as { blockingFds?: () => number[] }).blockingFds?.() ?? null })}\n`);
  process.exit(0);
}
// FLAGS=1: only prepareConsole touches the streams. Otherwise as the CLI always did (its stream listeners touch both): bun then makes
// fd 1 / 2 non-blocking, so a full pipe answers EAGAIN.
// (prepareConsole touches them itself, after it saved their flags: only a console without it is touched here.)
if (process.env.FLAGS !== '1' && api.prepareConsole === undefined) { void process.stdout.writable; void process.stderr.writable; }
const prepared = api.prepareConsole?.(() => null);
if (process.env.WRITECB === '1') { // R29-3: node's flush-then-exit idiom through the captured process.stdout.write
  let drained = false;
  process.stdout.once('drain', () => { drained = true; });
  const ok = process.stdout.write(`${'Y'.repeat(300_000)}\nEND-OF-DATA\n`, () => { writeSync(2, `callback (drained ${drained})\n`); process.exit(0); });
  writeSync(2, `returned ${ok}\n`);
} else if (process.env.ENC === '1') { // R29-8: encodings, a Buffer split inside a character, a null chunk
  process.stdout.write('68656c6c6f2c20', 'hex');
  const euro = Buffer.from('\u20ac\n', 'utf8');
  process.stdout.write(euro.subarray(0, 1));
  process.stdout.write(euro.subarray(1));
  let refused = 'not refused';
  try { process.stdout.write(null as unknown as string); } catch (err) { refused = String((err as { code?: string }).code); }
  writeSync(2, `${refused}\n`);
  if (api.exitAfterConsole) await api.exitAfterConsole(0);
  process.exit(0);
} else if (process.env.SPLICE !== undefined) { // the logger's lines, then the console's, into one lagging pipe (B28 harness splice.ts)
  const { log } = await import('../../../../../src/lib/logger');
  const n = Number(process.env.SPLICE);
  for (let i = 0; i < n; i++) { // interleaved, as a run logs and says (bs4 found JSON fragments glued to CLI lines)
    log.info('sage migration: batch committed', { batch: i, pad: 'x'.repeat(60) }, 'sage-migration');
    api.say(`committed: category batch ${i}`);
    if (i % 100 === 99) await new Promise((r) => setTimeout(r, 5));
  }
  api.say('CLOSING LINE');
  log.info('LAST LOG LINE', {}, 'sage-migration'); // after the console's last line: an exit must not drop it either
  if (api.exitAfterConsole) await api.exitAfterConsole(4);
  process.exit(4);
}
if (process.env.FLAGS === '1') {
  const flags = (fd: number) => /flags:\s*([0-7]+)/.exec(readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8'))?.[1];
  writeSync(2, `${JSON.stringify({ blocking: prepared?.blocking ?? null, fd1: flags(1), fd2: flags(2) })}\n`);
  process.exit(0);
}
if (process.env.CLEARNB !== undefined) { // B30-1: another program on the pipe puts it back to blocking under this one, then a large say
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- bun:ffi, as runConsoleSys.ts uses it
  const ffi = require('bun:ffi') as { dlopen: (l: string, s: Record<string, unknown>) => { symbols: { fcntl: (a: number, b: number, c: number) => number } }; FFIType: Record<string, unknown> };
  const { fcntl } = ffi.dlopen('libc.so.6', { fcntl: { args: [ffi.FFIType.i32, ffi.FFIType.i32, ffi.FFIType.i32], returns: ffi.FFIType.i32 } }).symbols;
  fcntl(2, 4, fcntl(2, 3, 0) & ~0o4000);
  const t0 = Date.now();
  api.say('n'.repeat(300_000));
  writeSync(Number(process.env.CLEARNB), `say took ${Date.now() - t0} ms\n`);
  if (api.exitAfterConsole) await api.exitAfterConsole(4);
  process.exit(4);
} else if (process.env.NATURAL === '1') { // the CLI's success path: no process.exit, the process just ends (B29-2)
  api.say('the run finished');
} else if (process.env.WRITECB !== '1') { // the WRITECB child ends in its own callback
  const line = (ch: string, n: number) => ch.repeat(n);
  if (api.out) api.out(line('o', Number(process.env.OUT ?? 0)));
  else api.cliConsole.write('stdout', `${line('o', Number(process.env.OUT ?? 0))}\n`);
  api.say(`${line('e', Number(process.env.ERR ?? 0))}\nSTOP-END`);
  if (api.exitAfterConsole) void api.exitAfterConsole(4);
  else process.exit(4);
}
