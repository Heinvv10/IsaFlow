/**
 * Breaker round 2 repros for P5-3 (same-slice netting, cancel). Fixture route: isaflow_schema_fixture (assertDisposable).
 * Fixture: opex BB-6100 budget CC1 FT 1 000 / HT 0 a month, FY2027 = Mar 2026 - Feb 2027.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import remainingRoute from '../../pages/api/accounting/budgets/remaining';
import actionRoute from '../../pages/api/accounting/supplier-invoices-action';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import {
  callRoute, dropBillFixture, linkBillToPo, makeBill, seedBillFixture, setPolicy, type BillFixture,
} from './helpers/budgetBillFixture';
import { approvePo, makePo } from './helpers/budgetPoFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let f: BillFixture;

beforeAll(async () => { f = await seedBillFixture(pool, 'po-brk2'); }, 60_000);
afterAll(async () => {
  try {
    await pool.query('DELETE FROM rate_limit_counters WHERE key = ANY($1::TEXT[])',
      [[f.owner, f.manager].flatMap((u) => [`budget-remaining:${u}`, `purchase-order-approve:${u}`])]);
    await dropBillFixture(pool, f);
  } finally { await pool.end(); }
}, 60_000);

const slice = async (month: string, cc1: string | null) => {
  const r = await callRoute(remainingRoute as never, f, f.owner, '/api/accounting/budgets/remaining',
    { lines: [{ glAccountId: f.acc.opex, cc1Id: cc1, month }] });
  expect(r.statusCode, JSON.stringify(r.body)).toBe(200);
  return (r.body.data as { lines: Array<{ actual: number; committed: number; remaining: number }> }).lines[0]!;
};
const approveBill = async (bill: string) => {
  const r = await callRoute(actionRoute as never, f, f.owner, '/api/accounting/supplier-invoices-action', { action: 'approve', invoiceId: bill, budgetReason: 'brk' });
  expect(r.statusCode, JSON.stringify(r.body)).toBe(200);
};

describe('R2-1: a PO line fully billed in a LATER month stays committed forever (spend counted twice)', () => {
  it('PO June 800 approved; its bill dated July 800 approved: June committed should drop to 0', async () => {
    await setPolicy(pool, f, 'warn');
    const { po, items } = await makePo(pool, f, '2026-06', [{ acct: f.acc.opex, amount: 800, cc1: f.cc.FT }]);
    expect((await approvePo(f, f.owner, po)).statusCode).toBe(200);
    const bill = await makeBill(pool, f, [{ acct: f.acc.opex, amount: 800, cc1: f.cc.FT }], { date: '2026-07-05' });
    await linkBillToPo(pool, bill, items[0]!);
    await approveBill(bill);
    expect(await slice('2026-07', f.cc.FT), JSON.stringify(await slice('2026-07', f.cc.FT))).toMatchObject({ actual: 800 });
    // The PO is fully billed: its commitment has turned into July's actual.
    expect(await slice('2026-06', f.cc.FT), JSON.stringify(await slice('2026-06', f.cc.FT))).toMatchObject({ committed: 0, remaining: 1000 });
  });
});

describe('R2-2: the linked bill line carries no CC1 (unassigned slice)', () => {
  it('PO FT 800 approved; bill 800 linked, no CC1, approved: FT stays committed 800 while the 800 is also actual', async () => {
    await setPolicy(pool, f, 'warn');
    const { po, items } = await makePo(pool, f, '2026-08', [{ acct: f.acc.opex, amount: 800, cc1: f.cc.FT }]);
    expect((await approvePo(f, f.owner, po)).statusCode).toBe(200);
    const bill = await makeBill(pool, f, [{ acct: f.acc.opex, amount: 800 }], { date: '2026-08-10' });
    await linkBillToPo(pool, bill, items[0]!);
    await approveBill(bill);
    expect(await slice('2026-08', f.cc.FT), JSON.stringify(await slice('2026-08', f.cc.FT))).toMatchObject({ committed: 0 });
  });
});

describe('R2-3: a linked bill split across two slices', () => {
  it('PO FT 1 000; one bill, 600 FT + 400 HT, both lines linked: FT keeps 400 committed for spend already posted to HT', async () => {
    await setPolicy(pool, f, 'warn');
    const { po, items } = await makePo(pool, f, '2026-09', [{ acct: f.acc.opex, amount: 1000, cc1: f.cc.FT }]);
    expect((await approvePo(f, f.owner, po)).statusCode).toBe(200);
    const bill = await makeBill(pool, f, [{ acct: f.acc.opex, amount: 600, cc1: f.cc.FT }, { acct: f.acc.opex, amount: 400, cc1: f.cc.HT }], { date: '2026-09-10' });
    await pool.query('UPDATE supplier_invoice_items SET po_item_id = $2 WHERE supplier_invoice_id = $1', [bill, items[0]]);
    await approveBill(bill);
    expect(await slice('2026-09', f.cc.HT), JSON.stringify(await slice('2026-09', f.cc.HT))).toMatchObject({ actual: 400 });
    expect(await slice('2026-09', f.cc.FT), JSON.stringify(await slice('2026-09', f.cc.FT))).toMatchObject({ actual: 600, committed: 0 });
  });
});
