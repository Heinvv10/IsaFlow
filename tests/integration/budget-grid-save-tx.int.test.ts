/**
 * A LOCKED refusal of the grid save leaves the caller's transaction usable (no 25P02 on the next
 * statement), the way withAuth's request transaction goes on to COMMIT a 4xx. Two paths: a
 * version already locked is refused by the compare-and-set (no SQL error at all); a lock that
 * lands after the compare-and-set is refused by the lock trigger's BV001 on the amount write,
 * which only `saveCells`' savepoint keeps from poisoning the transaction. Each runs the real
 * service on its own connection inside BEGIN, then asks the same connection for `SELECT 1`.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';

type RawSql = ((s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown>) & Record<string, unknown>;
const hooks = vi.hoisted(() => ({ match: null as null | RegExp, fn: null as null | ((realSql: RawSql) => Promise<void>), fired: 0 }));

// Every statement runs on the real database; once armed, `fn` runs right after the first statement
// matching `match`, on the same connection (the transaction under test).
vi.mock('@/lib/neon', async (orig) => {
  const real = await orig<Record<string, unknown>>();
  const realSql = real.sql as RawSql;
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const { match, fn } = hooks;
    if (!match || !fn || !match.test(strings.join('?'))) return realSql(strings, ...values);
    return (async () => {
      hooks.match = null;
      hooks.fn = null;
      hooks.fired += 1;
      const rows = await realSql(strings, ...values);
      await fn(realSql);
      return rows;
    })();
  };
  Object.assign(sql, realSql);
  return { ...real, sql };
});

import saveRoute from '../../pages/api/accounting/budget-grid/save';
import { als } from '@/lib/als';
import { saveCells, type SaveCell } from '@/modules/accounting/services/budgets/gridSave';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetGridSaveFixture, type GridWorld } from './helpers/budgetGridSaveFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const fx = budgetGridSaveFixture(pool, saveRoute, '/api/accounting/budget-grid/save');
let w: GridWorld;
beforeAll(async () => { w = await fx.world(); }, 120000);
afterAll(async () => {
  try { await fx.cleanup(); } finally { await pool.end(); }
}, 120000);

const cell = (month: string, amount: number): SaveCell => ({ glAccountId: w.rent, cc1Id: null, cc2Id: null, buId: null, month, amount });

/** `run` as w's owner inside BEGIN on one connection: the refusal it threw, then what `SELECT 1` on that connection answers. */
async function inOneTransaction(run: () => Promise<unknown>): Promise<{ refusal: unknown; next: unknown }> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const refusal = await als.run({ client: c, companyId: w.u.homeCompanyId, userId: w.u.userId, claims: {} } as never,
      () => run().then(() => null, (err: unknown) => err));
    const next = await c.query('SELECT 1 AS ok').then((r) => r.rows[0].ok as number, (err: { code?: string }) => err.code);
    return { refusal, next };
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    c.release();
  }
}

describe('a LOCKED save refusal leaves the transaction usable', () => {
  it('a version already locked: refused by the compare-and-set; the next statement on the connection runs', async () => {
    const v = await fx.version(w, { status: 'locked' });
    const expectedUpdatedAt = await fx.token(v);
    const { refusal, next } = await inOneTransaction(() =>
      saveCells(w.u.homeCompanyId, w.u.userId, { versionId: v, expectedUpdatedAt, cells: [cell(w.months[0]!, 5)] }));
    expect(refusal).toMatchObject({ code: 'BUDGET_VERSION_LOCKED' });
    expect(next).toBe(1);
    expect(await fx.cells(v)).toEqual([]);
  });

  it('a lock after the compare-and-set: the trigger\'s BV001 is refused BUDGET_VERSION_LOCKED inside the savepoint, never 25P02 after it', async () => {
    const v = await fx.version(w, { status: 'approved' });
    const expectedUpdatedAt = await fx.token(v);
    const userId = w.u.userId;
    hooks.fired = 0;
    hooks.match = /UPDATE budget_versions SET updated_at/;
    hooks.fn = async (realSql) => {
      await realSql`UPDATE budget_versions SET status = 'locked', locked_by = ${userId}, locked_at = clock_timestamp() WHERE id = ${v}::UUID`;
    };
    const { refusal, next } = await inOneTransaction(() =>
      saveCells(w.u.homeCompanyId, userId, { versionId: v, expectedUpdatedAt, cells: [cell(w.months[0]!, 7)] }));
    hooks.match = null;
    expect(hooks.fired).toBe(1);
    expect(refusal).toMatchObject({ code: 'BUDGET_VERSION_LOCKED' });
    expect(next).toBe(1);
    expect(await fx.cells(v)).toEqual([]);
  });
});
