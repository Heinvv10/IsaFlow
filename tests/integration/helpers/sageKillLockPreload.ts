/**

 * Fault injection for the CLI tests (bun --preload): after the Nth COMMIT (SAGE_KILL_AFTER_COMMIT) of the process, terminate the backend
 * holding the Sage run lock (as idle_session_timeout, a pooler or a network blip would), then let the run go on.
 */
import pg from 'pg';

const after = Number(process.env.SAGE_KILL_AFTER_COMMIT ?? '0');
/** Or after the Nth ROLLBACK (the 1st ends the snapshot read, the 2nd the dry run). */
const afterRollback = Number(process.env.SAGE_KILL_AFTER_ROLLBACK ?? '0');
let commits = 0;
let rollbacks = 0;
let fired = false;
const orig = pg.Client.prototype.query;
(pg.Client.prototype as unknown as { query: unknown }).query = function patched(this: pg.Client, ...args: unknown[]) {
  const out = (orig as (...a: unknown[]) => unknown).apply(this, args);
  const hit = (args[0] === 'COMMIT' && ++commits === after) || (args[0] === 'ROLLBACK' && ++rollbacks === afterRollback);
  if (hit && out instanceof Promise && !fired) {
    fired = true;
    return out.then(async (v) => {
      const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
      await c.connect();
      const pids = (await (orig as (...a: unknown[]) => Promise<pg.QueryResult>).call(c, `SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND objsubid = 2 AND granted AND pid <> pg_backend_pid()`)).rows;
      for (const r of pids) await (orig as (...a: unknown[]) => Promise<unknown>).call(c, 'SELECT pg_terminate_backend($1)', [r.pid]);
      process.stderr.write(`[sage-test-inject] after COMMIT ${commits} / ROLLBACK ${rollbacks}: terminated lock backend(s) ${pids.map((r) => r.pid).join(',')}\n`);
      await c.end();
      await new Promise((r) => setTimeout(r, 300));
      return v;
    });
  }
  return out;
};
