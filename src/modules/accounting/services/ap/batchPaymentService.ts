/**
 * Supplier Batch Payment Service
 * Phase 1 Sage Alignment: Bulk supplier payment processing
 */

import { sql } from '@/lib/neon';
import {assertIndependentRequestReview} from '@/modules/accounting/services/controls/independentReview';
import { fmtDate } from '@/lib/fmtDate';
import type { DbRow } from '@/lib/neon';
import { claimUnderLockTimeout } from '../core/documentClaimLock';
import type { SupplierPaymentBatch, BatchPaymentCreateInput } from '../../types/ap.types';

import {batchWrite,createControlledBatch,changeBatchStatus} from './batchPaymentWriteService';
import {requireControlTx} from '../controls/context';
import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import {runApControlled,type ApApprovalOptions} from './apControlBoundary';
import {executePaymentBatchEffect} from './paymentBatchExecution';
type Row = DbRow;

export async function getBatches(companyId: string, filters?: {
  status?: string;
  limit?: number;
  offset?: number;
}): Promise<{ items: SupplierPaymentBatch[]; total: number }> {
  const ctx=requireControlTx();
  if(!companyId||ctx.principal.companyId!==companyId)throw new Error('Authenticated batch company required');
  await assertEffectivePermission(ctx,'read:bank-tx');
  const limit = Math.max(1,Math.min(100,filters?.limit || 50));
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
  const ctx=requireControlTx();
  if(!companyId||ctx.principal.companyId!==companyId)throw new Error('Authenticated batch company required');
  await assertEffectivePermission(ctx,'read:bank-tx');
  const rows=(await sql`SELECT * FROM supplier_payment_batches WHERE id = ${id} AND company_id = ${companyId}::uuid`) as Row[];
  if (!rows[0]) return null;
  return mapRow(rows[0]);
}

export async function createBatch(companyId: string, input: BatchPaymentCreateInput, userId: string): Promise<SupplierPaymentBatch> {
  const id = await createControlledBatch(companyId, input, userId);
  return (await getBatchById(companyId, id))!;
}
export async function approveBatch(companyId: string, id: string, userId: string): Promise<void> {
  assertIndependentRequestReview();
  await changeBatchStatus(companyId,id,userId,'approved');
}

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

export async function processBatch(companyId: string, id: string, userId: string, opts?: ApApprovalOptions): Promise<void> {
  await batchWrite(companyId,userId,async ctx=>{
    // LOCK-THEN-CHECK before anything is posted, bounded by the same 5s ceiling
    // as every other document claim. What this guards is what the unlocked
    // status read let through: two "process" clicks both passed it and both
    // posted DR AP / CR Bank for the whole batch, crediting the bank twice and
    // overstating the supplier ledger. The loser blocks here, reads the status
    // the winner left behind, and refuses with a TYPED error — the route
    // answers 409 with it, and `withAuth` has nothing to commit because the
    // controlled effect below has not run. The effect re-takes this row FOR
    // UPDATE and re-checks the status; this is the same guard, moved in front
    // of the kernel so the refusal keeps its shape.
    const current = await claimUnderLockTimeout('payment batch', async () => (await ctx.sql`
      SELECT status FROM supplier_payment_batches
      WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid
      FOR UPDATE
    `) as Row[]);
    if (current.length === 0) throw new Error('Batch not found');
    if (String(current[0]!.status) !== 'approved') throw new BatchNotProcessableError(String(current[0]!.status));
    return runApControlled(companyId,userId,
      {operation:'supplier_payment_batch.process',entityType:'supplier_payment_batch',entityId:id},opts,
      permit=>executePaymentBatchEffect(id,permit));
  });
}

export async function cancelBatch(companyId: string, id: string): Promise<void> {
  await changeBatchStatus(companyId,id,undefined,'cancelled');
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
