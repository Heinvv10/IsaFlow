/**
 * What the receiver's allocation list and detail show of the clearing (P4-D). READ ONLY.
 *   - `clearingPreview`: for an OPEN message's Accept dialog, the two legs (this company's loan account, its Accounts Receivable control), the
 *     amount, the invoice and the posting date proposed; the Accept request sends the loan account, invoice and amount back, and is refused if
 *     the books no longer say the same.
 *   - `clearingsOf`: for ACCEPTED messages, the contra receipt each posted and whether it was voided since (the receipt cancelled, or its
 *     journal reversed): read-only and computed, so a voided clearing is visible (nothing re-clears it; P5 will list them). Shown on the
 *     WIDE side (either one flags it), while the caps count a clearing until it is both (`intercompany_allocation_cleared`, 1027).
 */
import { sql } from '@/lib/neon';
import { getSystemAccount } from '../gl/systemAccountResolver';
import { MissingSystemAccountError } from '../gl/systemAccountKeys';
import type { AllocationPayload } from './mirrorPayload';
import type { AllocationIssuerInvoice } from './allocationInboxTypes';
import type { AllocationClearedBy, AllocationClearingPreview } from './allocationClearTypes';
import { defaultPostingDate, todaySast } from './allocationClearDate';

type Row = Record<string, unknown>;

async function receivableLabel(companyId: string): Promise<string | null> {
  try {
    const ar = await getSystemAccount('receivable', companyId);
    return `${ar.accountCode ?? ''} ${ar.accountName ?? ''}`.trim() || null;
  } catch (err) {
    if (err instanceof MissingSystemAccountError) return null;
    throw err;
  }
}

export async function clearingPreview(
  companyId: string, connectionId: string, payload: AllocationPayload | null, invoice: AllocationIssuerInvoice | null,
): Promise<AllocationClearingPreview> {
  const side = (await sql`
    SELECT s.loan_account_id, ga.account_code, ga.account_name
      FROM intercompany_connection_sides s
      LEFT JOIN gl_accounts ga ON ga.id = s.loan_account_id AND ga.company_id = ${companyId}::UUID
     WHERE s.connection_id = ${connectionId}::UUID AND s.company_id = ${companyId}::UUID
  `) as Row[];
  const loan = side[0]?.loan_account_id ? String(side[0].loan_account_id) : null;
  const paymentDate = payload?.payment.date ?? null;
  return {
    loanAccountId: loan,
    loanAccountLabel: loan ? `${String(side[0]!.account_code ?? '')} ${String(side[0]!.account_name ?? '')}`.trim() : null,
    receivableLabel: await receivableLabel(companyId),
    amount: payload?.amount ?? null,
    invoiceId: payload?.issuerDocument.id ?? null,
    invoiceNumber: invoice?.number ?? null,
    paymentDate,
    defaultPostingDate: paymentDate ? await defaultPostingDate(companyId, paymentDate, await todaySast()) : null,
  };
}

/** The clearing receipt of each accepted message (by its target), this company's only; voided when its journal no longer stands. */
export async function clearingsOf(companyId: string, paymentIds: string[]): Promise<Map<string, AllocationClearedBy>> {
  if (paymentIds.length === 0) return new Map();
  const rows = (await sql`
    SELECT p.id, p.payment_number, p.gl_journal_entry_id, p.status,
           EXISTS (SELECT 1 FROM gl_journal_entries r WHERE r.reversal_of_id = p.gl_journal_entry_id AND r.company_id = p.company_id AND r.status = 'posted') AS reversed
      FROM customer_payments p
     WHERE p.company_id = ${companyId}::UUID AND p.id = ANY(${paymentIds}::UUID[])
  `) as Row[];
  return new Map(rows.map((r) => [String(r.id).toLowerCase(), {
    paymentId: String(r.id), paymentNumber: r.payment_number ? String(r.payment_number) : null,
    journalEntryId: r.gl_journal_entry_id ? String(r.gl_journal_entry_id) : null,
    voided: r.reversed === true || String(r.status) === 'cancelled',
  }]));
}
