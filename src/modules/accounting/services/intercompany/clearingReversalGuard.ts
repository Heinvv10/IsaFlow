/**
 * Intercompany P4-D round 2 (A2): the journal of a receipt that CLEARS an accepted allocation message (the contra receipt
 * `allocationClearService` posted) is undone only by cancelling that receipt (`cancelCustomerPaymentInner`, which reverses it once, rolls the
 * invoice back and leaves the message accepted with its clearing voided). A journal reversal of it, or of its reversal (a reversal of the
 * reversal would make a voided clearing stand again behind the caps' back), is refused. Called by `reverseJournalEntry` for every entry it
 * reverses, under its reversal claim, before any write; the receipt's own cancel names itself (`voidingReceiptId`).
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { findJournalChainRoot } from '../shared/journalChainHead';
import { ReceiptRefusal } from '../ar/receiptRefusal';

/** A UUID as one spelling (lower case, no braces, trimmed), so a receipt id named in any case or with braces compares equal (round 3, H). */
const canonicalUuid = (s: string): string => s.trim().replace(/^\{|\}$/g, '').toLowerCase();

export async function refuseReversingIntercompanyClearing(
  companyId: string, entry: { id: string; entryNumber: string }, voidingReceiptId?: string,
): Promise<void> {
  // (round 3, D) the cheap question first: a company that holds no accepted clearing walks no chain (every journal reversal passes here)
  const any = (await sql`
    SELECT 1 AS one FROM intercompany_messages
     WHERE to_company_id = ${companyId}::UUID AND kind = 'allocation' AND status = 'accepted' AND target_doc_type = 'customer_payment'
     LIMIT 1
  `) as DbRow[];
  if (any.length === 0) return;
  // the entry or any entry it reverses: the chain's root is the receipt's journal
  const root = (await findJournalChainRoot(companyId, entry.id)) ?? entry.id;
  const [row] = (await sql`
    SELECT p.id, p.payment_number
      FROM customer_payments p
      JOIN intercompany_messages m ON m.target_doc_id = p.id AND m.to_company_id = p.company_id AND m.kind = 'allocation'
       AND m.status = 'accepted' AND m.target_doc_type = 'customer_payment'
     WHERE p.company_id = ${companyId}::UUID AND p.gl_journal_entry_id = ${root}::UUID
     LIMIT 1
  `) as DbRow[];
  if (!row) return;
  if (entry.id === root && voidingReceiptId !== undefined && canonicalUuid(voidingReceiptId) === canonicalUuid(String(row.id))) return;
  throw new ReceiptRefusal(
    `Journal entry ${entry.entryNumber} clears an intercompany payment from your group (receipt ${String(row.payment_number)}). `
    + 'Undo it by cancelling that receipt, which reverses it once; a journal reversal of it, or of its reversal, is refused.',
  );
}
