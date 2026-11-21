/**
 * Migration 1022 and committed spend (PR #1703: the breaker's repro, then Hein's ruling that copies keep their unbilled
 * remainder in committed), real PostgreSQL 16 and the real budgets/remainingCommitted.readCommitments. A legacy bill can name a
 * legacy order only by its header; committed now nets header billing (budgets/remainingHeaderBilled), so nothing counts twice:
 *   A  received, fully billed by an approved header bill          -> closed, commits 0
 *   B1 partially_invoiced, R400 of R1000 billed (approved bill)    -> open (received), commits the R600 remainder exactly
 *   B2 the same order, its bill lost                               -> open, commits R1000 (nothing to net)
 *   B3 partially_invoiced whose only bill is a draft               -> open, commits R1000 (a draft nets nothing)
 *   C  sent, over-billed by a PAID R1500 bill                      -> closed, commits 0
 *   D  sent: a 12345.6789 x 1.23 line and a 0.125 one              -> commits its R15 186.43 (the big line as 1 unit)
 *   E  sent: R500 and a 0.004-quantity dust line                   -> commits R500.04 (the dust line copied, not lost)
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { dropBillFixture, seedBillFixture, type BillFixture } from './helpers/budgetBillFixture';
import { seedPo, seedRawBill } from './helpers/poBillLinkHarness';
import { asBeforeRetirement, dropCanonical, dropLegacy, runMigration, seedSpo, type SeededSpo } from './spo-retire-1022.helpers';
import { readCommitments } from '@/modules/accounting/services/budgets/remainingCommitted';
import { openPoLineCents } from '@/modules/accounting/services/budgets/remainingBudgetCore';
import { billedCentsByPo } from '@/modules/accounting/services/ap/purchaseOrderBilled';
import { callTool } from './helpers/poImportHarness';
import { unlinkBillFromPurchaseOrderTool as unlink } from '@/lib/mcp/tools/writeUnlinkBillFromPurchaseOrder';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let f: BillFixture;
const S: Record<string, SeededSpo> = {};
const bills: Record<string, string> = {};

beforeAll(async () => {
  f = await seedBillFixture(pool, 'spo-committed');
  const gl = f.acc.opex;
  const ten = (received: number, invoiced: number) => [{ qty: 10, price: 100, received, invoiced, gl }];
  await asBeforeRetirement(pool, async (c) => {
    const at = async (k: string, status: string, lines: Parameters<typeof seedSpo>[1]['lines']) => {
      S[k] = await seedSpo(c, { co: f.co, supplier: f.supplier, number: `CM-${k}`, status, lines });
    };
    await at('A', 'received', ten(10, 10));
    await at('B1', 'partially_invoiced', ten(10, 4));
    await at('B2', 'partially_invoiced', ten(10, 4));
    await at('B3', 'partially_invoiced', ten(10, 9));
    await at('C', 'sent', ten(0, 0));
    await at('D', 'sent', [{ qty: 12345.6789, price: 1.23, lineTotal: 15185.18, gl }, { qty: 0.125, price: 9.99, lineTotal: 1.25, gl }]);
    await at('E', 'sent', [{ qty: 1, price: 500, gl }, { qty: 0.004, price: 10, lineTotal: 0.04, gl }]);
    await at('N', 'sent', [{ qty: 1, price: 100, gl }]);
    await at('NG', 'received', ten(10, 10));
  });
  const bill = (k: string, total: number, status: string) =>
    seedRawBill(pool, f, { items: [{ total }], subtotal: total, total: Math.round(total * 115) / 100, header: S[k]!.id, status });
  bills.A = (await bill('A', 1000, 'approved')).id;
  // Review r3 L2: a R-50 bill line naming N's (legacy) line holds 0, never -50, so N's R100 header bill still bills it fully.
  await seedRawBill(pool, f, { items: [{ total: 150 }, { total: -50, poItem: S.N!.items[0] }], subtotal: 100, total: 115 });
  await bill('N', 100, 'approved');
  // Breaker r8 B8-NEG: a legacy credit-like bill (subtotal -R100) names NG beside its R1000 bill. Its header residual is 0, never
  // -R100 (billAttribution.headerResidualCents), so NG is fully billed in the close step as in the TS readers. Written as legacy rows
  // were, before the negative-total guard (replica skips the guard trigger).
  await bill('NG', 1000, 'approved');
  const neg = await pool.connect();
  try {
    await neg.query('BEGIN');
    await neg.query('SET LOCAL session_replication_role = replica');
    const nb = crypto.randomUUID();
    await neg.query(`INSERT INTO supplier_invoices (id, company_id, invoice_number, supplier_id, purchase_order_id, invoice_date, subtotal, tax_rate,
      tax_amount, total_amount, status, created_by) VALUES ($1, $2, $3, $4, $5, '2026-06-15', -100, 15, -15, -115, 'approved', $6)`,
      [nb, f.co, `NEG-${nb.slice(0, 8)}`, f.supplier, S.NG!.id, f.owner]);
    await neg.query(`INSERT INTO supplier_invoice_items (supplier_invoice_id, description, quantity, unit_price, tax_rate, tax_amount, line_total, gl_account_id)
      VALUES ($1, 'credit', 1, -100, 15, -15, -100, $2)`, [nb, f.acc.opex]);
    await neg.query('COMMIT');
  } catch (e) { await neg.query('ROLLBACK'); throw e; } finally { neg.release(); }
  await bill('B1', 400, 'approved');
  await bill('B3', 1, 'draft');
  await bill('C', 1500, 'paid');
  await runMigration(pool);
}, 120_000);

afterAll(async () => {
  try {
    if (f) { await dropLegacy(pool, [f.co]); await dropCanonical(pool, [f.co]); }
    await dropBillFixture(pool, f);
  } finally { await pool.end(); }
}, 60_000);

const committedByOrder = async (): Promise<Record<string, number>> => {
  const rows = await readCommitments(f.co, [f.acc.opex], '2026-05-01', '2026-05-31', {});
  const owner = new Map((await pool.query(`SELECT i.id::TEXT AS id, po.po_number FROM po_items i JOIN purchase_orders po ON po.id = i.purchase_order_id
    WHERE po.company_id = $1`, [f.co])).rows.map((r) => [String(r.id), String(r.po_number)]));
  const out: Record<string, number> = {};
  for (const r of rows) { const n = owner.get(r.poItemId)!; out[n] = (out[n] ?? 0) + openPoLineCents(r.lineTotal, r.billed); }
  return out;
};

describe('committed spend after the copy', () => {
  it('commits each copy\'s unbilled remainder exactly: nothing for a fully billed one, all of an unbilled one', async () => {
    // The copies closed by billing (A, C, N) are fully billed at PO level, so they commit 0 and contribute no row (review r6 M5).
    expect(await committedByOrder()).toEqual({ 'CM-B1': 60000, 'CM-B2': 100000, 'CM-B3': 100000, 'CM-D': 1518643, 'CM-E': 50004 });
  });

  // Breaker r3 / r4: over the copies in a committing status (a draft or cancelled copy is never closed). The one named exception:
  // a legacy invoiced copy with no live bill is closed though nothing bills it, and is not closed BY BILLING (it never reopens).
  it('every committing copy is closed by billing exactly when the TS readers call it fully billed; the exception is legacy invoiced with no live bill', async () => {
    const pos = (await pool.query(`SELECT p.id::TEXT AS id, p.status, s.status AS legacy, p.closed_by_billing,
        GREATEST(round(p.subtotal * 100), (SELECT COALESCE(round(SUM(x.line_total) * 100), 0) FROM po_items x WHERE x.purchase_order_id = p.id))::INT AS sub
      FROM purchase_orders p JOIN supplier_purchase_orders s ON s.id = p.id
     WHERE p.company_id = $1 AND p.status IN ('approved', 'partially_received', 'received', 'closed')`, [f.co])).rows;
    const billed = await billedCentsByPo(f.co, pos.map((p) => String(p.id)));
    const fully = (p: { id: string; sub: number }) => (billed.get(String(p.id)) ?? 0) >= p.sub - 1 && p.sub > 0;
    const legacyNoBill = (p: { status: string; legacy: string; closed_by_billing: boolean }) => p.legacy === 'invoiced' && p.status === 'closed' && !p.closed_by_billing;
    expect(pos.filter((p) => (p.status === 'closed') !== fully(p) && !legacyNoBill(p))).toEqual([]);
    expect(pos.filter((p) => p.closed_by_billing !== (p.status === 'closed' && fully(p)))).toEqual([]);
    expect(pos.length).toBeGreaterThan(5);
  });

  it('closes only the fully billed copies, from their open status', async () => {
    const st = async (k: string) => (await pool.query('SELECT status, closed_from_status FROM purchase_orders WHERE id = $1', [S[k]!.id])).rows[0];
    expect(await st('A')).toEqual({ status: 'closed', closed_from_status: 'received' });
    expect(await st('B1')).toEqual({ status: 'received', closed_from_status: null });
    expect(await st('B2')).toEqual({ status: 'received', closed_from_status: null });
    expect(await st('B3')).toEqual({ status: 'received', closed_from_status: null });
    expect(await st('C')).toEqual({ status: 'closed', closed_from_status: 'approved' });
    expect(await st('D')).toEqual({ status: 'approved', closed_from_status: null });
    expect(await st('N')).toEqual({ status: 'closed', closed_from_status: 'approved' });
    expect(await st('NG')).toEqual({ status: 'closed', closed_from_status: 'received' });
  });
});

describe('a copy the migration closed as fully billed', () => {
  // Breaker r4 R4-1: the closing is recorded on the PO itself (closed_by_billing + closed_from_status), as link_bills_to_purchase_order
  // records its own, so removing a counted tie that leaves it under-billed reopens the copy to the status it was closed from.
  it('records the closing on the purchase order, and an unlink reopens it', async () => {
    expect((await pool.query('SELECT closed_by_billing, closed_from_status FROM purchase_orders WHERE id = $1', [S.A!.id])).rows[0])
      .toEqual({ closed_by_billing: true, closed_from_status: 'received' });
    // The copy's close wrote no record on a link (the record is the PO's own).
    expect((await pool.query('SELECT count(*)::INT AS n FROM purchase_order_bill_links WHERE purchase_order_id = $1 AND closed_po_from_status IS NOT NULL', [S.A!.id])).rows[0].n).toBe(0);
    const r = await callTool(pool, f, unlink, { po_id: S.A!.id, bill_id: bills.A, reason: 'billed in error' });
    expect(r.isError, r.text).toBe(false);
    expect(r.body).toMatchObject({ unlinked: true, reopened_to: 'received' });
    expect((await pool.query('SELECT status, closed_from_status, closed_by_billing FROM purchase_orders WHERE id = $1', [S.A!.id])).rows[0])
      .toEqual({ status: 'received', closed_from_status: null, closed_by_billing: false });
    expect((await committedByOrder())['CM-A']).toBe(100000);
  });

  it('moves a closing record a pre-1022 link call left on its link onto the purchase order (breaker r4 R4-1)', async () => {
    const po = await seedPo(pool, f, { lines: [100], status: 'closed' });
    const b = await seedRawBill(pool, f, { items: [{ total: 100 }], subtotal: 100, total: 115 });
    await pool.query(`INSERT INTO purchase_order_bill_links (company_id, purchase_order_id, supplier_invoice_id, amount, source, closed_po_from_status, created_by)
      VALUES ($1, $2, $3, 100, 'mcp', 'received', $4)`, [f.co, po.po, b.id, f.owner]);
    await runMigration(pool);
    expect((await pool.query('SELECT status, closed_from_status, closed_by_billing FROM purchase_orders WHERE id = $1', [po.po])).rows[0])
      .toEqual({ status: 'closed', closed_from_status: 'received', closed_by_billing: true });
    // The link's own value is left as it was (kept for PR #1697 (open), which writes it; unread here).
    expect((await pool.query('SELECT closed_po_from_status FROM purchase_order_bill_links WHERE purchase_order_id = $1', [po.po])).rows)
      .toEqual([{ closed_po_from_status: 'received' }]);
    const r = await callTool(pool, f, unlink, { po_id: po.po, bill_id: b.id, reason: 'billed in error' });
    expect([r.isError, r.body.reopened_to], r.text).toEqual([false, 'received']);
  });
});
