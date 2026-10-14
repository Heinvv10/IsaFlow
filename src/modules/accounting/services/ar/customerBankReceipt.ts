/**
 * The `customer_payments` row a bank allocation writes for money IN from a
 * customer — a whole line (`allocateTransaction`) or one line of a split
 * (`bankSplitContacts`). One INSERT, so the two cannot drift.
 *
 * `q` is the caller's tag: `allocateTransaction` writes it inside its
 * `withTransaction` block, the split inside the request transaction.
 * `createdBy` is a uuid (created_by / confirmed_by are uuid-typed, NOT NULL).
 */
import type { DbRow, TxSql } from '@/lib/neon';

export async function insertCustomerBankReceipt(q: TxSql, r: {
  companyId: string; customerId: string; paymentDate: string; amount: number;
  bankReference: string | null; bankAccountId: string; description: string;
  journalEntryId: string; createdBy: string;
}): Promise<string | null> {
  const rows = (await q`
    INSERT INTO customer_payments (
      company_id, client_id, payment_date, total_amount, payment_method,
      bank_reference, bank_account_id, description, status,
      gl_journal_entry_id, created_by, confirmed_by, confirmed_at
    ) VALUES (
      ${r.companyId}::UUID, ${r.customerId}::UUID, ${r.paymentDate}, ${r.amount}, 'eft',
      ${r.bankReference}, ${r.bankAccountId}::UUID, ${r.description}, 'confirmed',
      ${r.journalEntryId}::UUID, ${r.createdBy}::UUID, ${r.createdBy}::UUID, NOW()
    )
    RETURNING id`) as DbRow[];
  return rows.length > 0 ? String(rows[0]!.id) : null;
}
