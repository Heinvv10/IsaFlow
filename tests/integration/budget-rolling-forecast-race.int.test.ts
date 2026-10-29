/**
 * Budgets P4 rolling forecast, Roll now with no change (PR-4 general review L2): the answer is the
 * CLIENT's token, which the compare-and-set proved current (the bump was rolled back with the
 * savepoint), never one re-read after ROLLBACK TO SAVEPOINT. The race is built deterministically:
 * `@/lib/neon`'s `sql` is wrapped so that right after the no-op path's first statement after the
 * rollback (the rolling row's UPDATE), a second connection bumps the version's updated_at and
 * commits. A re-read would then answer that stranger's token, which the client never saw.
 *
 * The wrapper stays lazy for every other statement (`sql` returns a LazyQuery; see
 * r129-po-delete-status-guard): only the hooked statement is awaited.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';

const hooks = vi.hoisted(() => ({ afterRollingRowUpdate: null as null | (() => Promise<void>), fired: 0 }));

vi.mock('@/lib/neon', async (orig) => {
  const real = await orig<Record<string, unknown>>();
  const realSql = real.sql as ((s: TemplateStringsArray, ...v: unknown[]) => unknown) & Record<string, unknown>;
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    const hook = hooks.afterRollingRowUpdate;
    if (!hook || !/UPDATE budget_rolling_forecasts/.test(text) || !/rolled_through_month =/.test(text)) return realSql(strings, ...values);
    hooks.afterRollingRowUpdate = null;
    return (async () => {
      const rows = await (realSql(strings, ...values) as Promise<unknown>);
      hooks.fired += 1;
      await hook();
      return rows;
    })();
  };
  return { ...real, sql: Object.assign(sql, realSql) };
});

import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetReforecastFixture } from './helpers/budgetReforecastFixture';
import { dataOf, type RouteOut } from './helpers/budgetDriverRouteFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const fx = budgetReforecastFixture(pool);
const dump = (r: RouteOut) => `${r.status} ${JSON.stringify(r.body).slice(0, 600)}`;

afterAll(async () => {
  try { await fx.cleanup(); } finally { await pool.end(); }
}, 120000);

describe('budget rolling forecast: Roll now token race', { timeout: 60000 }, () => {
  it("a no-op Roll now answers the client's token even when another writer bumps the version right after the rollback", async () => {
    const w = await fx.world();
    const m = w.months;
    const s = await fx.version(w);
    for (const month of m) await fx.amount(w, s, w.sales, month, 1000);
    const r = await fx.call.reforecast(w.u, s, 'POST', { name: 'Rolling', rolling: true });
    expect(r.status, dump(r)).toBe(201);
    const rf = dataOf<{ version: { id: string } }>(r).version.id;
    const client = await fx.token(rf);

    hooks.afterRollingRowUpdate = async () => {
      // A second connection, committing on its own: the request's savepoint no longer holds the row.
      await pool.query('UPDATE budget_versions SET updated_at = clock_timestamp() WHERE id = $1', [rf]);
    };
    const roll = await fx.call.reforecast(w.u, rf, 'POST', { action: 'roll', expectedUpdatedAt: client });
    expect(roll.status, dump(roll)).toBe(200);
    expect(hooks.fired).toBe(1);
    const stranger = await fx.token(rf);
    expect(stranger).not.toBe(client);
    expect(dataOf(roll)).toMatchObject({ status: 'rolled', changed: 0, updatedAt: client });
  });
});
