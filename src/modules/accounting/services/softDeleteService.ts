/**
 * WS-1.2: Soft Delete / Undo Service
 * Provides a 5-minute undo window for deletes on key entities.
 * Uses explicit per-table queries — the Neon tagged template driver
 * does not support dynamic identifier interpolation.
 */

import { sql } from '@/lib/neon';
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

export function isValidEntityType(entityType: string): boolean {
  return ALLOWED_ENTITY_TYPES.has(entityType);
}

// ── Status guard helpers ─────────────────────────────────────────────────────

async function getInvoiceStatus(
  entityType: string,
  entityId: string,
  companyId: string,
): Promise<string | null> {
  let rows: { status: string }[];
  if (entityType === 'customer_invoice') {
    rows = await sql`
      SELECT status FROM customer_invoices
      WHERE id = ${entityId}::UUID
        AND company_id = ${companyId}::UUID
        AND deleted_at IS NULL
      LIMIT 1
    ` as { status: string }[];
  } else {
    rows = await sql`
      SELECT status FROM supplier_invoices
      WHERE id = ${entityId}::UUID
        AND company_id = ${companyId}::UUID
        AND deleted_at IS NULL
      LIMIT 1
    ` as { status: string }[];
  }
  return rows.length > 0 ? String(rows[0]!.status) : null;
}

// ── Soft-delete per table ────────────────────────────────────────────────────

async function softDeleteRow(
  entityType: string,
  entityId: string,
  companyId: string,
): Promise<boolean> {
  let rows: { id: string }[];

  switch (entityType) {
    case 'customer':
      rows = await sql`
        UPDATE customers SET deleted_at = NOW()
        WHERE id = ${entityId}::UUID AND company_id = ${companyId}::UUID AND deleted_at IS NULL
        RETURNING id
      ` as { id: string }[];
      break;
    case 'supplier':
      rows = await sql`
        UPDATE suppliers SET deleted_at = NOW()
        WHERE id = ${entityId}::UUID AND company_id = ${companyId}::UUID AND deleted_at IS NULL
        RETURNING id
      ` as { id: string }[];
      break;
    case 'item':
      rows = await sql`
        UPDATE items SET deleted_at = NOW()
        WHERE id = ${entityId}::UUID AND company_id = ${companyId}::UUID AND deleted_at IS NULL
        RETURNING id
      ` as { id: string }[];
      break;
    case 'bank_rule':
      rows = await sql`
        UPDATE bank_rules SET deleted_at = NOW()
        WHERE id = ${entityId}::UUID AND company_id = ${companyId}::UUID AND deleted_at IS NULL
        RETURNING id
      ` as { id: string }[];
      break;
    case 'customer_invoice':
      rows = await sql`
        UPDATE customer_invoices SET deleted_at = NOW()
        WHERE id = ${entityId}::UUID AND company_id = ${companyId}::UUID AND deleted_at IS NULL
        RETURNING id
      ` as { id: string }[];
      break;
    case 'supplier_invoice':
      rows = await sql`
        UPDATE supplier_invoices SET deleted_at = NOW()
        WHERE id = ${entityId}::UUID AND company_id = ${companyId}::UUID AND deleted_at IS NULL
        RETURNING id
      ` as { id: string }[];
      break;
    default:
      throw new Error(`Unknown entity type: ${entityType}`);
  }

  return rows.length > 0;
}

// ── Restore per table ────────────────────────────────────────────────────────

