/**
 * Bank controls step 2 (blind review #684 MEDIUM-1): approving a bill whose
 * slip evidences a bank-first provisional settles the bill from that
 * provisional's bank line (R-127) — a supplier payment from the line. Under
 * supplier_payment enforcement the person who imported the line's statement
 * may not do that (importer ≠ allocator). The refusal is raised in the claim,
 * before the approval's first write, and the routes answer it as such:
 * supplier-invoices-action 403 with the reason (not the blanket 400), the bulk
 * action per item with the reason. The sole approver on the admin floor passes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setLineBatchAsImported } from './bank-controls-a.helpers';
import supplierInvoicesAction from '../../pages/api/accounting/supplier-invoices-action';
import supplierInvoicesBulkAction from '../../pages/api/accounting/supplier-invoices-bulk-action';
import {
  bankGl, callRoute, company, companySnapshot, pool, seedDoc, seedInvoice, seedProvisional, useR127Fixture, user,
} from './r127-double-booking.helpers';

useR127Fixture();
const colleague = crypto.randomUUID();
// Registered after the fixture, so it runs before the fixture's purge (hooks unwind as a stack).
beforeAll(async () => {
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [colleague, `${colleague}@test.local`]);
});
afterAll(async () => {
  await pool.query('DELETE FROM approval_enforcement WHERE company_id = $1', [company]);
  // Lines before their batch: 877 refuses deleting a batch a line still names.
  await pool.query('DELETE FROM bank_transactions WHERE company_id = $1 AND import_batch_id IS NOT NULL', [company]);
  await pool.query('DELETE FROM bank_import_batches WHERE company_id = $1', [company]);
  await pool.query('DELETE FROM company_users WHERE company_id = $1 AND user_id = $2', [company, colleague]);
  await pool.query('DELETE FROM users WHERE id = $1', [colleague]);
});

/** supplier_payment enforced (no rule: the importer check needs only the type), and a colleague admin unless `sole`. */
async function setUp(opts: { sole?: boolean } = {}) {
  await pool.query('DELETE FROM approval_enforcement WHERE company_id = $1', [company]);
  for (const type of ['supplier_payment', 'payment_batch']) {
    await pool.query('INSERT INTO approval_enforcement(company_id, document_type, enabled_by) VALUES($1,$2,$3)', [company, type, user]);
  }
  await pool.query('DELETE FROM company_users WHERE company_id = $1 AND user_id = $2', [company, colleague]);
  if (!opts.sole) await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')", [company, colleague]);
}

/** A bill from a slip that evidences a provisional whose line came from a statement the fixture user imported. */
async function importersBill(total: number): Promise<string> {
  const doc = await seedDoc();
  const { bt } = await seedProvisional({ totalAmount: total, evidencedBy: doc });
  const batch = (await pool.query(
    `INSERT INTO bank_import_batches(company_id, bank_account_id, statement_date, transaction_count, imported_by, import_channel)
     VALUES($1,$2,CURRENT_DATE,1,$3,'upload') RETURNING id`, [company, bankGl, user])).rows[0].id as string;
  await setLineBatchAsImported(pool, bt, batch);
  return seedInvoice({ documentId: doc, totalAmount: total });
}
const REASON = 'IMPORTER_MAY_NOT_ALLOCATE';

describe('the importer approving a bill that settles their own statement line', () => {
  it('supplier-invoices-action approve: 403 with the reason, nothing written', async () => {
    await setUp();
    const invoiceId = await importersBill(731.10);
    const before = await companySnapshot(invoiceId);
    const res = await callRoute(supplierInvoicesAction, '/api/accounting/supplier-invoices-action', { action: 'approve', invoiceId });
    expect(res.statusCode, JSON.stringify(res.body)).toBe(403);
    expect((res.body as { error?: { details?: { reason?: string } } }).error?.details?.reason).toBe(REASON);
    expect(await companySnapshot(invoiceId)).toEqual(before);
  });

  it('supplier-invoices-bulk-action approve: the item fails with the reason, nothing written', async () => {
    await setUp();
    const invoiceId = await importersBill(732.20);
    const before = await companySnapshot(invoiceId);
    const res = await callRoute(supplierInvoicesBulkAction, '/api/accounting/supplier-invoices-bulk-action',
      { action: 'approve', invoiceIds: [invoiceId] });
    expect(JSON.stringify(res.body)).toContain(`"reason":"${REASON}"`);
    expect(JSON.stringify(res.body)).toContain('You imported this bank statement');
    expect(await companySnapshot(invoiceId)).toEqual(before);
  });

  it('the sole approver on the admin floor approves and settles it', async () => {
    await setUp({ sole: true });
    const invoiceId = await importersBill(733.30);
    const res = await callRoute(supplierInvoicesAction, '/api/accounting/supplier-invoices-action', { action: 'approve', invoiceId });
    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
  });
});
