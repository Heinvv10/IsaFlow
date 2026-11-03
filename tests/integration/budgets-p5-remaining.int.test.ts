/**
 * Budgets P5 T4 (spec §3a, §6 T4), on real PostgreSQL as app_user under forced RLS:
 * `remainingFor` reads the primary version's budget at the account's grain, the actual through
 * P3's actuals read (invariant 1: equal to Budget vs Actual for the same key), and the committed
 * spend of approved POs net of the ex-VAT bill lines linked to each PO line.
 * Seed: helpers/budgetTrackingFixture.ts (FY2027 = Mar 2026 - Apr 2027, primary 'Original':
 * sales at CC2, COS at CC1, opex at company level, interest at BU, finance cost at CC2 PN).
 *
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { remainingFor, type RemainingKey } from '@/modules/accounting/services/budgets/remainingBudget';
import { buildRangeTracking, type RangeTrackingOptions } from '@/modules/accounting/services/budgets/tracking/trackingRange';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { asRequest, dropTrackingFixture, seedTrackingFixture, type TrackingFixture } from './helpers/budgetTrackingFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let f: TrackingFixture;

beforeAll(async () => { f = await seedTrackingFixture(pool); }, 120_000);
afterAll(async () => {
  try { await dropTrackingFixture(pool, f); } finally { await pool.end(); }
});

const key = (acct: string, month: string, dims: Partial<Pick<RemainingKey, 'cc1Id' | 'cc2Id' | 'buId'>> = {}): RemainingKey =>
  ({ glAccountId: acct, cc1Id: null, cc2Id: null, buId: null, month, ...dims });
const asA = <T>(fn: () => Promise<T>, before?: (c: PoolClient) => Promise<unknown>) =>
  asRequest(pool, f.a, f.userA, fn, { appUser: true, before });

/** BvA's actual for one account over one whole month under a filter, the same request. */
async function bvaActual(acct: string, month: string, opts: RangeTrackingOptions): Promise<number | undefined> {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const r = await buildRangeTracking(f.a, `${month}-01`, `${month}-${String(last)}`, { ...opts, wholeMonthsOnly: true });
  return r.lines.find((l) => l.accountId === acct)?.actual;
}

describe('remainingFor: budget and actual at the account\'s grain', () => {
  it('actual equals the Budget vs Actual actual for the same key, at every grain (invariant 1)', async () => {
    const { acc, cc, bu } = f;
    await asA(async () => {
      const cases: Array<[RemainingKey, RangeTrackingOptions, number]> = [
        [key(acc.opex, '2026-04'), {}, 200],
        [key(acc.cos, '2026-04', { cc1Id: cc.FT }), { cc1Id: cc.FT }, 40],
        [key(acc.sales, '2026-04', { cc1Id: cc.FT, cc2Id: cc.P1, buId: bu.B1 }), { cc2Id: cc.P1 }, 100],
        [key(acc.interest, '2026-07', { buId: bu.B1 }), { buId: bu.B1 }, 5],
      ];
      const out = await remainingFor(f.a, cases.map(([k]) => k));
      for (const [i, [k, filter, budget]] of cases.entries()) {
        const bva = await bvaActual(k.glAccountId, k.month, filter);
        expect(bva, `BvA actual for ${k.glAccountId}`).toBeDefined();
        expect(out[i]!.actual).toBe(bva);
        expect(out[i]!.actual).not.toBe(0);
        expect(out[i]!.budget).toBe(budget);
        expect(out[i]!.remaining).toBe(Math.round((budget - out[i]!.actual - out[i]!.committed) * 100) / 100);
        expect(out[i]!.versionId).toBe(f.v.primary27);
      }
      expect(out.map((r) => r.grain)).toEqual(['company', 'cc1', 'cc2', 'bu']);
    });
  });

  it('maps the line\'s dimensions onto the grain; a line lacking the grain\'s dimension is the unassigned slice → null', async () => {
    const { acc, cc, bu } = f;
    await asA(async () => {
      const [full, bare, otherMember] = await remainingFor(f.a, [
        key(acc.cos, '2026-04', { cc1Id: cc.FT, cc2Id: cc.P1, buId: bu.B1 }),
        key(acc.cos, '2026-04', { cc2Id: cc.P1, buId: bu.B1 }),
        key(acc.fin, '2026-04', { cc2Id: cc.P1 }),
      ]);
      expect(full).toMatchObject({ grain: 'cc1', slice: { cc1Id: cc.FT, cc2Id: null, buId: null }, budget: 40, unassigned: false });
      expect(bare).toMatchObject({ grain: 'cc1', unassigned: true, budget: null, remaining: null });
      // Finance cost is budgeted at CC2 PN only: P1 has no row for it → No budget.
      expect(otherMember).toMatchObject({ grain: 'cc2', unassigned: false, budget: null, remaining: null });
    });
  });

  it('no primary version for the month\'s year → budget null; a zero budget is 0, never null', async () => {
    const { acc } = f;
    const zero = (c: PoolClient) => c.query(
      `UPDATE budget_month_amounts SET amount = 0 WHERE company_id = $1 AND version_id = $2 AND gl_account_id = $3 AND month = '2026-06-01'`,
      [f.a, f.v.primary27, acc.opex]);
    await asA(async () => {
      const [noVersion, zeroBudget] = await remainingFor(f.a, [key(acc.opex, '2026-01'), key(acc.opex, '2026-06')]);
      expect(noVersion).toMatchObject({ versionId: null, grain: null, budget: null, remaining: null });
      expect(noVersion!.actual).toBeGreaterThan(0);
      expect(zeroBudget!.budget).toBe(0);
      expect(zeroBudget!.remaining).toBe(Math.round(-(zeroBudget!.actual + zeroBudget!.committed) * 100) / 100);
      expect(zeroBudget!.remaining).toBeLessThan(0);
    }, zero);
  });

  it('another company\'s account or centre reads as nothing', async () => {
    await asA(async () => {
      const [r] = await remainingFor(f.a, [key(f.acc.bSales, '2026-06', { cc1Id: f.cc.BX })]);
      expect(r).toMatchObject({ budget: null, actual: 0, committed: 0, remaining: null, versionId: f.v.primary27, grain: null });
    });
  });
});

