/**
 * Budgets P5-3 (spec §3a decision 8a, §4 preview, §9 acceptance "an approved PO reduces remaining for the next bill,
 * and that bill's own PO lines are not double counted"), real route (withAuth → app_user), real PostgreSQL:
 *   - once approved, the PO's lines are committed in `remainingFor` (P5-1's remainingCommitted) for the next bill;
 *   - a bill linked to the PO line (po_item_id) is not counted twice: approving it in block mode passes where an
 *     unlinked bill of the same amount is refused;
 *   - POST /api/accounting/budgets/remaining { purchaseOrderId }: the approve dialog's preview — the PO's own
 *     commitment excluded, a line with no account shown as "No account" / No budget, 404 for another company's PO,
 *     strict body shapes.
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import remainingRoute from '../../pages/api/accounting/budgets/remaining';
import actionRoute from '../../pages/api/accounting/supplier-invoices-action';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import {
  billState, callRoute, dropBillFixture, linkBillToPo, makeBill, seedBillFixture, setPolicy, type BillFixture,
} from './helpers/budgetBillFixture';
import { approvePo, makePo } from './helpers/budgetPoFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let f: BillFixture;
let other: BillFixture;

beforeAll(async () => {
  f = await seedBillFixture(pool, 'po-commit');
  other = await seedBillFixture(pool, 'po-commit-other');
}, 60_000);
afterAll(async () => {
  try {
    await pool.query('DELETE FROM rate_limit_counters WHERE key = ANY($1::TEXT[])', [[f.owner, f.manager].map((u) => `budget-remaining:${u}`)]);
    await dropBillFixture(pool, f);
    await dropBillFixture(pool, other);
  } finally {
    await pool.end();
  }
}, 60_000);

const preview = (body: unknown, fx: BillFixture = f) => callRoute(remainingRoute as never, fx, fx.owner, '/api/accounting/budgets/remaining', body);
const remainingOf = async (month: string) => {
  const r = await preview({ lines: [{ glAccountId: f.acc.opex, cc1Id: f.cc.FT, month }] });
  expect(r.statusCode).toBe(200);
  return (r.body.data as { lines: Array<{ committed: number; remaining: number }> }).lines[0]!;
};
const approveBill = (bill: string) =>
  callRoute(actionRoute as never, f, f.manager, '/api/accounting/supplier-invoices-action', { action: 'approve', invoiceId: bill });

describe('an approved PO is committed for the next bill', () => {
  it('approval moves the PO into committed; a linked bill is not double counted, an unlinked one is refused', async () => {
    await setPolicy(pool, f, 'block');
    const { po, items } = await makePo(pool, f, '2026-06', [{ acct: f.acc.opex, amount: 700, cc1: f.cc.FT }]);
    expect(await remainingOf('2026-06')).toMatchObject({ committed: 0, remaining: 1000 }); // a draft commits nothing
    expect((await approvePo(f, f.manager, po)).statusCode).toBe(200);
    expect(await remainingOf('2026-06')).toMatchObject({ committed: 700, remaining: 300 });

    // 400 against 300 left: refused.
    const unlinked = await makeBill(pool, f, [{ acct: f.acc.opex, amount: 400, cc1: f.cc.FT }], { date: '2026-06-20' });
    expect((await approveBill(unlinked)).statusCode).toBe(409);
    // 700 billed against the PO line itself: its own commitment is released for it, so it fits.
    const linked = await makeBill(pool, f, [{ acct: f.acc.opex, amount: 700, cc1: f.cc.FT }], { date: '2026-06-20' });
    await linkBillToPo(pool, linked, items[0]!);
    const r = await approveBill(linked);
    expect(r.statusCode, JSON.stringify(r.body)).toBe(200);
    expect((await billState(pool, linked)).status).toBe('approved');
    // Afterwards: actual 700, the PO line fully billed (committed 0), remaining 300.
    expect(await remainingOf('2026-06')).toMatchObject({ committed: 0, remaining: 300 });
  });
});

describe('POST /budgets/remaining { purchaseOrderId }', () => {
  it('previews the PO against everything but itself: an approved PO does not count its own commitment', async () => {
    await setPolicy(pool, f, 'warn');
    const { po } = await makePo(pool, f, '2026-07', [{ acct: f.acc.opex, amount: 700, cc1: f.cc.FT }]);
    expect((await approvePo(f, f.owner, po)).statusCode).toBe(200);
    const r = await preview({ purchaseOrderId: po });
    expect(r.statusCode).toBe(200);
    expect(r.body.data).toMatchObject({ policy: 'warn', checks: true, overCount: 0, status: 'approved', approvable: false });
    expect((r.body.data as { lines: unknown[] }).lines).toEqual([expect.objectContaining({
      month: '2026-07', budget: 1000, committed: 0, remaining: 1000, amount: 700, over: false, accountLabel: 'BB-6100 Opex', sliceLabel: 'FT Fibertime',
    })]);
  });

  it('a draft PO over budget: overCount, its lines labelled; a line with no account is "No account" with no budget', async () => {
    await setPolicy(pool, f, 'block');
    const { po } = await makePo(pool, f, '2026-08', [{ acct: f.acc.opex, amount: 1200, cc1: f.cc.FT }, { acct: null, amount: 50, cc1: f.cc.HT }]);
    const r = await preview({ purchaseOrderId: po });
    expect(r.statusCode).toBe(200);
    expect(r.body.data).toMatchObject({ policy: 'block', checks: true, overCount: 1, status: 'draft', approvable: true });
    expect((r.body.data as { lines: unknown[] }).lines).toEqual([
      expect.objectContaining({ budget: 1000, amount: 1200, over: true }),
      expect.objectContaining({ glAccountId: '', accountLabel: 'No account', sliceLabel: 'HT Hometech', budget: null, remaining: null, amount: 50, over: false }),
    ]);
  });

  it('policy off: checks false, no lines', async () => {
    await setPolicy(pool, f, 'off');
    const { po } = await makePo(pool, f, '2026-08', [{ acct: f.acc.opex, amount: 1200, cc1: f.cc.FT }]);
    expect((await preview({ purchaseOrderId: po })).body.data).toMatchObject({ policy: 'off', checks: false, lines: [], overCount: 0 });
  });

  it('another company\'s PO is 404; body shapes are strict (422)', async () => {
    const { po } = await makePo(pool, other, '2026-08', [{ acct: other.acc.opex, amount: 10, cc1: other.cc.FT }]);
    expect((await preview({ purchaseOrderId: po })).statusCode).toBe(404);
    expect((await preview({ purchaseOrderId: po }, other)).statusCode).toBe(200);
    for (const body of [{ purchaseOrderId: 'x' }, { purchaseOrderId: po, extra: 1 }, { purchaseOrderId: po, supplierInvoiceId: po },
      { purchaseOrderId: po, lines: [] }]) {
      expect((await preview(body)).statusCode, JSON.stringify(body)).toBe(422);
    }
  });
});
