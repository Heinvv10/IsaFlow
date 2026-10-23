/**
 * Who changed the account money is paid FROM, recorded as an author of the payments in flight from it
 * (migration 923; Hein, 2026-10-23). The supplier_payment and payment_batch digests read the paying gl account's
 * bank_account_number and bank_branch_code LIVE (the EFT file's originator), so an edit of either stales every
 * approval of a draft or approved payment or batch paying from it — and, as for a payee's bank details
 * (./supplierPaymentAuthors), its editor joins their authors, append-only, so they cannot approve the re-submission.
 *
 * Lock order: batches (id order), then single payments (id order), then the account row (the caller's UPDATE) — the
 * order the batch paths take (batch -> members -> supplier -> gl_accounts, ./batchApprovedDigest.lockBatchPayees) and
 * processSupplierPayment takes (payment, then its journal's key share on the account). The caller holds the
 * company's role-write lock (bank-accounts PUT), which serialises every writer of these two columns.
 *
 * Named limit: only what pays from the account when the edit starts is stamped. A batch or payment pointed at the
 * account later is approved against the new number, as shown to its approver (expectedDigest); its editor is not
 * an author of it.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { STAMPED_BATCH_STATUSES } from './supplierPaymentAuthors';

export interface PaymentsFromAccount {
  batchIds: string[];
  paymentIds: string[];
  before: DbRow | null;
}

const originatorOf = async (companyId: string, accountId: string) => ((await sql`
  SELECT bank_account_number, bank_branch_code FROM gl_accounts
  WHERE id = ${accountId}::UUID AND company_id = ${companyId}::UUID
`) as DbRow[])[0] ?? null;

/** Lock the draft / approved batches and single payments paying from `accountId`, BEFORE the account row is written. */
export async function lockPaymentsFromAccount(companyId: string, accountId: string): Promise<PaymentsFromAccount> {
  const batches = (await sql`
    SELECT id FROM supplier_payment_batches
    WHERE company_id = ${companyId}::UUID AND bank_account_id = ${accountId}::UUID
      AND status = ANY(${[...STAMPED_BATCH_STATUSES]}::TEXT[])
    ORDER BY id FOR UPDATE
  `) as DbRow[];
  const payments = (await sql`
    SELECT id FROM supplier_payments
    WHERE company_id = ${companyId}::UUID AND bank_account_id = ${accountId}::UUID AND batch_id IS NULL
      AND status IN ('draft', 'approved')
    ORDER BY id FOR UPDATE
  `) as DbRow[];
  return {
    batchIds: batches.map((r) => String(r.id)),
    paymentIds: payments.map((r) => String(r.id)),
    before: await originatorOf(companyId, accountId),
  };
}

/**
 * After the account's UPDATE: when its number or branch code changed (raw, as the digest reads them), `userId`
 * joins the authors of every batch and payment `lockPaymentsFromAccount` locked. Not an UPDATE OF status, so the
 * 867 backstops do not fire.
 */
export async function recordPayingAccountEdit(companyId: string, accountId: string, userId: string,
  locked: PaymentsFromAccount): Promise<void> {
  const after = await originatorOf(companyId, accountId);
  if (!locked.before || !after) return;
  const same = (c: string) => (locked.before![c] ?? null) === (after[c] ?? null);
  if (same('bank_account_number') && same('bank_branch_code')) return;
  if (locked.batchIds.length > 0) {
    await sql`
      UPDATE supplier_payment_batches
      SET content_authors = approval_add_author(content_authors, ${userId}::UUID), content_edited_at = NOW()
      WHERE company_id = ${companyId}::UUID AND id = ANY(${locked.batchIds}::UUID[])
    `;
  }
  if (locked.paymentIds.length > 0) {
    await sql`
      UPDATE supplier_payments
      SET content_authors = approval_add_author(content_authors, ${userId}::UUID), content_edited_at = NOW()
      WHERE company_id = ${companyId}::UUID AND id = ANY(${locked.paymentIds}::UUID[])
    `;
  }
}
