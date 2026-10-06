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
 * They also become the supplier's `bank_details_set_by` (decision (b)), which
 * the authors function derives into payments created AFTER the edit. Paid
 * payments are history and are left alone. Creating a payment stamps nothing
 * (its creator is created_by).
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

/**
 * True when a supplier UPDATE moved the bank details it writes. The UPDATE
 * returns them twice, as `bank_after` (RETURNING jsonb_build_array(...)) and
 * as `bank_before` — a RETURNING subquery on the same row, which runs with the
 * statement's snapshot and so reads the row as it stood before the UPDATE (one
 * statement: no separate read to race, and no extra query). A concurrent edit
 * the UPDATE waited for can make `bank_before` the pre-concurrent value: the
 * comparison then errs toward a stamp, or misses only an edit that restored
 * the details every earlier approval was given for.
 */
export function bankDetailsMoved(row: DbRow): boolean {
  return row.bank_before != null && JSON.stringify(row.bank_before) !== JSON.stringify(row.bank_after);
}

/** True when the supplier row carries any bank detail (a create that sets where money goes). */
export function hasBankDetails(row: DbRow): boolean {
  return [row.bank_name, row.bank_account_number, row.bank_branch_code, row.bank_account_type]
    .some((v) => v != null && v !== '');
}

/**
 * `userId` set the supplier's bank details (decision (b), 2026-10-06): record
 * them as its `bank_details_set_by` — derived LIVE into the authors of every
 * payment to it, including payments created later — and stamp them onto every
 * draft or approved payment to the supplier and every draft or approved batch
 * carrying one, append-only, so a later setter cannot strip them from a payment
 * already in flight. Not an UPDATE OF status, so the 867 backstop does not
 * fire. Called only for a write that changed (or created) bank details: any
 * other supplier write never references the column.
 */
export async function recordBankDetailsSetter(companyId: string, supplierId: string, userId: string): Promise<void> {
  await sql`
    UPDATE suppliers SET bank_details_set_by = ${userId}::UUID
    WHERE id = ${supplierId}::UUID AND company_id = ${companyId}::UUID
  `;
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
