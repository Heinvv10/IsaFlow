/**
 * Fault injection for the CLI tests (bun --preload): the Nth COMMIT of the process (SAGE_FAIL_COMMIT) is rejected before it reaches the
 * server, as a COMMIT whose answer never came. The runner then ends that request transaction with its own ROLLBACK.
 */
import pg from 'pg';

const failOn = Number(process.env.SAGE_FAIL_COMMIT ?? '0');
let commits = 0;
const orig = pg.Client.prototype.query;
(pg.Client.prototype as unknown as { query: unknown }).query = function patched(this: pg.Client, ...args: unknown[]) {
  if (args[0] === 'COMMIT' && ++commits === failOn) return Promise.reject(new Error('injected: COMMIT did not answer'));
  return (orig as (...a: unknown[]) => unknown).apply(this, args);
};
