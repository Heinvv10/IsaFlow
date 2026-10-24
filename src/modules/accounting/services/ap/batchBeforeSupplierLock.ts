/**
 * Supplier <-> payment batch lock order: BATCH row first (id order), then the supplier row.
 *
 * The bank-file gate (`batchBankFileGate`, `supplierBankVerificationGate`: eft-generate, eft-file-release,
 * netcash/submit) holds the batch and then share-locks its payee suppliers. A writer that took a supplier and then
 * a batch (updateSupplier's bank-detail stamp, the take-on overwrite, both supplier merges) closed a 40P01 cycle
 * with it. Those writers go through `lockBatchesBeforeSuppliers` (bank/.claude.md, ap/.claude.md).
 * Since migration 923 the gate then share-locks the batch's paying gl_accounts row too (batch -> supplier ->
 * gl_accounts, batchApprovedDigest.lockBatchPayees). No writer of gl_accounts reaches a batch or supplier row
 * (2026-10-23 census of `UPDATE gl_accounts`): one that does must lock in that order.
 * Payments come after their supplier too: updateSupplier takes the supplier and then its payments
 * (`recordBankDetailsSetter`); a payment writer that would key-share the supplier after the payment (a second write
 * of a supplier-referencing row re-runs its FK check) either writes once (processSupplierPayment) or key-shares the
 * supplier first (`lockSupplierPaymentForUpdate`'s `supplierFirst`, 2026-10-24). Full order: batch -> supplier ->
 * payments -> bills -> gl_accounts.
 */

import { sql, withSavepoint } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

const MAX_LOCK_ATTEMPTS = 5;

/**
 * The batch set kept changing while a supplier was being locked. A typed lock timeout: the `_LOCK_TIMEOUT` code makes
 * withErrorHandler answer 503 + Retry-After and an MCP tool show the message (`isLockTimeoutError`, REFUSAL_CODES).
 * Raised after the savepoint gave every lock back and before anything was written.
 */
export class SupplierBatchLockTimeoutError extends Error {
  readonly code = 'SUPPLIER_BATCH_LOCK_TIMEOUT';
  constructor() {
    super('Payment batches for this supplier kept changing while it was being locked — retry in a moment.');
    this.name = 'SupplierBatchLockTimeoutError';
  }
}

/** Raised inside the savepoint to give back the locks of an attempt whose batch set was out of date. */
class BatchSetGrew extends Error {
  constructor(readonly batchIds: string[]) {
    super('a batch started paying the supplier after the batches were read');
    this.name = 'BatchSetGrew';
  }
}

async function batchIdsPayingSuppliers(companyId: string, supplierIds: readonly string[],
  statuses: readonly string[] | null): Promise<string[]> {
  const rows = (await sql`
    SELECT b.id FROM supplier_payment_batches b
    WHERE b.company_id = ${companyId}::UUID
      AND (${statuses === null} OR b.status = ANY(${statuses ?? []}::TEXT[]))
      AND b.id IN (SELECT sp.batch_id FROM supplier_payments sp
                   WHERE sp.company_id = ${companyId}::UUID AND sp.supplier_id = ANY(${supplierIds}::UUID[])
                     AND sp.batch_id IS NOT NULL)
    ORDER BY b.id
  `) as DbRow[];
  return rows.map((r) => String(r.id));
}

/**
 * Take the batches paying `supplierIds` (in `statuses`, null = any) `FOR UPDATE` in id order, THEN run
 * `lockSuppliers` (the caller's own `FOR UPDATE` on the supplier rows), then re-read the batch set.
 *
 * Why the re-read can be trusted: with the supplier rows held, a payment cannot JOIN a batch for them. A payment
 * enters a batch only by an INSERT naming the batch and its supplier, and that INSERT's foreign key takes `KEY SHARE`
 * on the supplier row, which the held `FOR UPDATE` blocks; no writer UPDATEs `supplier_payments.batch_id`
 * (`tests/unit/services/ap/batchMembershipCensus.test.ts` fails if one appears, because it would take no supplier
 * lock). A merge that moves payments onto a supplier takes that supplier `FOR UPDATE` too. So only a batch that
 * committed between the first read and the supplier lock can be missing, and it would have to be locked AFTER the
 * supplier: the attempt is rolled back whole (its savepoint gives the supplier AND the batch locks back, keeping id
 * order) and retried with that batch in the set. Bounded: a set that keeps growing is a retryable timeout.
 */
export async function lockBatchesBeforeSuppliers<T>(companyId: string, supplierIds: readonly string[],
  statuses: readonly string[] | null, lockSuppliers: () => Promise<T>): Promise<T> {
  let known: string[] = [];
  for (let attempt = 1; attempt <= MAX_LOCK_ATTEMPTS; attempt += 1) {
    try {
      return await withSavepoint(`batch_before_supplier_${attempt}`, async () => {
        known = [...new Set([...known, ...await batchIdsPayingSuppliers(companyId, supplierIds, statuses)])].sort();
        await sql`
          SELECT id FROM supplier_payment_batches
          WHERE company_id = ${companyId}::UUID AND id = ANY(${known}::UUID[])
          ORDER BY id FOR UPDATE
        `;
        const result = await lockSuppliers();
        const missed = (await batchIdsPayingSuppliers(companyId, supplierIds, statuses)).filter((id) => !known.includes(id));
        if (missed.length > 0) throw new BatchSetGrew(missed);
        return result;
      });
    } catch (err) {
      if (!(err instanceof BatchSetGrew)) throw err;
      known = [...known, ...err.batchIds];
    }
  }
  throw new SupplierBatchLockTimeoutError();
}

/**
 * The batches paying any of `batchSupplierIds`, then ALL of `supplierIds` (id order, `FOR UPDATE`), as ONE set: for a
 * writer that touches several suppliers in one transaction (the take-on import). The batches are those of the
 * suppliers whose bank details may change; every supplier the transaction will write is in `supplierIds`, so two such
 * writers take the same rows in the same (id) order whatever order their rows are in. Taking each supplier's batches
 * or row only when its turn comes would lock a batch while holding an earlier supplier, or one supplier while holding
 * another, the cycles this file exists to prevent.
 */
export async function lockBatchesThenSupplierSet(companyId: string, batchSupplierIds: readonly string[],
  supplierIds: readonly string[], statuses: readonly string[] | null): Promise<void> {
  if (supplierIds.length === 0) return;
  await lockBatchesBeforeSuppliers(companyId, batchSupplierIds, statuses, () => sql`
    SELECT id FROM suppliers
    WHERE company_id = ${companyId}::UUID AND id = ANY(${supplierIds}::UUID[])
    ORDER BY id FOR UPDATE
  `);
}
