/**
 * A child for sageCliConsole.test.ts (run with bun, through real pipes): OUT bytes to stdout, then ERR bytes and "STOP-END" to stderr
 * through the CLI's console, then the exit the CLI makes (exit 4 once the console is drained). With FLAGS=1 it prints, on stderr, what
 * prepareConsole found blocking and fd 1 / 2's flags afterwards.
 */
import { readFileSync, writeSync } from 'node:fs';
import * as consoleModule from '../../../../../scripts/sage-migration/runConsole';

type Api = { prepareConsole?: (r: () => string | null) => { blocking: number[] }; out?: (s: string) => void; say: (s: string) => void;
  cliConsole: { write: (stream: 'stdout' | 'stderr', text: string) => unknown }; exitAfterConsole?: (code: number) => Promise<void> };
const api = consoleModule as unknown as Api;
// As the CLI always did (its stream listeners touch both): bun makes fd 1 / 2 non-blocking then, so a full pipe answers EAGAIN.
void process.stdout.writable;
void process.stderr.writable;
const prepared = api.prepareConsole?.(() => null);
if (process.env.FLAGS === '1') {
  const flags = (fd: number) => /flags:\s*([0-7]+)/.exec(readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8'))?.[1];
  writeSync(2, `${JSON.stringify({ blocking: prepared?.blocking ?? null, fd1: flags(1), fd2: flags(2) })}\n`);
  process.exit(0);
}
const line = (ch: string, n: number) => ch.repeat(n);
if (api.out) api.out(line('o', Number(process.env.OUT ?? 0)));
else api.cliConsole.write('stdout', `${line('o', Number(process.env.OUT ?? 0))}\n`);
api.say(`${line('e', Number(process.env.ERR ?? 0))}\nSTOP-END`);
if (api.exitAfterConsole) void api.exitAfterConsole(4);
else process.exit(4);
