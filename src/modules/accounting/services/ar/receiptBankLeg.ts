/**
 * The receipt twin of `ap/paymentJournalReversal.lockPaymentBankLeg` (D8 round 6, brk-d8b): receipt cancel
 * never touched bank lines, so the statement line of a bank-allocated (or matched) receipt stayed
 * 'allocated' / 'matched' against a journal the cancel took out of the ledger. Cancel now locks the
 * receipt journal's bank lines FIRST — the canonical order (bank line → payment → invoices → journal) — and
 * frees them the way the AP void does: an allocated line through `voidViaBankAllocation`, a matched one
 * through `lockJournalAndUnmatch`. Reconciled cash refuses the cancel before any write.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { lockBankLegOf, type BankLeg } from '../ap/paymentJournalReversal';

/** From an UNLOCKED peek of the receipt: lock its journal's bank leg. The caller re-checks the journal under its own lock. */
export async function lockReceiptBankLeg(
  companyId: string, paymentId: string,
): Promise<{ journalId: string | null; leg: BankLeg | null }> {
  const [p] = (await sql`
    SELECT payment_number, status, gl_journal_entry_id FROM customer_payments
    WHERE id = ${paymentId}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  if (!p || p.status !== 'confirmed' || !p.gl_journal_entry_id) return { journalId: null, leg: null };
  const journalId = String(p.gl_journal_entry_id);
  return { journalId, leg: await lockBankLegOf(companyId, journalId, `Receipt ${String(p.payment_number ?? paymentId)}`) };
}
