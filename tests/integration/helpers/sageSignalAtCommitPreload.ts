/**
 * Fault injection for the CLI tests (bun --preload): right after the Nth COMMIT of the process (SAGE_SIGNAL_AT_COMMIT) the process sends
 * itself SAGE_SIGNAL (default SIGTERM), SAGE_SIGNAL_TIMES times (default 1): an operator's Ctrl-C or kill during the live run.
 */
import pg from 'pg';

const at = Number(process.env.SAGE_SIGNAL_AT_COMMIT ?? '0');
const sig = (process.env.SAGE_SIGNAL ?? 'SIGTERM') as NodeJS.Signals;
const times = Number(process.env.SAGE_SIGNAL_TIMES ?? '1');
let commits = 0;
const orig = pg.Client.prototype.query;
(pg.Client.prototype as unknown as { query: unknown }).query = async function patched(this: pg.Client, ...args: unknown[]) {
  const out = await (orig as (...a: unknown[]) => Promise<unknown>).apply(this, args);
  if (args[0] === 'COMMIT' && ++commits === at) for (let i = 0; i < times; i++) process.kill(process.pid, sig);
  return out;
};
