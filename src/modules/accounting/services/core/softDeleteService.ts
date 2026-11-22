/**
 * WS-1.2: Soft Delete / Undo Service
 * Provides a 5-minute undo window for deletes on key entities.
 * Uses explicit per-table queries — the Neon tagged template driver
 * does not support dynamic identifier interpolation.
 */

import { withSavepoint } from '@/lib/neon';
import { softDeleteRow, restoreRow } from './softDeleteRowOps';
import { assertNoOpenDocuments } from './masterDeleteGuards';
import { prepareInvoiceDelete, reinstateInvoiceJournal } from './softDeleteJournalService';
import { SoftDeleteRefusalError } from './softDeleteErrors';
import { underFlowLockBudget } from './rowLockBudget';
import { isLockTimeoutError } from '@/lib/lockTimeout';
import { log } from '@/lib/logger';

// Allowlist of entity types that support soft-delete
const ALLOWED_ENTITY_TYPES = new Set([
  'customer',
  'supplier',
  'item',
  'bank_rule',
  'customer_invoice',
  'supplier_invoice',
]);

// Invoice entity types require a status guard (no deleting posted records)
const INVOICE_ENTITY_TYPES = new Set(['customer_invoice', 'supplier_invoice']);

/**
 * allowReversal: the caller's Approve on the invoice's module (#1656, round 4). Deleting an invoice that is approved or later, or
 * carries a journal, REVERSES that journal; undoing such a delete re-instates it. Both are approval acts, decided under the invoice's
 * row lock (a draft / pending / cancelled invoice with no journal needs nothing). Required, so every caller states it.
 */
export interface SoftDeleteOptions { allowReversal: boolean }

export function isValidEntityType(entityType: string): boolean {
  return ALLOWED_ENTITY_TYPES.has(entityType);
}

/**
 * An invoice's delete or undo under ONE flow lock budget (D8 round 11), inside this service's own savepoint as every
 * D8 entry point runs it: the invoice row lock, the undo's `deleted_at` UPDATE and the contra posting each wait at
 * most 5 s, then answer `RowLockTimeoutError` (503). The request transaction stays withAuth's. Other entity types post
 * nothing and are left as they were.
 */
function underInvoiceLockBudget<T>(entityType: string, entityId: string, fn: () => Promise<T>): Promise<T> {
  return INVOICE_ENTITY_TYPES.has(entityType) ? underFlowLockBudget(`Invoice ${entityId}`, fn) : fn();
}

/**
 * A lock wait that ran out — the raw 55P03 the budget above converts, or a nested helper's typed timeout — is an
 * answered 503, not a fault: logged at info (D8 round 13). Everything else is logged at error.
 */
function logFailure(message: string, data: Record<string, unknown>, err: unknown): void {
  if ((err as { code?: unknown } | null)?.code === '55P03' || isLockTimeoutError(err)) {
    log.info(message, { ...data, error: (err as Error).message }, 'accounting');
  } else {
    log.error(message, { ...data, error: err }, 'accounting');
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Soft-delete a single entity owned by the given company.
 * An invoice must not be posted and must carry no payments, and its approval
 * journal is reversed here so the ledger stops carrying a document the
 * subledger no longer shows.
 * Returns the entity id as the undoToken (sufficient for undo within the session).
 */
export async function softDelete(
  companyId: string,
  entityType: string,
  entityId: string,
  userId: string,
  options: SoftDeleteOptions,
): Promise<{ undoToken: string }> {
  if (!ALLOWED_ENTITY_TYPES.has(entityType)) {
    throw new Error(`Unknown entity type: ${entityType}`);
  }

  // SAVEPOINT for the same reason cancel takes one: the route answers 400 on a
  // refusal and withAuth COMMITs the request tx on any <5xx, so a failure after
  // the reversal's draft INSERTs would orphan-commit them.
  return withSavepoint('soft_delete_entity', () => underInvoiceLockBudget(entityType, entityId, () =>
    softDeleteInner(companyId, entityType, entityId, userId, options),
  ));
}

async function softDeleteInner(
  companyId: string,
  entityType: string,
  entityId: string,
  userId: string,
  options: SoftDeleteOptions,
): Promise<{ undoToken: string }> {
  try {
    // An invoice that is out of the subledger must be out of the ledger too:
    // approve posted a journal, so the delete reverses it, exactly as cancel
    // does. Guards and reversal both live in softDeleteJournalService.
    if (INVOICE_ENTITY_TYPES.has(entityType)) {
      await prepareInvoiceDelete(entityType, entityId, companyId, userId, options);
    }

    // W2 (P2.1): open-document guard (extracted to masterDeleteGuards for
    // the 300-line cap).
    if (entityType === 'customer' || entityType === 'supplier') {
      await assertNoOpenDocuments(companyId, entityType, entityId);
    }

    const deleted = await softDeleteRow(entityType, entityId, companyId);
    if (!deleted) {
      throw new SoftDeleteRefusalError(`${entityType} not found or already deleted`);
    }

    log.info('Soft deleted entity', { entityType, entityId, companyId }, 'accounting');
    return { undoToken: entityId };
  } catch (err) {
    logFailure('Soft delete failed', { entityType, entityId }, err);
    throw err;
  }
}

/**
 * Restore a soft-deleted entity within the undo window.
 * Returns true when restored, false when the record was not found
 * (already purged or never deleted).
 */
export async function undoDelete(
  companyId: string,
  entityType: string,
  entityId: string,
  userId: string,
  options: SoftDeleteOptions,
): Promise<boolean> {
  if (!ALLOWED_ENTITY_TYPES.has(entityType)) {
    throw new Error(`Unknown entity type: ${entityType}`);
  }

  return withSavepoint('undo_delete_entity', () => underInvoiceLockBudget(entityType, entityId, () =>
    undoDeleteInner(companyId, entityType, entityId, userId, options),
  ));
}

async function undoDeleteInner(
  companyId: string,
  entityType: string,
  entityId: string,
  userId: string,
  options: SoftDeleteOptions,
): Promise<boolean> {
  try {
    const restored = await restoreRow(entityType, entityId, companyId);
    // Put the journal back, or the restored invoice is in the subledger with
    // nothing behind it on the control account — the delete's defect mirrored.
    if (restored && INVOICE_ENTITY_TYPES.has(entityType)) {
      await reinstateInvoiceJournal(entityType, entityId, companyId, userId, options);
    }
    if (restored) {
      log.info('Undo delete — entity restored', { entityType, entityId, companyId }, 'accounting');
    } else {
      log.warn('Undo delete — entity not found or already purged', { entityType, entityId }, 'accounting');
    }
    return restored;
  } catch (err) {
    logFailure('Undo delete failed', { entityType, entityId }, err);
    throw err;
  }
}

export { purgeExpiredDeletes } from './softDeletePurge';
