/**
 * Fault injection for the CLI tests (bun --preload): right after the Nth COMMIT of the process (SAGE_CRASH_AT_COMMIT) an error is thrown
 * on a timer, outside every try: an uncaught exception during the live run (round 18: one terminate path writes the stop report).
 */
import pg from 'pg';

const at = Number(process.env.SAGE_CRASH_AT_COMMIT ?? '0');
let commits = 0;
const orig = pg.Client.prototype.query;
(pg.Client.prototype as unknown as { query: unknown }).query = async function patched(this: pg.Client, ...args: unknown[]) {
  const out = await (orig as (...a: unknown[]) => Promise<unknown>).apply(this, args);
  if (args[0] === 'COMMIT' && ++commits === at) setTimeout(() => { throw new Error('injected crash after a COMMIT'); }, 0);
  return out;
};
