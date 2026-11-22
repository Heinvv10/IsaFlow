/**
 * PR #1703, ledger breaker round 8 (ported from its zz-b8 repros at fbc332c417), real PostgreSQL 16:
 *   net then spread  per (bill, PO) a bill bills max(0, net of all its postings to that PO), spread over its POSITIVE postings
 *                    there pro rata, a negative posting taking nothing (billAttribution's figure, line by line):
 *     B8-1  a bill netting 0 on its PO releases nothing, so unlinking it raises nothing and warns nothing;
 *     B8-2  such a bill leaves the PO committing in full (and a block approval over it is refused);
 *     B8-3  -200 on A and +300 on B bills R100 on B: a header bill then fills the rest, fully billed, committed 0;
 *   B8-4  the link's header budget read runs in its own savepoint: a failed read never blocks the link.
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { dropBillFixture, makeBill, openRequest, seedBillFixture, setPolicy, type BillFixture } from './helpers/budgetBillFixture';
import { callTool } from './helpers/poImportHarness';
import { seedPo, seedRawBill, type SeededPo } from './helpers/poBillLinkHarness';
import { linkBillsToPurchaseOrderTool as link } from '@/lib/mcp/tools/writeLinkBillsToPurchaseOrder';
import { unlinkBillFromPurchaseOrderTool as unlink } from '@/lib/mcp/tools/writeUnlinkBillFromPurchaseOrder';
import { approveSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { BudgetExceededError } from '@/modules/accounting/services/budgets/budgetCheckTypes';
import { readCommitments } from '@/modules/accounting/services/budgets/remainingCommitted';
import { remainingFor } from '@/modules/accounting/services/budgets/remainingBudget';
import { openPoLineCents } from '@/modules/accounting/services/budgets/remainingBudgetCore';
import { billedCentsByPo } from '@/modules/accounting/services/ap/purchaseOrderBilled';
import { poCommittedCents } from '@/modules/accounting/services/ap/purchaseOrderBillingClose';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
let f: BillFixture;
beforeAll(async () => { f = await seedBillFixture(pool, 'brk-r8'); await setPolicy(pool, f, 'warn'); }, 60_000);
afterAll(async () => { try { await dropBillFixture(pool, f); } finally { await pool.end(); } }, 60_000);

const lines = async (po: SeededPo) => {
  const rows = await readCommitments(f.co, [f.acc.opex], '2026-06-01', '2026-06-30', {});
  return po.items.map((id) => { const r = rows.find((x) => x.poItemId === id); return r ? openPoLineCents(r.lineTotal, r.billed) : 0; });
};
const svc = async (po: SeededPo) => (await poCommittedCents(f.co, [po.po])).get(po.po.toLowerCase()) ?? 0;
const billed = async (po: SeededPo) => (await billedCentsByPo(f.co, [po.po])).get(po.po.toLowerCase()) ?? 0;
const lastUnlinkAudit = async (po: SeededPo) => (await pool.query(
  `SELECT changes->'metadata'->>'raised_committed' AS raised FROM audit_log WHERE entity_id::TEXT = $1::TEXT AND changes->'metadata' ? 'unlinked_bill' ORDER BY created_at DESC LIMIT 1`,
  [po.po])).rows[0]?.raised ?? null;
const ui = { channel: 'ui' as const, lock: 'take' as const, reason: 'b8', actorRole: 'owner' };
const outcome = (p: Promise<unknown>) => p.then(() => 'approved', (err: unknown) => (err instanceof BudgetExceededError ? 'refused' : err));

describe('B8-1 / B8-2 a bill netting 0 on its PO bills it nothing', () => {
  for (const [a, b] of [[500, -500], [800, -800]] as const) {
    it(`+${a} on A, ${b} on B: committed in full; unlinking it moves nothing, warns nothing, raised_committed false`, async () => {
      const po = await seedPo(pool, f, { lines: [500, 500] });
      const x = await seedRawBill(pool, f, { items: [{ total: a, poItem: po.items[0] }, { total: b, poItem: po.items[1] }], subtotal: 0, total: 0 });
      expect({ billed: await billed(po), lines: await lines(po), svc: await svc(po) }).toEqual({ billed: 0, lines: [50000, 50000], svc: 100000 });
      const u = await callTool(pool, f, unlink, { po_id: po.po, bill_id: x.id, reason: 'wrong PO' });
      expect([u.isError, u.body.budget_warnings, await svc(po), await lastUnlinkAudit(po)], u.text).toEqual([false, [], 100000, 'false']);
    });
  }
  it('B8-2b: opex/FT budget R1000; that PO commits R1000 on the slice, so a R400 opex/FT bill is refused under block', async () => {
    await setPolicy(pool, f, 'block');
    try {
      const po = await seedPo(pool, f, { lines: [500, 500], cc1: f.cc.FT });
      await seedRawBill(pool, f, { items: [{ total: 500, poItem: po.items[0] }, { total: -500, poItem: po.items[1] }], subtotal: 0, total: 0 });
      const key = { glAccountId: f.acc.opex, cc1Id: f.cc.FT, cc2Id: null, buId: null, month: '2026-06' };
      expect((await remainingFor(f.co, [key]))[0]!.committed).toBe(1000);
      const bill = await makeBill(pool, f, [{ acct: f.acc.opex, amount: 400, cc1: f.cc.FT }], { date: '2026-06-20' });
      const req = await openRequest(pool, f, f.owner);
      const res = await outcome(req.run(() => approveSupplierInvoice(f.co, bill, f.owner, { budget: ui })));
      await req.rollback();
      expect(res).toBe('refused');
    } finally { await setPolicy(pool, f, 'warn'); }
  });
});

describe('B8-3 a negative line under the header room', () => {
  it('-200 on A and +300 on B (bills R100, on B); a R1000 header link: fully billed, committed 0', async () => {
    const po = await seedPo(pool, f, { lines: [500, 500] });
    await seedRawBill(pool, f, { items: [{ total: -200, poItem: po.items[0] }, { total: 300, poItem: po.items[1] }], subtotal: 100, total: 115 });
    const h = await seedRawBill(pool, f, { items: [{ total: 1000 }], subtotal: 1000, total: 1150 });
    const r = await callTool(pool, f, link, { links: [{ po_id: po.po, bill_id: h.id, amount: 1000 }] });
    const reply = (r.body.purchase_orders as Array<{ fully_billed: boolean }>)[0]!;
    expect({ linkFullyBilled: reply.fully_billed, billed: await billed(po), lines: await lines(po), svc: await svc(po) })
      .toEqual({ linkFullyBilled: true, billed: 110000, lines: [0, 0], svc: 0 });
  });
});

describe('B8-4 the link\'s header budget read cannot block the link', () => {
  it('H header-ties Z; link R300 of H to P while the budget settings are unreadable: the link is made, Z\'s warning says so', async () => {
    const z = await seedPo(pool, f, { lines: [1000] });
    const p = await seedPo(pool, f, { lines: [300] });
    const h = await seedRawBill(pool, f, { items: [{ total: 1000 }], subtotal: 1000, total: 1150, header: z.po });
    await pool.query('ALTER TABLE budget_control_settings RENAME TO budget_control_settings_r8b_hidden');
    let r: Awaited<ReturnType<typeof callTool>>;
    try {
      r = await callTool(pool, f, link, { links: [{ po_id: p.po, bill_id: h.id, amount: 300 }] });
    } finally {
      await pool.query('ALTER TABLE budget_control_settings_r8b_hidden RENAME TO budget_control_settings');
    }
    expect(r.isError, r.text).toBe(false);
    expect((r.body.budget_warnings as string[]).join(' ')).toContain('The budget could not be checked just now');
    expect((await pool.query('SELECT count(*)::INT AS n FROM purchase_order_bill_links WHERE supplier_invoice_id = $1 AND purchase_order_id = $2', [h.id, p.po])).rows[0].n).toBe(1);
    expect(await svc(z)).toBe(30000);
  });
});
