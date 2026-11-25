/**
 * Fault injection for the CLI tests (bun --preload): at the Nth COMMIT of the process (SAGE_DIE_AT_COMMIT) the process is killed with
 * SIGKILL, as an OOM kill or a pulled plug would: no handler runs, so what the run left on disk is what a person finds.
 */
import pg from 'pg';

const dieAt = Number(process.env.SAGE_DIE_AT_COMMIT ?? '0');
let commits = 0;
const orig = pg.Client.prototype.query;
(pg.Client.prototype as unknown as { query: unknown }).query = function patched(this: pg.Client, ...args: unknown[]) {
  if (args[0] === 'COMMIT' && ++commits === dieAt) process.kill(process.pid, 'SIGKILL');
  return (orig as (...a: unknown[]) => unknown).apply(this, args);
};
