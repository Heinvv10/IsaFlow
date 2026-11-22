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
import { asBillGrnRefused, assertBillRestorableGrn } from '../ap/billGoodsReceivedLink';
import { SoftDeleteRefusalError } from './softDeleteErrors';
import { assertBillRestorableSupplier } from '../ap/billSupplierLive';

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
        -- Undoes only what a merge changed: deleted_at and merged_into_id. No merge path renames the supplier or
        -- touches is_active (a merged-away row is told by merged_into_id), so the name and is_active come back as
        -- they were, and a supplier the user named 'Foo [MERGED]' is never touched. Rows from the old route, which
        -- appended ' [MERGED]', were never deleted and carry no merged_into_id: they are not restored here.
        UPDATE suppliers SET deleted_at = NULL, merged_into_id = NULL
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
      // A bill naming a goods received note cancelled while it was deleted stays deleted (the note held FOR SHARE first).
      await assertBillRestorableGrn(companyId, entityId);
      // Nor one whose supplier was soft-deleted meanwhile (the restore does not fire 1021's supplier-live trigger). Only a plain supplier
      // soft-delete leaves a deleted bill on a deleted supplier: both merges move deleted bills to their target too.
      await assertBillRestorableSupplier(companyId, entityId);
      // 1021's grn-live trigger re-decides the note on this UPDATE (under the hold assertBillRestorableGrn already took, so it agrees
      // with it); its refusal is the same 400 as the check's.
      try {
        rows = await sql`
          UPDATE supplier_invoices SET deleted_at = NULL
          WHERE id = ${entityId}::UUID AND company_id = ${companyId}::UUID AND deleted_at IS NOT NULL
          RETURNING id
        ` as { id: string }[];
      } catch (err) {
        if (asBillGrnRefused(err)) {
          throw new SoftDeleteRefusalError('This bill names a goods received note that is cancelled, or that is not one of this company\'s, so it '
            + 'cannot be restored; enter the bill again as a new one (naming a live note, or none)');
        }
        throw err;
      }
      break;
    default:
      throw new Error(`Unknown entity type: ${entityType}`);
  }

  return rows.length > 0;
}
