/**
 * NUMRACE: app-side numbers minted by a SERVICE — CL-YYYY-NNNN expense claims (createClaim, behind the
 * expense-claims POST and capture post-expense) and ITEM-NNNN item codes (createItem, behind the items POST) —
 * under a concurrent create of the same scope.
 *
 * The first writer runs the real service on its own connection inside an open transaction, so its number is
 * minted and uncommitted; the second runs on another connection and is proved waiting on the first by
 * pg_blocking_pids. Before the fix the second read the same MAX, waited on the unique index, and failed 23505.
 * Now it takes `take_number_lock` (migration 864) before its MAX: claims ('<company>:<year>', 864003), items
 * ('<company>', 864004). A key held past 5 s fails 55P03, which the routes answer 503 (withErrorHandler).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { sql } from '@/lib/neon';
import { createClaim } from '@/modules/accounting/services/expense/expenseClaimService';
import { createItem } from '@/modules/accounting/services/items/itemService';
import { assertLocalFixtureDbUrl } from './fixtureDbGuard';
import { dropFixture, inTx, runOn, seedFixture, type Fixture } from './helpers/l1FifoFixture';
import { backendPid, holdKey, settle, waitBlocked } from './helpers/numraceGate';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
type Row = Record<string, unknown>;

let fx: Fixture;
let employeeId = '';

const claim = (title: string) => createClaim({ companyId: fx.companyId, employeeId, claimDate: '2026-05-01', title });
const item = (description: string) => createItem(fx.companyId, { description } as never);

/** `first` left uncommitted on its own connection; `second` started behind it; then `first` commits. */
async function race<T>(first: () => Promise<T>, second: () => Promise<T>) {
  const a: PoolClient = await fx.pool.connect();
  try {
    await a.query('BEGIN');
    const aPid = await backendPid(a);
    const va = await runOn(fx, a, first);
    const b = await fx.pool.connect();
    const bPid = await backendPid(b);
    const pB = settle((async () => {
      await b.query('BEGIN');
      try {
        const v = await runOn(fx, b, second);
        await b.query('COMMIT');
        return v;
      } catch (err) {
        await b.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        b.release();
      }
    })());
    const blockers = await waitBlocked(fx.pool, bPid).catch(() => [] as number[]);
    await a.query('COMMIT');
    return { va, vb: await pB, waitedOnFirst: blockers.includes(aPid) };
  } catch (err) {
    await a.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    a.release();
  }
}

describeIfDb('NUMRACE: service-minted numbers under a concurrent create', () => {
  beforeAll(async () => {
    assertLocalFixtureDbUrl('DATABASE_URL', DATABASE_URL, ['isaflow_test', 'isaflow_schema_fixture']);
    fx = await seedFixture('NUMRACE-S', DATABASE_URL!);
    employeeId = String(((await sql`
      INSERT INTO payroll_employees (company_id, employee_number, first_name, last_name, start_date)
      VALUES (${fx.companyId}::UUID, 'NR-1', 'Num', 'Race', '2026-01-01') RETURNING id`) as Row[])[0]!.id);
  }, 60000);

  afterAll(async () => {
    await sql`DELETE FROM expense_claims WHERE company_id = ${fx.companyId}::UUID`;
    await sql`DELETE FROM payroll_employees WHERE company_id = ${fx.companyId}::UUID`;
    await sql`DELETE FROM items WHERE company_id = ${fx.companyId}::UUID`;
    await dropFixture(fx);
  }, 60000);

  it('expense claims: two claims in one year, the second behind the first: both commit, consecutive numbers', async () => {
    const r = await race(() => claim('claim A'), () => claim('claim B'));
    expect(r.vb.ok, JSON.stringify(r.vb)).toBe(true);
    expect(r.waitedOnFirst).toBe(true);
    expect([r.va.claimNumber, r.vb.ok ? r.vb.value.claimNumber : null]).toEqual(['CL-2026-0001', 'CL-2026-0002']);
  }, 60000);

  it('expense claims: the year key held past 5 s -> 55P03 (the route answers 503); another year does not wait', async () => {
    const held = await holdKey(fx.pool, `${fx.companyId}:2026`, 864003);
    try {
      const t0 = Date.now();
      const r = await settle(inTx(fx, () => claim('claim held')));
      expect(r.ok ? 'ok' : r.code).toBe('55P03');
      expect(Date.now() - t0).toBeLessThan(9000);
      const t1 = Date.now();
      const other = await inTx(fx, () => createClaim({ companyId: fx.companyId, employeeId, claimDate: '2027-02-01' }));
      expect(other.claimNumber).toBe('CL-2027-0001');
      expect(Date.now() - t1).toBeLessThan(3000);
    } finally {
      await held.open();
    }
  }, 60000);

  it('items: two auto-coded items, the second behind the first: both commit, consecutive codes', async () => {
    const r = await race(() => item('item A'), () => item('item B'));
    expect(r.vb.ok, JSON.stringify(r.vb)).toBe(true);
    expect(r.waitedOnFirst).toBe(true);
    expect([r.va.code, r.vb.ok ? r.vb.value.code : null]).toEqual(['ITEM-0001', 'ITEM-0002']);
  }, 60000);

  it("items: the company key held past 5 s -> 55P03; another company's key held -> no wait", async () => {
    const held = await holdKey(fx.pool, fx.companyId, 864004);
    try {
      const r = await settle(inTx(fx, () => item('item held')));
      expect(r.ok ? 'ok' : r.code).toBe('55P03');
    } finally {
      await held.open();
    }
    const other = await holdKey(fx.pool, crypto.randomUUID(), 864004);
    try {
      const t0 = Date.now();
      const made = await inTx(fx, () => item('item free'));
      expect(made.code).toBe('ITEM-0003');
      expect(Date.now() - t0).toBeLessThan(3000);
    } finally {
      await other.open();
    }
  }, 60000);
});
