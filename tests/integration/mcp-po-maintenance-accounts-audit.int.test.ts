/**
 * Review round 3 (docs/design/mcp-po-maintenance.md), real PostgreSQL, as app_user:
 *   - ONE rule for every writer of an approved PO: under the block budget policy no line without an account. Update, import (open),
 *     set status -> approved all refuse it; warn allows; a draft allows; the import's skip flag lets it through and reports it as
 *     would-have-failed;
 *   - audit: set status leaving closed names the links whose closing record it cleared; an approved PO's line replacement records the
 *     prior lines (account, dimensions, quantity, amount; capped at 20 with a total).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { dropBillFixture, seedBillFixture, setPolicy, type BillFixture } from './helpers/budgetBillFixture';
import { callTool, poCount, sagePo } from './helpers/poImportHarness';
import { seedBill, seedPo } from './helpers/poBillLinkHarness';
import { auditOf, dropMaintExtras, poLines, poRow, seedQtyPo } from './helpers/poMaintHarness';
import { bulkCreatePurchaseOrdersTool as create } from '@/lib/mcp/tools/writeBulkPurchaseOrders';
import { setPurchaseOrderStatusTool as setStatus } from '@/lib/mcp/tools/writeSetPurchaseOrderStatus';
import { updatePurchaseOrderTool as update } from '@/lib/mcp/tools/writeUpdatePurchaseOrder';
import { linkBillsToPurchaseOrderTool as link } from '@/lib/mcp/tools/writeLinkBillsToPurchaseOrder';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let f: BillFixture;

beforeAll(async () => { f = await seedBillFixture(pool, 'po-maint-accounts-audit'); }, 60_000);
afterEach(async () => { await pool.query("UPDATE purchase_orders SET status = 'cancelled' WHERE company_id = $1 AND status = 'approved'", [f.co]); });
afterAll(async () => { try { await setPolicy(pool, f, 'warn'); await dropMaintExtras(pool, f); await dropBillFixture(pool, f); } finally { await pool.end(); } }, 60_000);

let n = 300;
const accountless = (status: string, ref?: string) => sagePo(++n, f, { status, acct: null, ...(ref ? { ref } : {}) });

describe('no account-less line on an approved PO under block: update, import and set status agree', () => {
  it('import (open): refused whole, live and dry run, nothing created; warn, a draft and a billed PO allow it', async () => {
    await setPolicy(pool, f, 'block');
    const base = await poCount(pool, f);
    for (const dry of [false, true]) {
      const r = await callTool(pool, f, create, { purchase_orders: [sagePo(++n, f, { status: 'draft', acct: null }), accountless('open')], ...(dry ? { dry_run: true } : {}) });
      expect(r.isError, `dry=${dry}`).toBe(true);
      expect(r.text).toContain('purchase_orders[1]: Under the block budget policy every line of an approved purchase order needs an expense account');
    }
    expect(await poCount(pool, f)).toBe(base);
    const fine = await callTool(pool, f, create, { purchase_orders: [sagePo(++n, f, { status: 'draft', acct: null }), accountless('billed'), accountless('cancelled')] });
    expect(fine.isError, fine.text).toBe(false);
    await setPolicy(pool, f, 'warn');
    expect((await callTool(pool, f, create, { purchase_orders: [accountless('open')] })).isError).toBe(false);
  });

  it('import with skip_budget_check_for_import (owner / admin): created, reported as would-have-failed with the reason, audited', async () => {
    await setPolicy(pool, f, 'block');
    const r = await callTool(pool, f, create, { purchase_orders: [accountless('open', 'acc-skip')], skip_budget_check_for_import: true });
    expect(r.isError, r.text).toBe(false);
    const po = (r.body.purchase_orders as Array<{ id: string; budget_check: { would_have_failed: boolean; skipped: boolean; outcome: string; reasons: string[] } }>)[0]!;
    expect(po.budget_check).toMatchObject({ would_have_failed: true, skipped: true, outcome: 'block' });
    expect(po.budget_check.reasons[0]).toContain('needs an expense account');
    expect((r.body.would_have_failed as Array<{ po_number: string }>).length).toBe(1);
    expect((await auditOf(pool, f, po.id))[0]!.changes.metadata).toMatchObject({ budgetCheckSkipped: 'true', wouldHaveFailed: 'true' });
  });

  it('set status -> approved: refused under block when a stored line has no account; allowed under warn, and when every line has one', async () => {
    await setPolicy(pool, f, 'block');
    const bad = await seedQtyPo(pool, f, { external: true, status: 'closed', lines: [{ qty: 1, price: 100 }] });
    await pool.query('UPDATE po_items SET gl_account_id = NULL WHERE purchase_order_id = $1', [bad.po]);
    const good = await seedQtyPo(pool, f, { external: true, status: 'closed', lines: [{ qty: 1, price: 100 }] });
    const refused = await callTool(pool, f, setStatus, { po_id: bad.po, status: 'approved', reason: 'x' });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('needs an expense account');
    expect((await poRow(pool, bad.po)).status).toBe('closed');
    expect((await callTool(pool, f, setStatus, { po_id: good.po, status: 'approved', reason: 'x' })).isError).toBe(false);
    await setPolicy(pool, f, 'warn');
    expect((await callTool(pool, f, setStatus, { po_id: bad.po, status: 'approved', reason: 'x' })).isError).toBe(false);
  });

  it('update keeps its rule (the same text)', async () => {
    await setPolicy(pool, f, 'block');
    const po = await seedPo(pool, f, { lines: [100], acct: f.acc.opex, cc1: f.cc.FT });
    const r = await callTool(pool, f, update, { po_id: po.po, lines: [{ description: 'x', quantity: 1, unit_price: 5, tax_rate: 0 }] });
    expect(r.text).toContain('Under the block budget policy every line of an approved purchase order needs an expense account');
    await setPolicy(pool, f, 'warn');
  });
});

describe('audit rows', () => {
  // PR #1703 R4-1: the closing record lives on the PO (closed_by_billing), cleared by 1022's trigger as the status leaves closed;
  // no link carries one, so the audit row names none.
  it('set status leaving closed clears the PO\'s closed_by_billing, and names no link', async () => {
    await setPolicy(pool, f, 'warn');
    const po = await seedQtyPo(pool, f, { external: true, lines: [{ qty: 1, price: 100 }] });
    const bill = await seedBill(pool, f, { lines: [100] });
    expect((await callTool(pool, f, link, { links: [{ po_id: po.po, bill_id: bill.id }], close_when_fully_billed: true })).isError).toBe(false);
    expect((await pool.query('SELECT closed_by_billing FROM purchase_orders WHERE id = $1', [po.po])).rows[0].closed_by_billing).toBe(true);
    expect((await callTool(pool, f, setStatus, { po_id: po.po, status: 'approved', reason: 'reopen' })).isError).toBe(false);
    expect((await pool.query('SELECT closed_by_billing FROM purchase_orders WHERE id = $1', [po.po])).rows[0].closed_by_billing).toBe(false);
    expect((await auditOf(pool, f, po.po)).at(-1)!.changes.metadata).not.toHaveProperty('cleared_links');
    // A close by hand had no record to clear either.
    const plain = await seedQtyPo(pool, f, { external: true, status: 'closed', lines: [{ qty: 1, price: 100 }] });
    await callTool(pool, f, setStatus, { po_id: plain.po, status: 'approved', reason: 'reopen' });
    expect((await auditOf(pool, f, plain.po)).at(-1)!.changes.metadata).not.toHaveProperty('cleared_links');
  });

  it('an approved PO\'s line replacement records the prior lines (account, dimensions, quantity, amount), capped at 20 with the total', async () => {
    const po = await seedQtyPo(pool, f, { lines: [{ qty: 2, price: 50 }] });
    const r = await callTool(pool, f, update, { po_id: po.po, lines: [{ description: 'New', quantity: 1, unit_price: 10, tax_rate: 0, gl_account_id: f.acc.opex }] });
    expect(r.isError, r.text).toBe(false);
    const meta = (await auditOf(pool, f, po.po)).at(-1)!.changes.metadata!;
    expect(meta.prior_lines_total).toBe('1');
    expect(JSON.parse(meta.prior_lines!)).toEqual([{ account: f.acc.opex, cc1: f.cc.FT, cc2: null, bu: null, qty: '2.00', amount: '100.00' }]);
    expect((await poLines(pool, po.po)).map((l) => l.line_total)).toEqual(['10.00']);

    const many = await seedQtyPo(pool, f, { lines: Array.from({ length: 25 }, () => ({ qty: 1, price: 1 })) });
    await callTool(pool, f, update, { po_id: many.po, lines: [{ description: 'One', quantity: 1, unit_price: 25, tax_rate: 0, gl_account_id: f.acc.opex }] });
    const m = (await auditOf(pool, f, many.po)).at(-1)!.changes.metadata!;
    expect(m.prior_lines_total).toBe('25');
    expect(JSON.parse(m.prior_lines!)).toHaveLength(20);
    // A draft's replacement (nothing committed) and a header-only edit record no prior lines.
    const draft = await seedPo(pool, f, { status: 'draft', lines: [100] });
    await callTool(pool, f, update, { po_id: draft.po, lines: [{ description: 'x', quantity: 1, unit_price: 5, tax_rate: 0, gl_account_id: f.acc.opex }] });
    expect((await auditOf(pool, f, draft.po)).at(-1)!.changes.metadata).not.toHaveProperty('prior_lines');
  });
});
