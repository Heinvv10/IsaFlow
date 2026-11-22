/**
 * Sage migration runner (Phase D) against a real database, through the real MCP registry as app_user: the synthetic export
 * (20 items in 4 categories, 10 purchase orders, 3 suppliers) goes categories -> items -> POs.
 *   - a dry run (and the dry run inside a live run) writes nothing;
 *   - the live run books every item and PO, with the statuses, totals and supplier links the mapping documents;
 *   - HARD RULE: no QuantityOnHand becomes stock (no stock_movements row, opening_qty / current_qty stay 0);
 *   - the reconciliation is measured: counts, the PO total against the export's, PDFs still to attach;
 *   - the runner refuses a company its user is not a member of.
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanupWorld } from './helpers/itemsWorld';
import { booked, cleanupSageWorld, exportFile, parsedExport, sageWorld, type SageWorld } from './helpers/sageMigrationWorld';
import { runSageMigration } from '@/modules/accounting/services/sage-migration/sageMigrationRunner';
import { NotAMemberError } from '@/modules/accounting/services/sage-migration/sageToolSession';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
let s: SageWorld;

beforeAll(async () => { s = await sageWorld(pool); }, 120_000);
afterAll(async () => {
  try { await cleanupSageWorld(pool, s); await cleanupWorld(pool, s.w); } finally { await pool.end(); }
}, 120_000);

const opts = (over: Record<string, unknown> = {}) => ({ companyId: s.companyId, userId: s.userId, ...over });

describe('the dry run', () => {
  it('previews everything and writes nothing: no item, category, PO, movement or audit row', async () => {
    const before = await booked(pool, s.companyId);
    const audits = () => pool.query('SELECT count(*)::INT AS n FROM audit_log WHERE company_id = $1', [s.companyId]);
    const auditsBefore = (await audits()).rows[0].n;
    const report = await runSageMigration(pool, parsedExport(), opts());
    expect((await audits()).rows[0].n).toBe(auditsBefore); // the dry run's PO audit rows went with its transaction
    expect(report.status).toBe('dry_run_ok');
    expect(report.live).toBeNull();
    expect(report.dryRun).toMatchObject({ clean: true, categories: { failed: 0 }, items: { failed: 0 }, purchaseOrders: { failed: 0 } });
    expect(report.dryRun.categories.batches).toHaveLength(4);
    expect(report.dryRun.items.batches[0]!.toolReported).toMatchObject({ dry_run: true, counts: { created: 20, total: 20 } });
    // POs run LIVE inside the rolled-back dry-run transaction (so a batch sees the ones before it): created, then rolled back.
    expect(report.dryRun.purchaseOrders.batches[0]!.toolReported).toMatchObject({ created: 10, already_existed: 0 });
    expect(await booked(pool, s.companyId)).toEqual(before);
    expect(await booked(pool, s.companyId)).toMatchObject({ items: 0, categories: 0, pos: 0, movements: 0, toolCalls: 0 });
  });

  it('reports what it would do: counts in and out, the PO total, the PDFs, and nothing booked', async () => {
    const r = (await runSageMigration(pool, parsedExport(), opts())).reconciliation;
    expect(r.items).toMatchObject({ inExport: 20, refused: 0, sent: 20, presentBefore: 0, presentAfter: 0, addedByRun: 0 });
    expect(r.purchaseOrders).toMatchObject({ inExport: 10, refused: 0, sent: 10, notSentTotalCents: 0, bookedTotalCents: 0 });
    expect(r.purchaseOrders.sentTotalCents).toBe(r.purchaseOrders.exportTotalCents);
    expect(r.attachments).toMatchObject({ posWithPdf: 10, uploadedByRunner: 0 });
    expect(r.allSentBooked).toBe(false); // a dry run books nothing
    expect(r.nothingRefused).toBe(true);
  });
});

describe('the live run', () => {
  let report: Awaited<ReturnType<typeof runSageMigration>>;

  it('books 20 items, 4 categories and 10 purchase orders, and says it is complete', async () => {
    const file = exportFile();
    const total = parsedExport(file).exportPoTotalCents;
    report = await runSageMigration(pool, parsedExport(file), opts({
      live: true, expect: { items: 20, purchaseOrders: 10, purchaseOrderTotalCents: total },
    }));
    expect(report.status).toBe('completed');
    expect(report.live!.categories.batches.map((b) => b.status)).toEqual(['ok', 'ok', 'ok', 'ok']);
    const b = await booked(pool, s.companyId);
    expect(b).toMatchObject({ items: 20, categories: 4, pos: 10, movements: 0 });
    expect(b.poLines).toBeGreaterThanOrEqual(10);
    const rec = report.reconciliation;
    expect([rec.allSentBooked, rec.nothingRefused]).toEqual([true, true]);
    expect(rec.items).toMatchObject({ sent: 20, presentBefore: 0, presentAfter: 20, addedByRun: 20 });
    expect(rec.purchaseOrders).toMatchObject({ sent: 10, presentAfter: 10, addedByRun: 10, differenceCents: 0, notSentTotalCents: 0 });
    expect(rec.purchaseOrders.bookedTotalCents).toBe(total);
    expect(b.poTotalCents).toBe(total);
    expect(rec.expected).toEqual({
      items: { expected: 20, actual: 20, basis: 'booked', ok: true }, purchaseOrders: { expected: 10, actual: 10, basis: 'booked', ok: true },
      purchaseOrderTotalCents: { expected: total, actual: total, basis: 'booked', ok: true },
    });
  });

  it('items: services are services, nothing is tracked, inactive stays inactive, the Sage ref is the identity', async () => {
    const rows = (await pool.query(
      `SELECT i.code, i.item_type, i.inventory_tracked, i.is_active, i.external_system, i.external_ref, i.selling_price_excl, i.cost_price,
              i.vat_on_sales, i.vat_on_purchases, c.name AS category
         FROM items i LEFT JOIN item_categories c ON c.id = i.category_id WHERE i.company_id = $1 ORDER BY i.code`, [s.companyId])).rows;
    expect(rows).toHaveLength(20);
    expect(rows.filter((r) => r.item_type === 'service').map((r) => r.code)).toEqual(['SVC-005', 'SVC-010', 'SVC-015', 'SVC-020']);
    expect(rows.every((r) => r.inventory_tracked === false && r.external_system === 'sage')).toBe(true);
    expect(rows.filter((r) => !r.is_active).map((r) => r.code)).toEqual(['FIB-0007', 'FIB-0014']);
    expect(rows.find((r) => r.code === 'FIB-0001')).toMatchObject({
      external_ref: '50001', category: 'Optics', vat_on_sales: 'standard', vat_on_purchases: 'standard',
    });
    expect(Number(rows.find((r) => r.code === 'FIB-0001')!.selling_price_excl)).toBe(107.5);
    expect(Number(rows.find((r) => r.code === 'FIB-0001')!.cost_price)).toBe(63.25);
    expect(rows.find((r) => r.code === 'FIB-0009')!.vat_on_sales).toBe('zero');
    expect(rows.find((r) => r.code === 'FIB-0011')!.vat_on_purchases).toBe('exempt');
    expect(rows.find((r) => r.code === 'FIB-0013')!.category).toBeNull();
  });

  it('HARD RULE: no QuantityOnHand became stock: no movement, no level, opening and current quantity 0', async () => {
    expect(report.reconciliation.stock).toMatchObject({ movementsBefore: 0, movementsAfter: 0, written: 0, itemsWithQuantityOnHandIgnored: 20 });
    expect(await pool.query('SELECT 1 FROM stock_movements WHERE company_id = $1 OR item_id IN (SELECT id FROM items WHERE company_id = $1)', [s.companyId]))
      .toHaveProperty('rowCount', 0);
    const q = (await pool.query(
      `SELECT count(*) FILTER (WHERE COALESCE(opening_qty, 0) <> 0 OR COALESCE(opening_cost, 0) <> 0 OR opening_date IS NOT NULL OR COALESCE(current_qty, 0) <> 0)::INT AS stocked,
              count(*)::INT AS total FROM items WHERE company_id = $1`, [s.companyId])).rows[0];
    expect(q).toEqual({ stocked: 0, total: 20 });
    expect(await pool.query('SELECT 1 FROM stock_levels WHERE company_id = $1', [s.companyId])).toHaveProperty('rowCount', 0);
  });

  it('purchase orders: the numbers, statuses, suppliers, dates and Sage references the mapping documents', async () => {
    const rows = (await pool.query(
      `SELECT po_number, status, supplier_id, order_date::TEXT AS d, external_system, external_ref, external_document_number, notes, reference
         FROM purchase_orders WHERE company_id = $1 ORDER BY po_number`, [s.companyId])).rows;
    expect(rows.map((r) => r.po_number)).toEqual(Array.from({ length: 10 }, (_, i) => `PO${String(197 + i).padStart(7, '0')}`));
    expect(rows.map((r) => r.status)).toEqual(['approved', 'approved', 'approved', 'approved', 'approved', 'closed', 'closed', 'closed', 'cancelled', 'cancelled']);
    // Sage supplier 301 -> alpha (by reference, though renamed), 302 -> bravo and 303 -> charlie (by name, case-insensitive).
    const sup = s.suppliers;
    expect(rows.map((r) => r.supplier_id)).toEqual([sup.alpha, sup.bravo, sup.charlie, sup.alpha, sup.bravo, sup.charlie, sup.alpha, sup.bravo, sup.charlie, sup.alpha]);
    expect(rows[0]).toMatchObject({ external_system: 'sage', external_ref: '900197', external_document_number: 'PO0000197', d: '2026-01-10', reference: 'JOB-400' });
    expect(rows[3]!.notes).toBe('Sage status: Overdue\nUrgent: chase supplier');
    const line = (await pool.query(`SELECT description FROM po_items WHERE purchase_order_id = (SELECT id FROM purchase_orders WHERE company_id = $1 AND po_number = 'PO0000197') ORDER BY sort_order, id`, [s.companyId])).rows;
    expect(line.map((l) => l.description)).toContain('Fibre cable drum (PO 197) [item FIB-0001]');
  });

  it('the report lists the PDFs still to attach and the batches with their keys', () => {
    expect(report.reconciliation.attachments.files).toHaveLength(10);
    expect(report.reconciliation.attachments.files[0]).toEqual({ poNumber: 'PO0000197', pdfFile: 'PO0000197.pdf' });
    for (const b of [...report.live!.items.batches, ...report.live!.purchaseOrders.batches]) expect(b.key).toMatch(/^sage-mig-(item|purchase_order)-\d{4}-[0-9a-f]{16}$/);
    expect(report.refused).toEqual([]);
  });
});

describe('the company', () => {
  it('a user who is not a member of the named company is refused before anything runs', async () => {
    const before = await booked(pool, s.otherCompanyId);
    await expect(runSageMigration(pool, parsedExport(), { companyId: s.otherCompanyId, userId: s.userId, live: true })).rejects.toBeInstanceOf(NotAMemberError);
    await expect(runSageMigration(pool, parsedExport(), { companyId: s.companyId, userId: s.otherUserId, live: true })).rejects.toBeInstanceOf(NotAMemberError);
    expect(await booked(pool, s.otherCompanyId)).toEqual(before);
    expect(before).toMatchObject({ items: 0, pos: 0 });
  });

  it('the live run touched no other company', async () => {
    expect(await booked(pool, s.otherCompanyId)).toMatchObject({ items: 0, categories: 0, pos: 0, movements: 0 });
  });
});
