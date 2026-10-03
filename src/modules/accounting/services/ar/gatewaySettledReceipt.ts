/**
 * The receipt a gateway settlement dedupes on (R-187).
 *
 * A live receipt for the reference, whoever wrote it: today's dedupe, unchanged. Failing that, a
 * CANCELLED receipt the gateway itself wrote: a person reversed that settlement, so a later report
 * must not bank it again. A cancelled receipt somebody else wrote (a manual receipt, a bank-feed
 * allocation, both free to carry the Paystack reference as `bank_reference`) says nothing about the
 * gateway's settlement and is ignored, so the first settlement still banks.
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

/** The live receipt for the reference, else a cancelled gateway-written one, else null. Tenant-scoped. */
export async function findSettledReceipt(companyId: string, reference: string): Promise<SettledReceipt | null> {
  const rows = await sql<SettledReceipt>`
    SELECT cp.id, cp.created_by::text AS created_by, cp.bank_account_id::text AS bank_account_id,
           cp.payment_date::text AS payment_date, cp.total_amount::text AS total_amount, cp.description, cp.status
    FROM customer_payments cp
    LEFT JOIN gl_journal_entries je ON je.id = cp.gl_journal_entry_id AND je.company_id = cp.company_id
    WHERE cp.company_id = ${companyId}::UUID
      AND cp.bank_reference = ${reference}
      AND (cp.status IS DISTINCT FROM 'cancelled' OR je.posting_agent = ${GATEWAY_RECEIPT_AGENT})
    ORDER BY (cp.status IS NOT DISTINCT FROM 'cancelled'), cp.id
    LIMIT 1
  `;
  return rows[0] ?? null;
}