describe('remainingFor: committed PO spend', () => {
  const ids = { sup: crypto.randomUUID(), po1: crypto.randomUUID(), po2: crypto.randomUUID(), poDraft: crypto.randomUUID(),
    item1: crypto.randomUUID(), item2: crypto.randomUUID(), itemDraft: crypto.randomUUID(), itemMay: crypto.randomUUID(),
    billApproved: crypto.randomUUID(), billDraft: crypto.randomUUID(), billOver: crypto.randomUUID(), billOther: crypto.randomUUID() };
  /** Rolled back with the request: POs and bills seeded as the owner, read as app_user. */
  async function seedPos(c: PoolClient): Promise<void> {
    const { a, acc, cc } = { a: f.a, acc: f.acc, cc: f.cc };
    await c.query('INSERT INTO suppliers (id, company_id, name) VALUES ($1, $2, $3)', [ids.sup, a, 'P5 remaining supplier']);
    for (const [id, num, date, status] of [[ids.po1, 'PO-1', '2026-04-10', 'approved'], [ids.po2, 'PO-2', '2026-04-20', 'partially_received'],
      [ids.poDraft, 'PO-D', '2026-04-11', 'draft']] as const) {
      await c.query(`INSERT INTO purchase_orders (id, company_id, po_number, supplier_id, order_date, status) VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, a, num, ids.sup, date, status]);
    }
    const item = (id: string, poId: string, total: number, dims: { cc1?: string } = {}) => c.query(
      `INSERT INTO po_items (id, purchase_order_id, description, quantity, unit_price, line_total, gl_account_id, cc1_id)
       VALUES ($1, $2, 'x', 1, $3, $3, $4, $5)`, [id, poId, total, acc.opex, dims.cc1 ?? null]);
    await item(ids.item1, ids.po1, 1000, { cc1: cc.FT });
    await item(ids.item2, ids.po2, 300);
    await item(ids.itemDraft, ids.poDraft, 5000);
    // Another month (PO-1 is April; this line is on a May order).
    await c.query(`INSERT INTO purchase_orders (id, company_id, po_number, supplier_id, order_date, status) VALUES ($1, $2, 'PO-M', $3, '2026-05-02', 'approved')`,
      [ids.itemMay, a, ids.sup]);
    await item(crypto.randomUUID(), ids.itemMay, 7000);
    // Net storage (line_total ex-VAT, subtotal = Σ lines, 15% VAT on top), one line each: approve posts the subtotal.
    const bill = (id: string, num: string, status: string, net: number) => c.query(
      `INSERT INTO supplier_invoices (id, company_id, invoice_number, supplier_id, invoice_date, subtotal, tax_rate, tax_amount, total_amount, created_by, status)
       VALUES ($1, $2, $3, $4, '2026-04-25', $7, 15, $7 * 0.15, $7 * 1.15, $5, $6)`, [id, a, num, ids.sup, f.userA, status, net]);
    await bill(ids.billApproved, 'B-APP', 'approved', 400);
    await bill(ids.billDraft, 'B-DRAFT', 'draft', 100);
    await bill(ids.billOver, 'B-OVER', 'paid', 500);
    await bill(ids.billOther, 'B-OTHER', 'cancelled', 50);
    const line = (billId: string, poItem: string, total: number) => c.query(
      `INSERT INTO supplier_invoice_items (supplier_invoice_id, po_item_id, description, quantity, unit_price, line_total, gl_account_id)
       VALUES ($1, $2, 'x', 1, $3, $3, $4)`, [billId, poItem, total, acc.opex]);
    await line(ids.billApproved, ids.item1, 400);
    await line(ids.billDraft, ids.item1, 100);
    await line(ids.billOver, ids.item2, 500);
    await line(ids.billOther, ids.item2, 50);
  }
  const before = async (c: PoolClient) => {
    await c.query('SET LOCAL session_replication_role = replica');
    await seedPos(c);
    await c.query('SET LOCAL session_replication_role = origin');
  };

  it('nets the ex-VAT bill lines linked to each PO line (approved/paid bills only), floored at zero per line', async () => {
    await asA(async () => {
      const [april, may] = await remainingFor(f.a, [key(f.acc.opex, '2026-04'), key(f.acc.opex, '2026-05')]);
      // item1 1000 − 400 (approved; the draft 100 does not count) + item2 max(0, 300 − 500) = 600. The draft PO counts nothing.
      expect(april!.committed).toBe(600);
      expect(april!.remaining).toBe(Math.round((200 - april!.actual - 600) * 100) / 100);
      expect(may!.committed).toBe(7000);
    }, before);
  });

  it('the bill being checked counts as billed against its own PO lines; excluded PO lines count nothing', async () => {
    await asA(async () => {
      const [own] = await remainingFor(f.a, [key(f.acc.opex, '2026-04')], { excludeInvoiceId: ids.billDraft });
      expect(own!.committed).toBe(500);
      const [excl] = await remainingFor(f.a, [key(f.acc.opex, '2026-04')], { excludePoItemIds: [ids.item1] });
      expect(excl!.committed).toBe(0);
    }, before);
  });

  it('nets a bill line at the ex-VAT amount approve posts, not its stored line_total (VAT-inclusive storage, census finding 3)', async () => {
    // A bill stored gross: two lines of R575.00 incl. 15% VAT, total R1 150.00, subtotal R1 000.00. Approve posts
    // R500.00 for each line (buildExpenseLines scales gross lines to the subtotal). One line is linked to a R2 000 PO line.
    const vatBill = async (c: PoolClient) => {
      const sup = crypto.randomUUID(), po = crypto.randomUUID(), item = crypto.randomUUID(), bill = crypto.randomUUID();
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query('INSERT INTO suppliers (id, company_id, name) VALUES ($1, $2, $3)', [sup, f.a, 'P5 VAT supplier']);
      await c.query(`INSERT INTO purchase_orders (id, company_id, po_number, supplier_id, order_date, status) VALUES ($1, $2, 'PO-VAT', $3, '2026-04-03', 'approved')`,
        [po, f.a, sup]);
      await c.query(`INSERT INTO po_items (id, purchase_order_id, description, quantity, unit_price, line_total, gl_account_id) VALUES ($1, $2, 'x', 1, 2000, 2000, $3)`,
        [item, po, f.acc.opex]);
      await c.query(`INSERT INTO supplier_invoices (id, company_id, invoice_number, supplier_id, invoice_date, subtotal, tax_rate, tax_amount, total_amount, created_by, status)
                     VALUES ($1, $2, 'B-VAT', $3, '2026-04-25', 1000, 15, 150, 1150, $4, 'approved')`, [bill, f.a, sup, f.userA]);
      for (const [poItem, desc] of [[item, 'a linked'], [null, 'b other']] as const) {
        await c.query(`INSERT INTO supplier_invoice_items (supplier_invoice_id, po_item_id, description, quantity, unit_price, line_total, gl_account_id)
                       VALUES ($1, $2, $3, 1, 575, 575, $4)`, [bill, poItem, desc, f.acc.opex]);
      }
      await c.query('SET LOCAL session_replication_role = origin');
    };
    await asA(async () => {
      const [r] = await remainingFor(f.a, [key(f.acc.opex, '2026-04')]);
      expect(r!.committed).toBe(1500);
    }, vatBill);
  });

  it('PO lines map onto the account\'s grain like any other spend', async () => {
    // Opex is budgeted at company level, so a CC1-tagged PO line counts there; at a CC1-grain account it would
    // count only for its centre. Move opex's April budget to CC1 FT inside the request to see it.
    const regrain = async (c: PoolClient) => {
      await before(c);
      await c.query(`DELETE FROM budget_month_amounts WHERE company_id = $1 AND version_id = $2 AND gl_account_id = $3`,
        [f.a, f.v.primary27, f.acc.opex]);
      await c.query(`INSERT INTO budget_month_amounts (company_id, version_id, gl_account_id, month, amount, cc1_id)
                     VALUES ($1, $2, $3, '2026-04-01', 2000, $4)`, [f.a, f.v.primary27, f.acc.opex, f.cc.FT]);
    };
    await asA(async () => {
      const [ft, bare] = await remainingFor(f.a, [key(f.acc.opex, '2026-04', { cc1Id: f.cc.FT }), key(f.acc.opex, '2026-04')]);
      // P5-3 security review: the approved bill linked to PO-1's FT line posted with NO CC1 (the unassigned slice), so
      // at CC1 grain it no longer releases the FT commitment: FT stays committed in full (it netted 400 at company grain).
      expect(ft).toMatchObject({ grain: 'cc1', budget: 2000, committed: 1000 });
      expect(bare).toMatchObject({ grain: 'cc1', unassigned: true, budget: null, committed: 0 });
    }, regrain);
  });
});