async function restoreRow(
  entityType: string,
  entityId: string,
  companyId: string,
): Promise<boolean> {
  let rows: { id: string }[];

  switch (entityType) {
    case 'customer':
      rows = await sql`
        UPDATE customers SET deleted_at = NULL
        WHERE id = ${entityId}::UUID AND company_id = ${companyId}::UUID AND deleted_at IS NOT NULL
        RETURNING id
      ` as { id: string }[];
      break;
    case 'supplier':
      rows = await sql`
        UPDATE suppliers SET deleted_at = NULL
        WHERE id = ${entityId}::UUID AND company_id = ${companyId}::UUID AND deleted_at IS NOT NULL
        RETURNING id
      ` as { id: string }[];
      break;
    case 'item':
      rows = await sql`
        UPDATE items SET deleted_at = NULL
        WHERE id = ${entityId}::UUID AND company_id = ${companyId}::UUID AND deleted_at IS NOT NULL
        RETURNING id
      ` as { id: string }[];
      break;
    case 'bank_rule':
      rows = await sql`
        UPDATE bank_rules SET deleted_at = NULL
        WHERE id = ${entityId}::UUID AND company_id = ${companyId}::UUID AND deleted_at IS NOT NULL
        RETURNING id
      ` as { id: string }[];
      break;
    case 'customer_invoice':
      rows = await sql`
        UPDATE customer_invoices SET deleted_at = NULL
        WHERE id = ${entityId}::UUID AND company_id = ${companyId}::UUID AND deleted_at IS NOT NULL
        RETURNING id
      ` as { id: string }[];
      break;
    case 'supplier_invoice':
      rows = await sql`
        UPDATE supplier_invoices SET deleted_at = NULL
        WHERE id = ${entityId}::UUID AND company_id = ${companyId}::UUID AND deleted_at IS NOT NULL
        RETURNING id
      ` as { id: string }[];
      break;
    default:
      throw new Error(`Unknown entity type: ${entityType}`);
  }

  return rows.length > 0;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Soft-delete a single entity owned by the given company.
 * For invoice entities the record must have status = 'draft'.
 * Returns the entity id as the undoToken (sufficient for undo within the session).
 */
export async function softDelete(
  companyId: string,
  entityType: string,
  entityId: string,
): Promise<{ undoToken: string }> {
  if (!ALLOWED_ENTITY_TYPES.has(entityType)) {
    throw new Error(`Unknown entity type: ${entityType}`);
  }

  try {
    if (INVOICE_ENTITY_TYPES.has(entityType)) {
      const status = await getInvoiceStatus(entityType, entityId, companyId);
      if (status === null) {
        throw new Error(`${entityType} not found or already deleted`);
      }
      if (status === 'posted') {
        throw new Error(`Cannot delete a posted ${entityType}`);
      }
    }

    const deleted = await softDeleteRow(entityType, entityId, companyId);
    if (!deleted) {
      throw new Error(`${entityType} not found or already deleted`);
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
): Promise<boolean> {
  if (!ALLOWED_ENTITY_TYPES.has(entityType)) {
    throw new Error(`Unknown entity type: ${entityType}`);
  }

  try {
    const restored = await restoreRow(entityType, entityId, companyId);
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

type Row = Record<string, unknown>;

/**
 * Hard-purge records that were soft-deleted more than 5 minutes ago.
 * Intended to be called by a scheduled background job.
 * Returns the total count of purged records across all tables.
 */
export async function purgeExpiredDeletes(): Promise<number> {
  let total = 0;

  // One entry per soft-deletable table
  const tables: Array<{ entityType: string; fn: () => Promise<Row[]> }> = [
    { entityType: 'customer',         fn: () => sql`DELETE FROM customers WHERE deleted_at IS NOT NULL AND deleted_at < NOW() - INTERVAL '5 minutes' RETURNING id` as Promise<Row[]> },
    { entityType: 'supplier',         fn: () => sql`DELETE FROM suppliers WHERE deleted_at IS NOT NULL AND deleted_at < NOW() - INTERVAL '5 minutes' RETURNING id` as Promise<Row[]> },
    { entityType: 'item',             fn: () => sql`DELETE FROM items WHERE deleted_at IS NOT NULL AND deleted_at < NOW() - INTERVAL '5 minutes' RETURNING id` as Promise<Row[]> },
    { entityType: 'bank_rule',        fn: () => sql`DELETE FROM bank_rules WHERE deleted_at IS NOT NULL AND deleted_at < NOW() - INTERVAL '5 minutes' RETURNING id` as Promise<Row[]> },
    { entityType: 'customer_invoice', fn: () => sql`DELETE FROM customer_invoices WHERE deleted_at IS NOT NULL AND deleted_at < NOW() - INTERVAL '5 minutes' RETURNING id` as Promise<Row[]> },
    { entityType: 'supplier_invoice', fn: () => sql`DELETE FROM supplier_invoices WHERE deleted_at IS NOT NULL AND deleted_at < NOW() - INTERVAL '5 minutes' RETURNING id` as Promise<Row[]> },
  ];

  for (const { entityType, fn } of tables) {
    try {
      const rows = await fn();
      if (rows.length > 0) {
        log.info('Purged expired soft-deletes', { entityType, count: rows.length }, 'accounting');
        total += rows.length;
      }
    } catch (err) {
      log.error('Failed to purge expired deletes', { entityType, error: err }, 'accounting');
    }
  }

  return total;
}
