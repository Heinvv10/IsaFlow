/**
 * Round-13 breaker findings on a real database (b13-a probes B13-A4 and B13-A1, ported):
 *   - B13-1: a PO whose lines carry Totals but no Exclusive (offsetting each other, so the header adds up) is refused, never booked at
 *     quantity x price; the rest of the file is booked;
 *   - B13-2: a PO batch that re-created a deleted PO is never "answered ok, nothing new written" in a stop.
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanupWorld } from './helpers/itemsWorld';
import { afterCommitOf, booked, cleanupSageWorld, exportFile, landedCommitPool, parsedExport, sageWorld, type SageWorld } from './helpers/sageMigrationWorld';
import { runSageMigration } from '@/modules/accounting/services/sage-migration/sageMigrationRunner';
import type { MigrationStopped } from '@/modules/accounting/services/sage-migration/sageMigrationStopped';
import { exitCodeForError, stopMessage } from '@/modules/accounting/services/sage-migration/sageStopMessage';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
let s: SageWorld;
beforeEach(async () => { s = await sageWorld(pool); }, 120_000);
afterEach(async () => { await cleanupSageWorld(pool, s); await cleanupWorld(pool, s.w); }, 120_000);

type Row = Record<string, unknown>;
const opts = (over: Row = {}) => ({ companyId: s.companyId, userId: s.userId, live: true, allowRefusals: true, allowDifferences: true, expect: { items: 20, purchaseOrders: 10 }, ...over });
const run = (over: Row = {}, p: Pool = pool, file: Row = exportFile()) => runSageMigration(p, parsedExport(file), opts(over));
const stopped = (p: Promise<unknown>) => p.then(() => { throw new Error('the run did not stop'); }, (e: unknown) => e as MigrationStopped);

describe('B13-1 (B13-A4): offsetting line Totals with no line Exclusive', () => {
  it('the PO is refused, never booked at 115 / 115; the other POs are booked', async () => {
    const file = exportFile();
    const pos = file.PurchaseOrders as Row[];
    const p0 = pos[0]!;
    // Sage: line 1 R105 incl (a hidden R10 discount), line 2 R125 incl (a R10 surcharge); the header is their sum.
    const line = (t: number) => ({ Description: 'Probe', Quantity: 1, UnitPriceExclusive: 100, TaxTypeId: 1, Total: t });
    pos[0] = { ID: 990001, DocumentNumber: 'B13-MONEY-1', Date: '2026-03-01', Status: 'Pending', SupplierId: p0.SupplierId, SupplierName: p0.SupplierName, Exclusive: 200, Tax: 30, Total: 230, Lines: [line(105), line(125)] };
    const r = await run({ expect: { items: 20, purchaseOrders: 9 } }, pool, file);
    expect(r.status).toBe('completed');
    expect(r.refused.map((x) => [x.label, x.code])).toEqual([['B13-MONEY-1', 'invalid_row']]);
    expect(r.refused[0]!.reasons.join(' ')).toMatch(/Lines\[0\]\.Total is given without Exclusive/);
    expect((await pool.query(`SELECT count(*)::INT AS n FROM purchase_orders WHERE company_id = $1 AND po_number = 'B13-MONEY-1'`, [s.companyId])).rows[0].n).toBe(0);
    expect(await booked(pool, s.companyId)).toMatchObject({ pos: 9 });
  });
});

describe('B13-2 (B13-A1): a re-run whose PO batch 1 re-creates a PO deleted after the dry run, then PO batch 2 lands unanswered', () => {
  it('the stop lists PO batch 1 as committed, never "nothing new written"', async () => {
    expect((await run({ poBatchSize: 4 })).status).toBe('completed');
    const ref = String((exportFile().PurchaseOrders as Row[])[0]!.ID);
    const del = async () => {
      await pool.query(`DELETE FROM po_items WHERE purchase_order_id IN (SELECT id FROM purchase_orders WHERE company_id = $1 AND external_ref = $2)`, [s.companyId, ref]);
      await pool.query(`DELETE FROM purchase_orders WHERE company_id = $1 AND external_ref = $2`, [s.companyId, ref]);
    };
    // Re-run commits: 1-4 categories, 5 items (the PO is deleted right after), 6 PO batch 1, 7 PO batch 2 (lands, answer lost).
    const err = await stopped(run({ poBatchSize: 4 }, afterCommitOf(landedCommitPool(pool, [7]), 'bulk_upsert_items', { after: del })));
    const po1 = err.committed.find((b) => b.entity === 'purchase_order' && b.n === 1)!;
    expect(exitCodeForError(err)).toBe(4);
    expect(po1.toolReported?.created).toBe(1);
    expect(po1.allRowsAlreadyPresent).toBe(false);
    expect(stopMessage(err)).toMatch(/\ncommitted: purchase_order batch 1 \(/);
    expect(stopMessage(err)).not.toMatch(/nothing new written \(its rows were already there\): purchase_order batch 1/);
  });
});
