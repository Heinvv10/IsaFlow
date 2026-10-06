/**
 * Who changed WHERE a supplier's money goes, recorded as an author of the
 * payments it changes (R-035 PR5; Hein, 2026-10-06: whoever sets the amount or
 * the destination of the money is an author, and may not approve sending it).
 *
 * A payment's approval digest reads the payee's bank details LIVE (migration
 * 867): they are not copied onto the payment, and eft-generate / netcash read
 * them at send time. So an edit of a supplier's bank details moves the digest
 * of every unpaid payment to that supplier, and of every batch carrying one —
 * the approval goes stale (fail closed) — and its editor joins their authors
 * here, append-only, so they cannot approve the re-submitted payment either.
 * Paid payments are history and are left alone. Creating a payment stamps
 * nothing (its creator is created_by).
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

/** The bank columns the 867 digest hashes; a change to any one re-routes the money. */
const BANK_COLUMNS = ['bank_name', 'bank_account_number', 'bank_branch_code', 'bank_account_type', 'bank_account_holder'] as const;

/**
 * The supplier's bank details, under a row lock held to the end of the request
 * (the same row updateSupplier and both supplier merges lock), so the change
 * an edit makes is judged against what it replaced. Null: no such supplier.
 */
export async function lockSupplierBankDetails(companyId: string, supplierId: string): Promise<DbRow | null> {
  const rows = (await sql`
    SELECT bank_name, bank_account_number, bank_branch_code, bank_account_type, bank_account_holder
    FROM suppliers WHERE id = ${supplierId}::UUID AND company_id = ${companyId}::UUID
    FOR UPDATE
  `) as DbRow[];
  return rows[0] ?? null;
}

/** True when any bank column differs (a column the row does not carry counts as unchanged). */
export function bankDetailsChanged(before: DbRow, after: DbRow): boolean {
  return BANK_COLUMNS.some((c) => c in after && (before[c] ?? null) !== (after[c] ?? null));
}

/**
 * Stamp `userId` onto every draft or approved payment to the supplier and
 * every draft or approved batch carrying one. Not an UPDATE OF status, so the
 * 867 backstop does not fire.
 */
export async function stampUnpaidPaymentsToSupplier(companyId: string, supplierId: string, userId: string): Promise<void> {
  await sql`
    WITH stamped AS (
      UPDATE supplier_payments
      SET content_authors = approval_add_author(content_authors, ${userId}::UUID), content_edited_at = NOW()
      WHERE company_id = ${companyId}::UUID AND supplier_id = ${supplierId}::UUID AND status IN ('draft', 'approved')
      RETURNING batch_id
    )
    UPDATE supplier_payment_batches
    SET content_authors = approval_add_author(content_authors, ${userId}::UUID), content_edited_at = NOW()
    WHERE company_id = ${companyId}::UUID AND status IN ('draft', 'approved')
      AND id IN (SELECT batch_id FROM stamped WHERE batch_id IS NOT NULL)
  `;
}

/**
 * A supplier merge re-pointed these payments (supplier_id is approval
 * content, and with it the payee's bank details): stamp the merging user
 * onto each batch any of them belongs to. The payments themselves are
 * stamped by the merge's own re-pointing UPDATE.
 */
export async function stampBatchesOfMovedPayments(companyId: string, batchIds: unknown[], userId: string): Promise<void> {
  const ids = [...new Set(batchIds.filter((b): b is string => typeof b === 'string'))];
  if (ids.length === 0) return;
  await sql`
    UPDATE supplier_payment_batches
    SET content_authors = approval_add_author(content_authors, ${userId}::UUID), content_edited_at = NOW()
    WHERE company_id = ${companyId}::UUID AND id = ANY(${ids}::UUID[])
  `;
}
