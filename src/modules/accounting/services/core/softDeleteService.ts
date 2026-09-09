/**
 * WS-1.2: Soft Delete / Undo Service
 * Provides a 5-minute undo window for deletes on key entities.
 * Uses explicit per-table queries — the Neon tagged template driver
 * does not support dynamic identifier interpolation.
 */

import { sql, withSavepoint } from '@/lib/neon';
import { softDeleteRow, restoreRow } from './softDeleteRowOps';
import { assertNoOpenDocuments } from './masterDeleteGuards';
import { prepareInvoiceDelete, reinstateInvoiceJournal } from './softDeleteJournalService';
import { SoftDeleteRefusalError } from './softDeleteErrors';
import { log } from '@/lib/logger';
import type { DbRow } from '@/types/db';

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

export function isValidEntityType(entityType: string): boolean {
  return ALLOWED_ENTITY_TYPES.has(entityType);
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
): Promise<{ undoToken: string }> {
  if (!ALLOWED_ENTITY_TYPES.has(entityType)) {
    throw new Error(`Unknown entity type: ${entityType}`);
  }

  // SAVEPOINT for the same reason cancel takes one: the route answers 400 on a
  // refusal and withAuth COMMITs the request tx on any <5xx, so a failure after
  // the reversal's draft INSERTs would orphan-commit them.
  return withSavepoint('soft_delete_entity', () =>
    softDeleteInner(companyId, entityType, entityId, userId),
  );
}

async function softDeleteInner(
  companyId: string,
  entityType: string,
  entityId: string,
  userId: string,
): Promise<{ undoToken: string }> {
  try {
    // An invoice that is out of the subledger must be out of the ledger too:
    // approve posted a journal, so the delete reverses it, exactly as cancel
    // does. Guards and reversal both live in softDeleteJournalService.
    if (INVOICE_ENTITY_TYPES.has(entityType)) {
      await prepareInvoiceDelete(entityType, entityId, companyId, userId);
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
    log.error('Soft delete failed', { entityType, entityId, error: err }, 'accounting');
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
): Promise<boolean> {
  if (!ALLOWED_ENTITY_TYPES.has(entityType)) {
    throw new Error(`Unknown entity type: ${entityType}`);
  }

  return withSavepoint('undo_delete_entity', () =>
    undoDeleteInner(companyId, entityType, entityId, userId),
  );
}

async function undoDeleteInner(
  companyId: string,
  entityType: string,
  entityId: string,
  userId: string,
): Promise<boolean> {
  try {
    const restored = await restoreRow(entityType, entityId, companyId);
    // Put the journal back, or the restored invoice is in the subledger with
    // nothing behind it on the control account — the delete's defect mirrored.
    if (restored && INVOICE_ENTITY_TYPES.has(entityType)) {
      await reinstateInvoiceJournal(entityType, entityId, companyId, userId);
    }
    if (restored) {
      log.info('Undo delete — entity restored', { entityType, entityId, companyId }, 'accounting');
    } else {
      log.warn('Undo delete — entity not found or already purged', { entityType, entityId }, 'accounting');
    }
    return restored;
  } catch (err) {
    log.error('Undo delete failed', { entityType, entityId, error: err }, 'accounting');
    throw err;
  }
}


/**
 * Hard-purge records that were soft-deleted more than 5 minutes ago.
 * Intended to be called by a scheduled background job.
 * Returns the total count of purged records across all tables.
 *
 * NOT WIRED UP TODAY — `git grep purgeExpiredDeletes -- src pages` finds no
 * caller — and K-053 is why that matters before one is added. A soft-deleted
 * invoice keeps its row precisely so the sub-ledger can still answer the DATED
 * question `documentInLedgerAsAtFragment` asks: the delete's GL reversal is
 * dated to the delete, so for every as-at date between the document and the
 * delete the control account still carries it and the document must still be
 * countable. Hard-DELETEing the row removes the only thing that predicate can
 * evaluate, so those historical dates lose the document from the sub-ledger
 * side while the GL keeps it — permanently, and with no repair. Whoever wires
 * a caller up has to decide that trade first; a purge window measured in
 * minutes almost certainly cannot.
 *
 * The `soft_delete_journal_reversals` row (migration 653) is deleted with the
 * document it describes: it is keyed on (company_id, entity_type, entity_id)
 * with no FK to the invoice, so the purge would otherwise strand it.
 */
export async function purgeExpiredDeletes(): Promise<number> {
  let total = 0;

  // One entry per soft-deletable table.
  // BL-80: RETURNING id, company_id so we can log per-tenant attribution
  // and make a mis-fired purge visible in structured logs.
  const tables: Array<{ entityType: string; fn: () => Promise<DbRow[]> }> = [
    { entityType: 'customer',         fn: () => sql`DELETE FROM customers WHERE deleted_at IS NOT NULL AND deleted_at < NOW() - INTERVAL '5 minutes' RETURNING id, company_id` as Promise<DbRow[]> },
    { entityType: 'supplier',         fn: () => sql`DELETE FROM suppliers WHERE deleted_at IS NOT NULL AND deleted_at < NOW() - INTERVAL '5 minutes' RETURNING id, company_id` as Promise<DbRow[]> },
    { entityType: 'item',             fn: () => sql`DELETE FROM items WHERE deleted_at IS NOT NULL AND deleted_at < NOW() - INTERVAL '5 minutes' RETURNING id, company_id` as Promise<DbRow[]> },
    { entityType: 'bank_rule',        fn: () => sql`DELETE FROM bank_rules WHERE deleted_at IS NOT NULL AND deleted_at < NOW() - INTERVAL '5 minutes' RETURNING id, company_id` as Promise<DbRow[]> },
    { entityType: 'customer_invoice', fn: () => sql`DELETE FROM customer_invoices WHERE deleted_at IS NOT NULL AND deleted_at < NOW() - INTERVAL '5 minutes' RETURNING id, company_id` as Promise<DbRow[]> },
    { entityType: 'supplier_invoice', fn: () => sql`DELETE FROM supplier_invoices WHERE deleted_at IS NOT NULL AND deleted_at < NOW() - INTERVAL '5 minutes' RETURNING id, company_id` as Promise<DbRow[]> },
  ];

  for (const { entityType, fn } of tables) {
    try {
      const rows = await fn();
      if (rows.length > 0) {
        if (entityType === 'customer_invoice' || entityType === 'supplier_invoice') {
          // Company-scoped by pair, not by entity_id alone: the id list comes
          // from a purge that spans every tenant.
          await sql`
            DELETE FROM soft_delete_journal_reversals r
            WHERE r.entity_type = ${entityType}
              AND (r.company_id, r.entity_id) IN (
                SELECT c::UUID, e::UUID
                FROM unnest(${rows.map((r) => String(r.company_id))}::text[],
                            ${rows.map((r) => String(r.id))}::text[]) AS t(c, e)
              )`;
        }
        // BL-80: log per-tenant attribution so a mis-fired purge is observable
        const companyIds = [...new Set(rows.map((r) => String(r.company_id)))];
        log.info('Purged expired soft-deletes', {
          table: entityType,
          companyIds,
          rowCount: rows.length,
        }, 'accounting');
        total += rows.length;
      }
    } catch (err) {
      log.error('Failed to purge expired deletes', { entityType, error: err }, 'accounting');
    }
  }

  return total;
}
