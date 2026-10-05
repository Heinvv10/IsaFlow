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
 */

import { sql } from '@/lib/neon';
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

/**
 * Whether a matched receipt is the settlement: confirmed or reconciled (a person applied it later),
 * never a draft (R-189). A NULL status (the column is nullable) is not a settlement either: it is
 * flagged under the draft reason, with its status in the detail.
 */
export const isSettlement = (status: string | null): boolean => status === 'confirmed' || status === 'reconciled';

/** The match, and a cancelled gateway-written receipt for the same reference beside it, if any. */
export interface SettledMatch extends SettledReceipt {
  cancelledGatewayReceiptId: string | null;
}

/** Settlements first, then any other live receipt (a draft), then a cancelled gateway one. */
const rank = (r: SettledReceipt): number => (isSettlement(r.status) ? 0 : r.status !== 'cancelled' ? 1 : 2);

/**
 * The receipt for the reference: a confirmed or reconciled one, else any other live one (a draft),
 * else a cancelled gateway-written one, else null; id breaks a tie. Tenant-scoped.
 */
export async function findSettledReceipt(companyId: string, reference: string): Promise<SettledMatch | null> {
  const rows = await sql<SettledReceipt>`
    SELECT cp.id, cp.created_by::text AS created_by, cp.bank_account_id::text AS bank_account_id,
           cp.payment_date::text AS payment_date, cp.total_amount::text AS total_amount, cp.description, cp.status
    FROM customer_payments cp
    LEFT JOIN gl_journal_entries je ON je.id = cp.gl_journal_entry_id AND je.company_id = cp.company_id
    WHERE cp.company_id = ${companyId}::UUID
      AND cp.bank_reference = ${reference}
      AND (cp.status IS DISTINCT FROM 'cancelled' OR je.posting_agent = ${GATEWAY_RECEIPT_AGENT})
    ORDER BY cp.id
  `;
  // Rows arrive in id order and the sort is stable, so id breaks a tie in rank.
  const top = [...rows].sort((a, b) => rank(a) - rank(b))[0];
  if (!top) return null;
  const cancelled = rows.find((r) => r !== top && r.status === 'cancelled');
  return { ...top, cancelledGatewayReceiptId: cancelled?.id ?? null };
}
