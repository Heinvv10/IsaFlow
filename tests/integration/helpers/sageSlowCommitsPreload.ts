/** bun --preload for the CLI tests: every COMMIT takes SAGE_COMMIT_DELAY_MS longer (a run with bigger batches). Nothing else changes. */
import pg from 'pg';

const delay = Number(process.env.SAGE_COMMIT_DELAY_MS ?? '0');
const orig = pg.Client.prototype.query;
(pg.Client.prototype as unknown as { query: unknown }).query = function patched(this: pg.Client, ...args: unknown[]) {
  const out = (orig as (...a: unknown[]) => unknown).apply(this, args);
  if (args[0] === 'COMMIT' && out instanceof Promise) return out.then(async (v) => { await new Promise((r) => setTimeout(r, delay)); return v; });
  return out;
};
