/**
 * Fault injection for the CLI tests (bun --preload, R30-6): once the Nth COMMIT of the process is SENT (SAGE_CRASH_AT_COMMIT), raise one
 * uncaught error on the next turn, while that COMMIT is in flight: the CLI's own crash handler (terminate) ends the run, with the real
 * runner and its real sessions.
 */
import pg from 'pg';

const at = Number(process.env.SAGE_CRASH_AT_COMMIT ?? '0');
let commits = 0;
const orig = pg.Client.prototype.query;
(pg.Client.prototype as unknown as { query: unknown }).query = function patched(this: pg.Client, ...args: unknown[]) {
  const out = (orig as (...a: unknown[]) => unknown).apply(this, args);
  if (args[0] === 'COMMIT' && ++commits === at) setTimeout(() => { throw new Error(`injected crash at COMMIT ${at}`); }, 0);
  return out;
};
