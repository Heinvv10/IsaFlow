/**
 * The per-table UPDATE that sets and clears `deleted_at`.
 *
 * Extracted from softDeleteService for the 300-line cap, alongside
 * masterDeleteGuards and softDeleteInvoiceGuards. Explicit per-table queries
 * because the tagged-template driver does not interpolate identifiers; the
 * status-predicated WHERE (`deleted_at IS NULL` / `IS NOT NULL`) is what makes
 * a concurrent second delete or second undo return false instead of repeating
 * the work.
 */

import { sql } from '@/lib/neon';

// ── Soft-delete per table ────────────────────────────────────────────────────

export async function softDeleteRow(
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

export async function restoreRow(
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
