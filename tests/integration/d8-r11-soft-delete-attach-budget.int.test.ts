/**
 * D8 round 11 (review rev-d8-c553cc0f8, findings 6 and 7).
 * F7 Soft delete bounded only its journal lock: the invoice row lock (`lockInvoice`), the undo's `deleted_at` UPDATE
 *    and the contra posting waited as long as a peer held them. An invoice's delete and its undo now run under one
 *    flow lock budget, as the other D8 entry points do.
 * F6 The automatic evidence attach answered a wait past its budget "nothing attached", so the capture post booked the
 *    bill beside a provisional left unevidenced. The lock timeout now propagates.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { softDelete, undoDelete } from '@/modules/accounting/services/core/softDeleteService';
import { attachEvidenceToProvisional } from '@/modules/accounting/services/capture/evidenceAttachmentService';
import { RowLockTimeoutError } from '@/modules/accounting/services/core/rowLockBudget';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { inTx, runOn } from './helpers/l1FifoFixture';
import { postedInvoice, provisional, setup, teardown, type Ctx } from './d8-r4-helpers';

let c: Ctx;
type Row = Record<string, unknown>;

/** `fn` in a request transaction (15 s statement_timeout, so an unbounded wait fails instead of hanging) while
 * another connection holds `holdSql` FOR UPDATE. Committed when `fn` resolves. */
async function whileHeld(holdSql: string, holdId: string, fn: () => Promise<unknown>) {
  const holder = await c.fx.pool.connect();
  await holder.query('BEGIN');
  await holder.query(holdSql, [holdId]);
  const cl = await c.fx.pool.connect();
  const started = Date.now();
  try {
    await cl.query('BEGIN');
    await cl.query("SET LOCAL statement_timeout = '15s'");
    const out = await runOn(c.fx, cl, fn).then((v) => ({ ok: true, v }), (e: unknown) => ({ ok: false, e }));
    await cl.query(out.ok ? 'COMMIT' : 'ROLLBACK');
    return { ...out, ms: Date.now() - started };
  } finally {
    cl.release();
    await holder.query('ROLLBACK');
    holder.release();
  }
}
const HOLD_INVOICE = 'SELECT id FROM customer_invoices WHERE id = $1 FOR UPDATE';
const invoiceState = async (id: string) => ((await sql`
  SELECT deleted_at IS NOT NULL AS deleted,
         (SELECT COUNT(*)::int FROM soft_delete_journal_reversals r WHERE r.entity_id = ${id}::UUID) AS reversals
  FROM customer_invoices WHERE id = ${id}::UUID`) as Row[])[0];

describe.skipIf(!process.env.DATABASE_URL)('D8 round 11: soft delete and the automatic attach under the flow budget', () => {
  beforeAll(async () => {
    assertNotProductionDb('D8 round 11 soft delete / attach');
    c = await setup('D8R11S');
  }, 120000);
  afterAll(async () => {
    if (c) await sql`DELETE FROM soft_delete_journal_reversals WHERE company_id = ${c.fx.companyId}::UUID`;
    await teardown(c);
  }, 120000);

  it('F7 soft delete of an invoice a peer holds refuses within the budget; nothing deleted, nothing reversed', async () => {
    const inv = await postedInvoice(c);
    const r = await whileHeld(HOLD_INVOICE, inv.id,
      () => softDelete(c.fx.companyId, 'customer_invoice', inv.id, c.fx.userId));
    expect(r.ok, JSON.stringify(r)).toBe(false);
    expect((r as { e: unknown }).e).toBeInstanceOf(RowLockTimeoutError);
    expect(r.ms).toBeLessThan(9000);
    expect(await invoiceState(inv.id)).toEqual({ deleted: false, reversals: 0 });
  }, 30000);

  it('F7 the undo of a delete on an invoice a peer holds refuses within the budget; it stays deleted', async () => {
    const inv = await postedInvoice(c);
    await inTx(c.fx, () => softDelete(c.fx.companyId, 'customer_invoice', inv.id, c.fx.userId));
    expect(await invoiceState(inv.id)).toEqual({ deleted: true, reversals: 1 });
    const r = await whileHeld(HOLD_INVOICE, inv.id,
      () => undoDelete(c.fx.companyId, 'customer_invoice', inv.id, c.fx.userId));
    expect(r.ok, JSON.stringify(r)).toBe(false);
    expect((r as { e: unknown }).e).toBeInstanceOf(RowLockTimeoutError);
    expect(r.ms).toBeLessThan(9000);
    expect(await invoiceState(inv.id)).toEqual({ deleted: true, reversals: 1 });
  }, 30000);

  it('F6 the automatic attach meets a held bank line: the lock timeout surfaces, the provisional is untouched', async () => {
    const amount = 730 + (++c.seq);
    const pv = await provisional(c, amount);
    await sql`UPDATE bank_transactions SET predicted_supplier_id = ${c.fx.supplierId}::UUID WHERE id = ${pv.bt}::UUID`;
    const [doc] = (await sql`
      INSERT INTO captured_documents (company_id, file_name, file_type, status, document_type)
      VALUES (${c.fx.companyId}::UUID, ${`d8r11-f6-${c.seq}.pdf`}, 'application/pdf', 'reviewed', 'supplier_invoice')
      RETURNING id`) as Row[];
    const r = await whileHeld('SELECT id FROM bank_transactions WHERE id = $1 FOR UPDATE', pv.bt,
      () => attachEvidenceToProvisional(c.fx.companyId, String(doc!.id), c.fx.supplierId, amount, '2026-05-15'));
    expect(r.ok, JSON.stringify(r)).toBe(false);
    expect((r as { e: unknown }).e).toBeInstanceOf(RowLockTimeoutError);
    const [je] = (await sql`SELECT needs_evidence, source_document_id FROM gl_journal_entries WHERE id = ${pv.je}::UUID`) as Row[];
    expect(je).toEqual({ needs_evidence: true, source_document_id: null });
  }, 30000);
});
