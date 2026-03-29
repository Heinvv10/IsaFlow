/**
 * Supplier Batch Payment Service
 * Phase 1 Sage Alignment: Bulk supplier payment processing
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { createJournalEntry, postJournalEntry } from './journalEntryService';
import { getAccountByCode } from './chartOfAccountsService';
import type { SupplierPaymentBatch, BatchPaymentCreateInput } from '../types/ap.types';
import type { JournalLineInput } from '../types/gl.types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

export async function getBatches(companyId: string, filters?: {
  status?: string;
  limit?: number;
  offset?: number;
}): Promise<{ items: SupplierPaymentBatch[]; total: number }> {
  const limit = filters?.limit || 50;
  const offset = filters?.offset || 0;
  let rows: Row[];
  let countRows: Row[];

  if (filters?.status) {
    rows = (await sql`
      SELECT * FROM supplier_payment_batches WHERE status = ${filters.status}
      ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}
    `) as Row[];
    countRows = (await sql`
      SELECT COUNT(*) AS cnt FROM supplier_payment_batches WHERE status = ${filters.status}
    `) as Row[];
  } else {
    rows = (await sql`
      SELECT * FROM supplier_payment_batches
      ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}
    `) as Row[];
    countRows = (await sql`SELECT COUNT(*) AS cnt FROM supplier_payment_batches`) as Row[];
  }

  return { items: rows.map(mapRow), total: Number(countRows[0]?.cnt || 0) };
}

export async function getBatchById(companyId: string, id: string): Promise<SupplierPaymentBatch | null> {
  const rows = (await sql`SELECT * FROM supplier_payment_batches WHERE id = ${id}`) as Row[];
  if (!rows[0]) return null;
  return mapRow(rows[0]);
}

export async function createBatch(companyId: string, 
  input: BatchPaymentCreateInput,
  userId: string
): Promise<SupplierPaymentBatch> {
  let totalAmount = 0;
  const paymentMethod = input.paymentMethod || 'eft';

  // Create batch record first
  const batchRows = (await sql`
    INSERT INTO supplier_payment_batches (
      batch_date, payment_method, bank_account_id, notes,
      payment_count, total_amount, created_by
    ) VALUES (
      ${input.batchDate || new Date().toISOString().split('T')[0]},
      ${paymentMethod}, ${input.bankAccountId || null}, ${input.notes || null},
      ${input.payments.length}, 0, ${userId}::UUID
    ) RETURNING *
  `) as Row[];

  const batchId = String(batchRows[0]!.id);

  // Create individual payments linked to batch
  for (const p of input.payments) {
    const payTotal = p.invoiceAllocations.reduce((s, a) => s + a.amount, 0);
    totalAmount += payTotal;

    const payRows = (await sql`
      INSERT INTO supplier_payments (
        supplier_id, payment_date, total_amount, payment_method,
        status, batch_id, created_by
      ) VALUES (
        ${p.supplierId}::UUID, ${input.batchDate || new Date().toISOString().split('T')[0]},
        ${payTotal}, ${paymentMethod}, 'draft', ${batchId}::UUID, ${userId}::UUID
      ) RETURNING id
    `) as Row[];

    const paymentId = String(payRows[0]!.id);
    for (const alloc of p.invoiceAllocations) {
      await sql`
        INSERT INTO payment_allocations (payment_id, invoice_id, amount_allocated)
        VALUES (${paymentId}::UUID, ${alloc.invoiceId}::UUID, ${alloc.amount})
      `;
    }
  }

  // Update batch total
  await sql`
    UPDATE supplier_payment_batches SET total_amount = ${totalAmount} WHERE id = ${batchId}
  `;

  log.info('Created batch payment', { batchId, paymentCount: input.payments.length, totalAmount }, 'accounting');
  const result = await getBatchById('', batchId);
  return result!;
}

export async function approveBatch(companyId: string, id: string, _userId: string): Promise<void> {
  await sql`UPDATE supplier_payment_batches SET status = 'approved' WHERE id = ${id} AND status = 'draft'`;
  await sql`UPDATE supplier_payments SET status = 'approved' WHERE batch_id = ${id}::UUID AND status = 'draft'`;
  log.info('Approved batch', { id }, 'accounting');
}

export async function processBatch(companyId: string, id: string, userId: string): Promise<void> {
  const batch = await getBatchById('', id);
  if (!batch) throw new Error('Batch not found');
  if (batch.status !== 'approved') throw new Error('Batch must be approved first');

  const totalAmount = batch.totalAmount;

  // GL: DR AP (2110), CR Bank (1110 or specified)
  const apAccount = await getAccountByCode('2110');
  const bankAccount = batch.bankAccountId
    ? { id: batch.bankAccountId }
    : await getAccountByCode('1110');
  if (!apAccount || !bankAccount) throw new Error('Required GL accounts not found');

  const lines: JournalLineInput[] = [
    { glAccountId: apAccount.id, debit: totalAmount, credit: 0,
      description: `Batch payment ${batch.batchNumber}` },
    { glAccountId: bankAccount.id, debit: 0, credit: totalAmount,
      description: `Batch payment ${batch.batchNumber}` },
  ];

  const je = await createJournalEntry('', {
    entryDate: batch.batchDate,
    description: `Supplier batch payment ${batch.batchNumber}`,
    source: 'auto_batch_payment',
    sourceDocumentId: id,
    lines,
  }, userId);
  await postJournalEntry('', je.id, userId);

  // Update all linked payments and their invoices
  const payments = (await sql`
    SELECT sp.id, pa.invoice_id, pa.amount_allocated
    FROM supplier_payments sp
    JOIN payment_allocations pa ON pa.payment_id = sp.id
    WHERE sp.batch_id = ${id}::UUID
  `) as Row[];

  for (const p of payments) {
    await sql`
      UPDATE supplier_invoices
      SET amount_paid = amount_paid + ${Number(p.amount_allocated)},
          status = CASE
            WHEN (total_amount - amount_paid - ${Number(p.amount_allocated)}) <= 0.01 THEN 'paid'
            WHEN amount_paid + ${Number(p.amount_allocated)} > 0 THEN 'partially_paid'
            ELSE status END
      WHERE id = ${p.invoice_id}::UUID
    `;
  }

  await sql`UPDATE supplier_payments SET status = 'processed' WHERE batch_id = ${id}::UUID`;
  await sql`
    UPDATE supplier_payment_batches
    SET status = 'processed', processed_by = ${userId}::UUID, processed_at = NOW(),
        gl_journal_entry_id = ${je.id}::UUID
    WHERE id = ${id}
  `;

  log.info('Processed batch', { id, journalEntryId: je.id }, 'accounting');
}

export async function cancelBatch(companyId: string, id: string): Promise<void> {
  await sql`UPDATE supplier_payment_batches SET status = 'cancelled' WHERE id = ${id} AND status = 'draft'`;
  await sql`UPDATE supplier_payments SET status = 'cancelled' WHERE batch_id = ${id}::UUID AND status = 'draft'`;
}

function mapRow(row: Row): SupplierPaymentBatch {
  return {
    id: String(row.id),
    batchNumber: row.batch_number ? String(row.batch_number) : '',
    batchDate: String(row.batch_date),
    totalAmount: Number(row.total_amount),
    paymentCount: Number(row.payment_count),
    paymentMethod: String(row.payment_method) as SupplierPaymentBatch['paymentMethod'],
    bankAccountId: row.bank_account_id ? String(row.bank_account_id) : undefined,
    status: String(row.status) as SupplierPaymentBatch['status'],
    glJournalEntryId: row.gl_journal_entry_id ? String(row.gl_journal_entry_id) : undefined,
    notes: row.notes ? String(row.notes) : undefined,
    processedBy: row.processed_by ? String(row.processed_by) : undefined,
    processedAt: row.processed_at ? String(row.processed_at) : undefined,
    createdBy: String(row.created_by),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
