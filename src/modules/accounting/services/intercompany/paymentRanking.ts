/**
 * Match suggestions for a `payment` message (F), PURE: the receiver's OWN rows (read by paymentSuggestions.ts under its RLS) ranked against the
 * payload only (amount, date, reference text). Nothing about the payer is read here or anywhere in the suggestions; nothing is stored.
 *   invoices    the linked issuer invoice first (always offered when open: F sends linked bills only), then the customer's other open invoices,
 *               oldest first, ties by id
 *   receipts    the MED-2 candidates (the reads apply the set), by the bank matcher's own scores (amount, date, description), ties by date, id
 *   bank lines  a HINT only (no action anywhere): R's unmatched incoming lines, the same scores
 * The draft is refused while a candidate holds an allocation on the linked invoice or its remainder is exactly the amount (Q2 / MED-2), judged
 * over the full candidate set (round 1 B3).
 */
import { scoreAmount, scoreDate, scoreDescription } from '../bank/bankMatchCandidatesService';
import type { BankLineHint, InvoiceSuggestion, ReceiptSuggestion } from './paymentInboxTypes';

export interface RankPayload { amount: number; date: string; reference: string | null; number: string | null }
export interface InvoiceRow { id: string; number: string; date: string | null; openAmount: number }
export interface ReceiptRow {
  id: string; number: string; date: string; total: number;
  /** what its allocation rows already take */
  allocated: number;
  /** what accepted payment messages already took of it (consumption) */
  consumed: number;
  onLinkedInvoice: boolean;
  /** its bank reference and description, for the description score */
  text: string;
}
export interface BankLineRow { id: string; date: string; amount: number; description: string }

const cents = (n: number): number => Math.round(n * 100);
const words = (p: RankPayload): string => [p.reference ?? '', p.number ?? ''].join(' ');
const byIdAsc = (a: { id: string }, b: { id: string }): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function orderInvoices(linkedId: string, rows: readonly InvoiceRow[]): InvoiceSuggestion[] {
  const linked = linkedId.toLowerCase();
  return [...rows]
    .map((r) => ({ ...r, linked: r.id.toLowerCase() === linked }))
    .sort((a, b) => (a.linked !== b.linked ? (a.linked ? -1 : 1)
      : (a.date ?? '') !== (b.date ?? '') ? ((a.date ?? '') < (b.date ?? '') ? -1 : 1) : byIdAsc(a, b)));
}

export function rankReceipts(p: RankPayload, rows: readonly ReceiptRow[]): ReceiptSuggestion[] {
  return rows.map((r) => {
    const unallocated = (cents(r.total) - cents(r.allocated)) / 100;
    const unconsumed = (cents(r.total) - cents(r.consumed)) / 100;
    const basis = Math.min(unallocated, unconsumed);
    return {
      id: r.id, number: r.number, date: r.date, total: r.total, unallocated, unconsumed,
      // the remainder is what is left both unallocated and unconsumed: a draft is refused while it is exactly the amount
      exact: cents(basis) === cents(p.amount),
      onLinkedInvoice: r.onLinkedInvoice,
      score: scoreAmount(p.amount, basis) + scoreDate(p.date, r.date) + scoreDescription(words(p), r.text) + (r.onLinkedInvoice ? 10 : 0),
    };
  }).sort((a, b) => b.score - a.score || (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) || byIdAsc(a, b));
}

export function rankBankLines(p: RankPayload, lines: readonly BankLineRow[]): BankLineHint[] {
  return lines.map((l) => ({
    id: l.id, date: l.date, amount: l.amount, description: l.description,
    score: scoreAmount(p.amount, l.amount) + scoreDate(p.date, l.date) + scoreDescription(words(p), l.description),
  })).sort((a, b) => b.score - a.score || (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) || byIdAsc(a, b));
}

export type DraftBlock = 'exact_receipt' | 'linked_receipt';

/** Why `draft` is refused for the candidate set, or null. Round 1 (B3): over the FULL set (paymentSuggestions counts it in SQL), never the listed page. */
export function draftRefusal(set: { anyExact: boolean; anyLinked: boolean }): DraftBlock | null {
  if (set.anyExact) return 'exact_receipt';
  if (set.anyLinked) return 'linked_receipt';
  return null;
}
