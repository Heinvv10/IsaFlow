/**
 * The receipt a gateway settlement dedupes on (R-187).
 *
 * A live receipt for the reference, whoever wrote it, a confirmed or reconciled one first. Only a
 * confirmed or reconciled receipt is the settlement (`isSettlement`). A DRAFT holding the reference
 * (a person recorded it by hand and never confirmed it) is not: the gateway banks nothing, posts no
 * fee and flags it `draft_receipt_holds_reference`, and the draft is left for a person (R-189, Hein
 * 2026-10-05). Failing a live one, a CANCELLED receipt the gateway itself wrote: that settlement was undone, so a later report must not
 * bank it again; it is flagged `already_settled_cancelled_receipt` for a person instead. The cancel
 * is not always a person's decision about this receipt: besides `cancelCustomerPayment`, it is
 * cancelled as a side effect when the bank line matched to its journal is reversed
 * (`reverseReconciledTransaction`, or the auto-post undo, both through
 * `unwindBankAllocationApplication`), and by an agent through MCP `void_receipt`
 * (`unwindOnePayment`). Whoever handles the flag should check which it was. A cancelled receipt
 * somebody else wrote (a manual receipt, a bank-feed allocation, both free to carry the Paystack
 * reference as `bank_reference`) says nothing about the gateway's settlement and is ignored, so the
 * first settlement still banks.
 *
 * "The gateway wrote it" is read from the receipt's journal: `customer_payments.gl_journal_entry_id`
 * -> `gl_journal_entries.posting_agent = GATEWAY_RECEIPT_AGENT`. Every gateway receipt has carried
 * that stamp since it was first written (3f1ef0a8d), and it survives a cancel: cancel reverses the
 * journal with a NEW entry and leaves the original row, its agent and the receipt's link to it as
 * they were; no code path clears `gl_journal_entry_id` or rewrites `posting_agent`, and the FK stops
 * the journal being deleted while the receipt points at it. The receipt's own columns carry no
 * such marker (`description` is free text a person can type).
 *
 * The read LOCKS every receipt it matches (R-193), `FOR UPDATE OF cp` in id order, under the 5 s
 * row-lock budget. Unlocked, a replay could read a gateway receipt live while a cancel of it was
 * committing, then post the fee leg against the cancelled receipt with no flag. Locked, a cancel
 * that holds the receipt makes the replay wait, and the replay re-reads it cancelled (the R-187
 * branch); a replay that holds it first makes the cancel wait, and the cancel then follows the fee.
 * A wait past the budget is `RowLockTimeoutError`: the webhook answers 500 and Paystack redelivers;
 * verify answers `pending`. The lock is taken BEFORE the payment link is spent, so a settlement takes
 * receipt -> link as `customerMergeService` takes receipts -> invoices -> link (see ar/.claude.md).
 */

import { sql } from '@/lib/neon';
import { RowLockTimeoutError, withRowLockBudget } from '../core/rowLockBudget';
import { GATEWAY_RECEIPT_AGENT } from './gatewayInvoiceReceiptService';

export interface SettledReceipt {
  id: string;
  created_by: string;
  bank_account_id: string | null;
  payment_date: string;
  total_amount: string;
  description: string | null;
  status: string | null;
}

/** Whether a matched receipt is the settlement: confirmed or reconciled, never a draft (R-189). */
export const isSettlement = (status: string | null): boolean => status === 'confirmed' || status === 'reconciled';

/** Settlements first, then any other live receipt (a draft), then a cancelled gateway one. */
const rank = (r: SettledReceipt): number => (isSettlement(r.status) ? 0 : r.status !== 'cancelled' ? 1 : 2);

/**
 * The receipt for the reference: a confirmed or reconciled one, else any other live one (a draft),
 * else a cancelled gateway-written one, else null. Every match stays locked until the caller's
 * transaction ends (R-193). Tenant-scoped.
 */
export async function findSettledReceipt(companyId: string, reference: string): Promise<SettledReceipt | null> {
  const rows = await withRowLockBudget(() => sql<SettledReceipt>`
    SELECT cp.id, cp.created_by::text AS created_by, cp.bank_account_id::text AS bank_account_id,
           cp.payment_date::text AS payment_date, cp.total_amount::text AS total_amount, cp.description, cp.status
    FROM customer_payments cp
    LEFT JOIN gl_journal_entries je ON je.id = cp.gl_journal_entry_id AND je.company_id = cp.company_id
    WHERE cp.company_id = ${companyId}::UUID
      AND cp.bank_reference = ${reference}
      AND (cp.status IS DISTINCT FROM 'cancelled' OR je.posting_agent = ${GATEWAY_RECEIPT_AGENT})
    ORDER BY cp.id
    FOR UPDATE OF cp
  `, () => new RowLockTimeoutError(`The receipt for payment ${reference}`));
  // Rows arrive in id order and the sort is stable, so id breaks a tie in rank.
  return [...rows].sort((a, b) => rank(a) - rank(b))[0] ?? null;
}
