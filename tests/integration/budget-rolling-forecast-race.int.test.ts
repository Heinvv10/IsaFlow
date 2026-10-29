/**
 * Budgets P4 rolling forecast races, opened deterministically by wrapping `@/lib/neon`'s `sql` so a
 * hook runs right after one chosen statement (r129-po-delete-status-guard's pattern).
 *
 * 1. Roll now with no change (PR-4 general review L2): the answer is the
 * CLIENT's token, which the compare-and-set proved current (the bump was rolled back with the
 * savepoint), never one re-read after ROLLBACK TO SAVEPOINT. The race is built deterministically:
 * `@/lib/neon`'s `sql` is wrapped so that right after the no-op path's first statement after the
 * rollback (the rolling row's UPDATE), a second connection bumps the version's updated_at and
 * commits. A re-read would then answer that stranger's token, which the client never saw.
 * 2. An auto roll that read the rolling row before a toggle-off committed (breaker round 3, REPRO 7):
 *    the roll re-reads the row under the version lock and, finding it gone, rolls its savepoint back
 *    (token bump included) and skips: the now non-rolling version is not written.
 *
 * The wrapper stays lazy for every other statement (`sql` returns a LazyQuery; see
 * r129-po-delete-status-guard): only the hooked statement is awaited.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';

/** One armed hook at a time: it runs once, right after the first statement `match` accepts. */
const hooks = vi.hoisted(() => ({ armed: null as null | { match: (text: string) => boolean; run: () => Promise<void> }, fired: 0 }));

vi.mock('@/lib/neon', async (orig) => {
  const real = await orig<Record<string, unknown>>();
  const realSql = real.sql as ((s: TemplateStringsArray, ...v: unknown[]) => unknown) & Record<string, unknown>;
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    const hook = hooks.armed;
    if (!hook || !hook.match(text)) return realSql(strings, ...values);
    hooks.armed = null;
    return (async () => {
      const rows = await (realSql(strings, ...values) as Promise<unknown>);
      hooks.fired += 1;
      await hook.run();
      return rows;
    })();
  };
  return { ...real, sql: Object.assign(sql, realSql) };
});

import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetReforecastFixture } from './helpers/budgetReforecastFixture';
import { dataOf, type RouteOut } from './helpers/budgetDriverRouteFixture';

/** rollingForecastService's update of the rolling row (markRolled). */
const isRollingRowUpdate = (text: string) => /UPDATE budget_rolling_forecasts/.test(text) && /rolled_through_month =/.test(text);
/** rollingForecastService's read of the rolling row (rollingRow). */
const isRollingRowRead = (text: string) => /FROM budget_rolling_forecasts WHERE company_id/.test(text) && /AS rolled_at/.test(text);

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const fx = budgetReforecastFixture(pool);
const dump = (r: RouteOut) => `${r.status} ${JSON.stringify(r.body).slice(0, 600)}`;

afterAll(async () => {
  try { await fx.cleanup(); } finally { await pool.end(); }
}, 120000);

describe('budget rolling forecast: races', { timeout: 60000 }, () => {
  it("a no-op Roll now answers the client's token even when another writer bumps the version right after the rollback", async () => {
    const w = await fx.world();
    const m = w.months;
    const s = await fx.version(w);
    for (const month of m) await fx.amount(w, s, w.sales, month, 1000);
    const r = await fx.call.reforecast(w.u, s, 'POST', { name: 'Rolling', rolling: true });
    expect(r.status, dump(r)).toBe(201);
    const rf = dataOf<{ version: { id: string } }>(r).version.id;
    const client = await fx.token(rf);

    hooks.fired = 0;
    hooks.armed = {
      match: isRollingRowUpdate,
      // A second connection, committing on its own: the request's savepoint no longer holds the row.
      run: async () => { await pool.query('UPDATE budget_versions SET updated_at = clock_timestamp() WHERE id = $1', [rf]); },
    };
    const roll = await fx.call.reforecast(w.u, rf, 'POST', { action: 'roll', expectedUpdatedAt: client });
    expect(roll.status, dump(roll)).toBe(200);
    expect(hooks.fired).toBe(1);
    const stranger = await fx.token(rf);
    expect(stranger).not.toBe(client);
    expect(dataOf(roll)).toMatchObject({ status: 'rolled', changed: 0, updatedAt: client });
  });

  it('an auto roll that read the rolling row before a toggle-off committed skips: the version is not written', async () => {
    const w = await fx.world();
    const m = w.months;
    const s = await fx.version(w);
    for (const month of m) await fx.amount(w, s, w.sales, month, 1000);
    const r = await fx.call.reforecast(w.u, s, 'POST', { name: 'Rolling', rolling: true });
    expect(r.status, dump(r)).toBe(201);
    const rf = dataOf<{ version: { id: string } }>(r).version.id;
    await fx.journal(w, `${m[0]}-15`, [[w.sales, 0, 1200]]);
    let off: RouteOut | null = null;
    hooks.fired = 0;
    hooks.armed = {
      match: isRollingRowRead,
      // The user turns auto-roll off on another connection, before the job locks the version.
      run: async () => { off = await fx.call.reforecast(w.u, rf, 'PUT', { rolling: false, expectedUpdatedAt: await fx.token(rf) }); },
    };
    const cells = await fx.snapshot(rf);
    const audits = (await fx.audits(rf)).length;
    await fx.close(w, [m[0]!]);
    await fx.until(async () => hooks.fired === 1 && off !== null, 'the job and the toggle');
    expect(off!.status, dump(off!)).toBe(200);
    const token = await fx.token(rf);
    // The job runs detached: give it time to have written, if it were going to.
    await new Promise((res) => setTimeout(res, 1500));
    expect(await fx.rollingRow(rf)).toBeUndefined();
    expect(await fx.snapshot(rf)).toEqual(cells);
    expect((await fx.cellsOf(rf, w.sales)).get(m[0]!)).toBe('1000.00:manual');
    expect(await fx.token(rf)).toBe(token);
    expect((await fx.audits(rf)).length).toBe(audits + 1); // the toggle's own row only
  });
});
