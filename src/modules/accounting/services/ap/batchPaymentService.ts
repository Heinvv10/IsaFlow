/**
 * Supplier Batch Payment Service
 * Phase 1 Sage Alignment: Bulk supplier payment processing
 */

import { sql, withTransaction } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { createJournalEntry, postJournalEntry } from '../gl/journalEntryService';
import { getSystemAccount } from '../gl/systemAccountResolver';
import { claimUnderLockTimeout } from '../core/documentClaimLock';
import { assertSupplierInCompany } from '../core/contactDirectoryService';
import { assertBatchAllocatable, assertBatchMembersStillAllocatable } from './supplierBatchAllocationPlan';
import { SupplierPaymentRefusal } from './supplierPaymentRefusal';
import { assertBatchNotSentToNetcash } from './netcashBatchGuard';
import type { SupplierPaymentBatch, BatchPaymentCreateInput } from '../../types/ap.types';
import type { JournalLineInput } from '../../types/gl.types';
import { assertNotImpersonating } from '@/lib/auth/impersonationGuard';
import { assertApprovalCleared } from '../gl/approvalGate';
import { assertBatchUnchangedSinceApproval } from './batchApprovedDigest';

type Row = DbRow;

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
      SELECT * FROM supplier_payment_batches
      WHERE company_id = ${companyId} AND status = ${filters.status}
      ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}
    `) as Row[];
    countRows = (await sql`
      SELECT COUNT(*) AS cnt FROM supplier_payment_batches
      WHERE company_id = ${companyId} AND status = ${filters.status}
    `) as Row[];
  } else {
    rows = (await sql`
      SELECT * FROM supplier_payment_batches WHERE company_id = ${companyId}
      ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}
    `) as Row[];
    countRows = (await sql`SELECT COUNT(*) AS cnt FROM supplier_payment_batches WHERE company_id = ${companyId}`) as Row[];
  }

  return { items: rows.map(mapRow), total: Number(countRows[0]?.cnt || 0) };
}

export async function getBatchById(companyId: string, id: string): Promise<SupplierPaymentBatch | null> {
  // companyId may be empty string when called internally after creating a batch — skip filter in that case
  const rows = companyId
    ? (await sql`SELECT * FROM supplier_payment_batches WHERE id = ${id} AND company_id = ${companyId}`) as Row[]
    : (await sql`SELECT * FROM supplier_payment_batches WHERE id = ${id}`) as Row[];
  if (!rows[0]) return null;
  return mapRow(rows[0]);
}

export async function createBatch(companyId: string,
  input: BatchPaymentCreateInput,
  userId: string
): Promise<SupplierPaymentBatch> {
  const paymentMethod = input.paymentMethod || 'eft';
  const batchDate = input.batchDate || new Date().toISOString().split('T')[0]!;
  // R-068: every payment's supplier_id comes from the body. All refused
  // before the batch row is written.
  for (const p of input.payments) await assertSupplierInCompany(companyId, p.supplierId);
  // K-064: every bill line, too — tenant, supplier, status and outstanding —
  // under the bill locks, and all of it before the first INSERT: `withAuth`
  // COMMITs a 4xx, so a refusal after line 1 was written would keep line 1.
  await assertBatchAllocatable(companyId, input.payments.map((p) => ({
    supplierId: p.supplierId, allocations: p.invoiceAllocations,
  })));

  const batchId = await withTransaction(async (tx) => {
    const batchRows = (await tx`
      INSERT INTO supplier_payment_batches (
        company_id, batch_date, payment_method, bank_account_id, notes,
        payment_count, total_amount, created_by
      ) VALUES (
        ${companyId}::UUID, ${batchDate}, ${paymentMethod}, ${input.bankAccountId || null},
        ${input.notes || null}, ${input.payments.length}, 0, ${userId}::UUID
      ) RETURNING id
    `) as Row[];

    const id = String(batchRows[0]!.id);
    let totalAmount = 0;

    for (const p of input.payments) {
      const payTotal = p.invoiceAllocations.reduce((s: number, a: { amount: number }) => s + a.amount, 0);
      totalAmount += payTotal;

      const payRows = (await tx`
        INSERT INTO supplier_payments (
          company_id, supplier_id, payment_date, total_amount, payment_method,
          status, batch_id, created_by
        ) VALUES (
          ${companyId}::UUID, ${p.supplierId}::UUID, ${batchDate},
          ${payTotal}, ${paymentMethod}, 'draft', ${id}::UUID, ${userId}::UUID
        ) RETURNING id
      `) as Row[];

      const paymentId = String(payRows[0]!.id);
      for (const alloc of p.invoiceAllocations) {
        await tx`
          INSERT INTO payment_allocations (payment_id, invoice_id, amount_allocated)
          VALUES (${paymentId}::UUID, ${alloc.invoiceId}::UUID, ${alloc.amount})
        `;
      }
    }

    await tx`
      UPDATE supplier_payment_batches SET total_amount = ${totalAmount} WHERE id = ${id} AND company_id = ${companyId}::UUID
    `;

    return id;
  });

  log.info('Created batch payment', { batchId, paymentCount: input.payments.length }, 'accounting');
  const result = await getBatchById(companyId, batchId);
  return result!;
}

// Approve (R-035 PR5: locked, draft-only, gated) lives beside it, under the file-size cap.
export { approveBatch, BatchNotApprovableError } from './batchPaymentApproval';

/**
 * Raised when the batch is not in 'approved' when the claim runs — because it
 * never was, or because a concurrent request has already processed it. Raised
 * BEFORE the journal is created, so a route may answer it with a 4xx without
 * `withAuth` committing a half-processed batch.
 */
export class BatchNotProcessableError extends Error {
  readonly code = 'BATCH_NOT_PROCESSABLE';
  constructor(readonly batchStatus: string) {
    super(`Batch is ${batchStatus}, not approved — it cannot be processed.`);
    this.name = 'BatchNotProcessableError';
  }
}

export async function processBatch(companyId: string, id: string, userId: string): Promise<void> {
  await assertNotImpersonating(); // R-032 L5: first, before any read or write
  const batch = await getBatchById(companyId, id);
  if (!batch) throw new Error('Batch not found');

  // K-063/K-066 where money moves: every bill must STILL be payable and its
  // payment's supplier's. The batch row is locked first (document, then bills —
  // the order `processSupplierPayment` uses) so a double-click's loser waits
  // here and is told the batch is processed (409), not that its bills are paid.
  // Refused before the claim below: the batch stays 'approved', nothing written.
  const locked = await claimUnderLockTimeout('payment batch', async () => (await sql`
    SELECT status FROM supplier_payment_batches
    WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
    FOR UPDATE
  `) as Row[]);
  if (String(locked[0]?.status) !== 'approved') {
    throw new BatchNotProcessableError(String(locked[0]?.status ?? 'missing'));
  }
  // R-035 PR5: the money moves here, so the batch's approval is re-checked
  // under the lock — an approval taken before enforcement, or a line (or a
  // payee's bank details) changed since, is not paid. Nothing written yet.
  await assertApprovalCleared(companyId, 'payment_batch', id);
  await assertBatchUnchangedSinceApproval(companyId, id); // migration 922: enforcement on or off; payees share-locked
  await assertBatchMembersStillAllocatable(companyId, id);

  // CLAIM the batch before anything is posted. What this replaced read
  // `batch.status !== 'approved'` and then created and POSTED a journal, so two
  // concurrent "process" clicks both passed the read and both posted DR AP / CR
  // Bank for the full batch, and both incremented `amount_paid` on every
  // invoice in it — the bank credited twice and the supplier ledger overstated,
  // with the batch's own row rewritten unconditionally so only one journal id
  // survived to show for it. The status-predicated UPDATE is the guard: the
  // loser matches zero rows and stops here, before the first posting.
  const claimed = await claimUnderLockTimeout('payment batch', async () => (await sql`
    UPDATE supplier_payment_batches
    SET status = 'processed', processed_by = ${userId}::UUID, processed_at = NOW(), updated_at = NOW()
    WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID AND status = 'approved'
    RETURNING id
  `) as Row[]);
  if (claimed.length === 0) {
    // Re-read rather than trusting the row read before the UPDATE: the loser of
    // a double-click needs the status the winner left behind.
    const now = await getBatchById(companyId, id);
    throw new BatchNotProcessableError(now?.status ?? 'missing');
  }

  const totalAmount = batch.totalAmount;

  // GL: DR AP, CR Bank
  const apAccount = await getSystemAccount('payable', companyId);
  const bankAccount = batch.bankAccountId
    ? { id: batch.bankAccountId }
    : await getSystemAccount('bank', companyId);

  const lines: JournalLineInput[] = [
    { glAccountId: apAccount.id, debit: totalAmount, credit: 0,
      description: `Batch payment ${batch.batchNumber}` },
    { glAccountId: bankAccount.id, debit: 0, credit: totalAmount,
      description: `Batch payment ${batch.batchNumber}` },
  ];

  // No sourceDocumentId: gl_journal_entries.source_document_id has an FK to
  // captured_documents(id) only (migration 409); a batch's own id would
  // violate it. The batch <-> journal entry link is instead persisted below
  // via supplier_payment_batches.gl_journal_entry_id.
  const je = await createJournalEntry(companyId, {
    entryDate: batch.batchDate,
    description: `Supplier batch payment ${batch.batchNumber}`,
    source: 'auto_batch_payment',
    lines,
  }, userId);
  await postJournalEntry(companyId, je.id, userId);

  // Update all linked payments and their invoices atomically
  await withTransaction(async (tx) => {
    const payments = (await tx`
      SELECT sp.id, pa.invoice_id, pa.amount_allocated
      FROM supplier_payments sp
      JOIN payment_allocations pa ON pa.payment_id = sp.id
      WHERE sp.batch_id = ${id}::UUID
    `) as Row[];

    for (const p of payments) {
      await tx`
        UPDATE supplier_invoices
        SET amount_paid = amount_paid + ${Number(p.amount_allocated)},
            status = CASE
              WHEN (total_amount - amount_paid - ${Number(p.amount_allocated)}) <= 0.01 THEN 'paid'
              WHEN amount_paid + ${Number(p.amount_allocated)} > 0 THEN 'partially_paid'
              ELSE status END
        WHERE id = ${p.invoice_id}::UUID AND company_id = ${companyId}::UUID
      `;
    }

    await tx`UPDATE supplier_payments SET status = 'processed' WHERE batch_id = ${id}::UUID
      AND batch_id IN (SELECT id FROM supplier_payment_batches WHERE company_id = ${companyId}::UUID)`;
    // Only the journal link is left to write — the status, processor and
    // timestamp were set by the claim above. `company_id` is on the predicate
    // because every query in this codebase carries it, claim or no claim.
    await tx`
      UPDATE supplier_payment_batches
      SET gl_journal_entry_id = ${je.id}::UUID, updated_at = NOW()
      WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
    `;
  });

  log.info('Processed batch', { id, journalEntryId: je.id }, 'accounting');
}

/**
 * Draft OR approved: neither has moved money, and an approved batch the
 * process-time gate refuses (a bill cancelled or deleted since) must have a way
 * out — otherwise its allocations stay "promised" and block the bill for ever.
 * A batch in any other state is refused before anything is written.
 */
export async function cancelBatch(companyId: string, id: string): Promise<void> {
  await withTransaction(async (tx) => {
    // AP-01: the batch row first (waits for a netcash/submit in flight, which holds it FOR SHARE), then the guard.
    const locked = (await tx`SELECT batch_number FROM supplier_payment_batches
      WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID AND status IN ('draft', 'approved')
      FOR NO KEY UPDATE`) as Row[];
    if (locked[0]) await assertBatchNotSentToNetcash(companyId, id, String(locked[0].batch_number), 'cancelled');
    const done = (await tx`UPDATE supplier_payment_batches SET status = 'cancelled'
      WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID AND status IN ('draft', 'approved')
      RETURNING id`) as Row[];
    if (done.length === 0) {
      const now = await getBatchById(companyId, id);
      throw new SupplierPaymentRefusal(`Batch is ${now?.status ?? 'missing'} — only a draft or approved batch can be cancelled.`);
    }
    await tx`UPDATE supplier_payments SET status = 'cancelled' WHERE batch_id = ${id}::UUID
      AND status IN ('draft', 'approved') AND company_id = ${companyId}::UUID`;
  });
  log.info('Cancelled batch', { id }, 'accounting');
}

function mapRow(row: Row): SupplierPaymentBatch {
  return {
    id: String(row.id),
    batchNumber: row.batch_number ? String(row.batch_number) : '',
    batchDate: fmtDate(row.batch_date),
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
