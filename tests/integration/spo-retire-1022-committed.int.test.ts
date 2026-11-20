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
import { seedRawBill } from './helpers/poBillLinkHarness';
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
  });
  const bill = (k: string, total: number, status: string) =>
    seedRawBill(pool, f, { items: [{ total }], subtotal: total, total: Math.round(total * 115) / 100, header: S[k]!.id, status });
  bills.A = (await bill('A', 1000, 'approved')).id;
  // Review r3 L2: a R-50 bill line naming N's (legacy) line holds 0, never -50, so N's R100 header bill still bills it fully.
  await seedRawBill(pool, f, { items: [{ total: 150 }, { total: -50, poItem: S.N!.items[0] }], subtotal: 100, total: 115 });
  await bill('N', 100, 'approved');
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
    expect(await committedByOrder()).toEqual({ 'CM-B1': 60000, 'CM-B2': 100000, 'CM-B3': 100000, 'CM-D': 1518643, 'CM-E': 50004 });
  });

  it('every copy is closed exactly when the TS readers call it fully billed, or legacy invoiced with no live bill (breaker r3)', async () => {
    const pos = (await pool.query(`SELECT p.id::TEXT AS id, p.status, s.status AS legacy,
        GREATEST(round(p.subtotal * 100), (SELECT COALESCE(round(SUM(x.line_total) * 100), 0) FROM po_items x WHERE x.purchase_order_id = p.id))::INT AS sub
      FROM purchase_orders p JOIN supplier_purchase_orders s ON s.id = p.id WHERE p.company_id = $1`, [f.co])).rows;
    const billed = await billedCentsByPo(f.co, pos.map((p) => String(p.id)));
    const bad = pos.filter((p) => (p.status === 'closed') !== ((billed.get(String(p.id)) ?? 0) >= p.sub - 1 && p.sub > 0)
      && !(p.legacy === 'invoiced' && p.status === 'closed'));
    expect(bad).toEqual([]);
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
  });
});

describe('a copy the migration closed as fully billed', () => {
  // Review L5: the closing is recorded on the deciding link (closed_po_from_status), as link_bills_to_purchase_order records its own,
  // so unlinking the bill reopens the copy to the status it was closed from, and it commits again.
  it('records the closing on its bill\'s link, and an unlink reopens it', async () => {
    const rec = (await pool.query('SELECT closed_po_from_status FROM purchase_order_bill_links WHERE purchase_order_id = $1 AND supplier_invoice_id = $2',
      [S.A!.id, bills.A])).rows;
    expect(rec).toEqual([{ closed_po_from_status: 'received' }]);
    const r = await callTool(pool, f, unlink, { po_id: S.A!.id, bill_id: bills.A, reason: 'billed in error' });
    expect(r.isError, r.text).toBe(false);
    expect(r.body).toMatchObject({ unlinked: true, reopened_to: 'received' });
    expect((await pool.query('SELECT status, closed_from_status FROM purchase_orders WHERE id = $1', [S.A!.id])).rows[0])
      .toEqual({ status: 'received', closed_from_status: null });
    expect((await committedByOrder())['CM-A']).toBe(100000);
  });
});
