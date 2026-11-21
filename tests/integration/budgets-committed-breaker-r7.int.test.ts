/**
 * PR #1703, ledger breaker round 7 (ported from its zz-b7 repros at 35b7fdd191), real PostgreSQL 16:
 *   B7-1  the per-(bill, PO) floor is decided over every line of the bill naming the PO: a committed figure (and a block decision)
 *         never depends on which budget keys are read together;
 *   B7-2  get_purchase_order's per-line amount_billed (first 40 lines) agrees with billed_total and committed;
 *   B7-4  the unlink warns, and records raised_committed, only when the removed tie counted (a billed live bill, attributed > 0)
 *         and committed rose: a draft's unlink warns nothing although a concurrent cancel raises committed meanwhile.
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { dropBillFixture, makeBill, openRequest, seedBillFixture, setPolicy, type BillFixture } from './helpers/budgetBillFixture';
import { callTool } from './helpers/poImportHarness';
import { seedPo, seedRawBill, type SeededPo } from './helpers/poBillLinkHarness';
import { getPurchaseOrderTool as getPo } from '@/lib/mcp/tools/getPurchaseOrder';
import { unlinkBillFromPurchaseOrderTool as unlink } from '@/lib/mcp/tools/writeUnlinkBillFromPurchaseOrder';
import { approveSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { BudgetExceededError } from '@/modules/accounting/services/budgets/budgetCheckTypes';
import { readCommitments } from '@/modules/accounting/services/budgets/remainingCommitted';
import { remainingFor } from '@/modules/accounting/services/budgets/remainingBudget';
import { openPoLineCents } from '@/modules/accounting/services/budgets/remainingBudgetCore';
import { billedCentsByPo } from '@/modules/accounting/services/ap/purchaseOrderBilled';
import { poCommittedCents } from '@/modules/accounting/services/ap/purchaseOrderBillingClose';
import type { McpToolContext } from '@/lib/mcp/types';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
let f: BillFixture;
beforeAll(async () => { f = await seedBillFixture(pool, 'brk-r7'); await setPolicy(pool, f, 'warn'); }, 60_000);
afterAll(async () => { try { await dropBillFixture(pool, f); } finally { await pool.end(); } }, 60_000);

const billed = async (po: SeededPo) => (await billedCentsByPo(f.co, [po.po])).get(po.po.toLowerCase()) ?? 0;
const lineCommitted = async (accounts: string[], item: string) => {
  const rows = await readCommitments(f.co, accounts, '2026-06-01', '2026-06-30', {});
  const r = rows.find((x) => x.poItemId === item);
  return r ? openPoLineCents(r.lineTotal, r.billed) : null;
};
const ui = { channel: 'ui' as const, lock: 'take' as const, reason: 'b7', actorRole: 'owner' };
const outcome = (p: Promise<unknown>) => p.then(() => 'approved', (err: unknown) => (err instanceof BudgetExceededError ? 'refused' : err));

describe('B7-1 the per-(bill, PO) floor is taken over every line of the bill naming the PO, not the requested ones', () => {
  it('PO A R500 (opex) / B R500 (travel); approved bill +300 on A, -500 on B, +1000 unnamed: nets P nothing; A commits 500 whatever is asked', async () => {
    const po = await seedPo(pool, f, { lines: [500, 500] });
    await pool.query('UPDATE po_items SET gl_account_id = $2 WHERE id = $1', [po.items[1], f.acc.travel]);
    await seedRawBill(pool, f, { items: [{ total: 300, poItem: po.items[0] }, { total: -500, poItem: po.items[1] }, { total: 1000 }], subtotal: 800, total: 920 });
    const both = await lineCommitted([f.acc.opex, f.acc.travel], po.items[0]!);
    const opexOnly = await lineCommitted([f.acc.opex], po.items[0]!);
    const svc = (await poCommittedCents(f.co, [po.po])).get(po.po.toLowerCase());
    const key = { glAccountId: f.acc.opex, cc1Id: null, cc2Id: null, buId: null, month: '2026-06' };
    const keyT = { glAccountId: f.acc.travel, cc1Id: null, cc2Id: null, buId: null, month: '2026-06' };
    const alone = (await remainingFor(f.co, [key]))[0]!;
    const withTravel = (await remainingFor(f.co, [key, keyT]))[0]!;
    expect(await billed(po)).toBe(0);
    expect([opexOnly, both, svc]).toEqual([50000, 50000, 100000]);
    expect(alone.committed).toBe(withTravel.committed);
  });
});

describe('B7-2 get_purchase_order amount_billed: the floor over every line, not the first 40', () => {
  it('41 lines of R100; bill +60 on line 0, -100 on line 40, +500 unnamed: billed_total 0, so line 0 amount_billed must be 0', async () => {
    const po = await seedPo(pool, f, { lines: Array.from({ length: 41 }, () => 100) });
    await seedRawBill(pool, f, { items: [{ total: 60, poItem: po.items[0] }, { total: -100, poItem: po.items[40] }, { total: 500 }], subtotal: 460, total: 529 });
    const d = JSON.parse((await callTool(pool, f, getPo, { po_id: po.po })).text);
    const l0 = (d.lines as Array<{ id: string; amount_billed: number; outstanding_amount_to_bill: number }>).find((l) => l.id === po.items[0])!;
    const c0 = await lineCommitted([f.acc.opex], po.items[0]!);
    expect(l0.amount_billed).toBe(0);
    expect([d.billed_total, c0]).toEqual([0, 10000]);
  });
});

describe('B7-1b the subset floor reaches a block decision', () => {
  it('opex/FT budget R1000 (June); PO A R500 opex/FT + B R500 travel; bill X +300 A, -500 B, +1000 unnamed; approve a R600 opex/FT bill under block', async () => {
    await setPolicy(pool, f, 'block');
    const po = await seedPo(pool, f, { lines: [500, 500], cc1: f.cc.FT });
    await pool.query('UPDATE po_items SET gl_account_id = $2, cc1_id = NULL WHERE id = $1', [po.items[1], f.acc.travel]);
    await seedRawBill(pool, f, { items: [{ total: 300, poItem: po.items[0] }, { total: -500, poItem: po.items[1] }, { total: 1000 }], subtotal: 800, total: 920 });
    // seedRawBill posts no journal, so June opex/FT actual is 0: remaining = 1000 - committed(A).
    const key = { glAccountId: f.acc.opex, cc1Id: f.cc.FT, cc2Id: null, buId: null, month: '2026-06' };
    const keyT = { glAccountId: f.acc.travel, cc1Id: null, cc2Id: null, buId: null, month: '2026-06' };
    const alone = (await remainingFor(f.co, [key]))[0]!;
    const paired = (await remainingFor(f.co, [key, keyT]))[0]!;
    const bill = await makeBill(pool, f, [{ acct: f.acc.opex, amount: 600, cc1: f.cc.FT }], { date: '2026-06-20' });
    const req = await openRequest(pool, f, f.owner);
    const res = await outcome(req.run(() => approveSupplierInvoice(f.co, bill, f.owner, { budget: ui })));
    await req.rollback();
    expect(alone.committed).toBe(paired.committed);
    expect(res).toBe('refused');
  });
});

describe('B7-4 the unlink warns only for a tie that counted, whatever a concurrent cancel moves', () => {
  it('open PO R1000; Y (approved) nets 300 by lines; X (DRAFT) names the line; a concurrent cancel of Y commits mid-unlink of X', async () => {
    await setPolicy(pool, f, 'warn');
    const po = await seedPo(pool, f, { lines: [1000] }); // opex, cc1 null: off-slice on the cc1-grain opex budget, so any rise warns
    const y = await seedRawBill(pool, f, { items: [{ total: 300, poItem: po.items[0] }], subtotal: 300, total: 345 });
    const x = await seedRawBill(pool, f, { items: [{ total: 100, poItem: po.items[0] }], subtotal: 100, total: 115, status: 'draft' });
    const before = (await poCommittedCents(f.co, [po.po])).get(po.po.toLowerCase());
    const t2 = await pool.connect();
    await t2.query('BEGIN');
    await t2.query(`UPDATE supplier_invoices SET status = 'cancelled' WHERE id = $1`, [y.id]);
    await t2.query('SELECT 1 FROM supplier_invoice_items WHERE supplier_invoice_id = $1 FOR UPDATE', [x.id]);
    const ctx = { userId: f.owner, companyId: f.co, scopes: ['write:invoices', 'read:invoices', 'read:reports'], tokenJti: 'b7', oauthAppId: null, companyRole: 'owner' } as McpToolContext;
    const req = await openRequest(pool, f, f.owner);
    const p = req.run(() => unlink.handler({ idempotency_key: 'b7-4', po_id: po.po, bill_id: x.id, reason: 'wrong PO' }, ctx));
    let blocked = false;
    for (let i = 0; i < 200 && !blocked; i++) {
      blocked = ((await pool.query('SELECT 1 FROM pg_locks WHERE pid = $1 AND NOT granted', [req.pid])).rowCount ?? 0) > 0;
      if (!blocked) await new Promise((r) => setTimeout(r, 25));
    }
    await t2.query('COMMIT'); t2.release();
    const out = await p; await req.commit();
    const body = JSON.parse(out.content[0]!.text);
    const audit = (await pool.query(`SELECT changes->'metadata'->>'raised_committed' AS r FROM audit_log WHERE company_id = $1 AND entity_id = $2::UUID ORDER BY created_at DESC LIMIT 1`, [f.co, po.po]).catch(() => ({ rows: [] }))).rows[0];
    expect(body.budget_warnings ?? []).toEqual([]);
    expect(audit?.r).toBe('false');
  });
});
