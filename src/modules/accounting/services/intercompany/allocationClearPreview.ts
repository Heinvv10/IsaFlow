/**
 * What the receiver's allocation list and detail show of the clearing (P4-D). READ ONLY.
 *   - `clearingPreview`: for an OPEN message's Accept dialog, the two legs (this company's loan account, its Accounts Receivable control), the
 *     amount, the invoice and the posting date proposed; the Accept request sends the loan account, invoice and amount back, and is refused if
 *     the books no longer say the same.
 *   - `clearingsOf`: for ACCEPTED messages, the contra receipt each posted and whether it was voided since: the light definer's
 *     `clearing_voided`, the receipt's journal chain judged by value exactly as the caps judge it (a reversal of the reversal stands again).
 *     Read-only, so a voided clearing is visible (nothing re-clears it; P5 will list them).
 */
import { sql, withSavepoint } from '@/lib/neon';
import { log } from '@/lib/logger';
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
  const invoiceDate = invoice?.date ?? null;
  // (M1) the floor is the later of the two: a clearing is never dated before the invoice it settles
  const floor = paymentDate && invoiceDate && invoiceDate > paymentDate ? invoiceDate : paymentDate;
  return {
    loanAccountId: loan,
    loanAccountLabel: loan ? `${String(side[0]!.account_code ?? '')} ${String(side[0]!.account_name ?? '')}`.trim() : null,
    receivableLabel: await receivableLabel(companyId),
    amount: payload?.amount ?? null,
    invoiceId: payload?.issuerDocument.id ?? null,
    invoiceNumber: invoice?.number ?? null,
    paymentDate,
    invoiceDate,
    defaultPostingDate: floor ? await defaultPostingDate(companyId, floor, await todaySast()) : null,
  };
}

/**
 * The clearing receipt of each accepted message (`targets`: message id -> receipt id), this company's only; `voided` is the light definer's
 * `clearing_voided` (the receipt's journal chain even: exactly the rule the caps count by, L5), asked once per accepted message.
 */
export async function clearingsOf(companyId: string, targets: Map<string, string>): Promise<Map<string, AllocationClearedBy>> {
  if (targets.size === 0) return new Map();
  const rows = (await sql`
    SELECT p.id, p.payment_number, p.gl_journal_entry_id
      FROM customer_payments p
     WHERE p.company_id = ${companyId}::UUID AND p.id = ANY(${[...targets.values()]}::UUID[])
  `) as Row[];
  const receipts = new Map(rows.map((r) => [String(r.id).toLowerCase(), r]));
  const out = new Map<string, AllocationClearedBy>();
  for (const [messageId, paymentId] of targets) {
    const r = receipts.get(paymentId.toLowerCase());
    if (!r) continue;
    // (round 3, E) one check per row, in a savepoint of its own: a check that fails leaves that row unflagged (logged), never the page a 500
    let voided = false;
    try {
      const rows2 = (await withSavepoint('ic_clearing_voided', async () => (await sql`
        SELECT clearing_voided FROM public.intercompany_allocation_message_live(${messageId}::UUID)
      `) as Row[])) as Row[];
      voided = rows2[0]?.clearing_voided === true;
    } catch (err) {
      log.warn('Intercompany clearing voided check failed', { companyId, messageId, code: (err as { code?: string } | null)?.code ?? null }, 'intercompany');
    }
    out.set(messageId, {
      paymentId: String(r.id), paymentNumber: r.payment_number ? String(r.payment_number) : null,
      journalEntryId: r.gl_journal_entry_id ? String(r.gl_journal_entry_id) : null,
      voided,
    });
  }
  return out;
}
