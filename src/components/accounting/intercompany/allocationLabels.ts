/** Pure: how "Payments from your group" (P4-C) words an allocation message's state, its reasons and its mismatches. */
import { formatCurrency } from '@/utils/formatters';
import { formatAmount } from '@/lib/money/formatMoney';
import type { AllocationItem, AllocationLiveReason, AllocationMismatch } from '@/modules/accounting/services/intercompany/allocationInboxTypes';

const STALE: Record<Exclude<AllocationLiveReason, 'ok' | 'check_failed'>, string> = {
  not_found: 'not found',
  not_pending: 'already handled',
  link_gone: 'the invoice link or the loan connection ended',
  before_cutover: 'no cut-over set or the payment is dated before it',
  allocation_gone: 'the payment was unapplied',
  changed: 'the payment changed after it was sent',
  payment_not_posted: 'the payment is no longer posted',
  journal_reversed: 'the payment journal was reversed',
  bill_gone: 'the payer\'s bill was deleted',
  future_dated: 'the payment is dated after today',
};

const MISMATCH: Record<AllocationMismatch, string> = {
  invoice_not_open: 'your invoice is not open',
  pre_cutover_payment: 'the payment is dated before the cut-over',
  amount_exceeds_open: 'more than the invoice\'s open amount',
  currency: 'not in rand, or not in the invoice\'s currency',
  invoice_gone: 'your invoice is gone',
  pre_cutover_invoice: 'your invoice is dated before the cut-over',
};

export const LINK_ORIGIN: Record<string, string> = { manual_pairing: 'Manual pairing', mirror: 'Mirrored invoice' };

export interface AllocationState { tone: 'live' | 'stale' | 'check'; text: string }

/** Live / Stale: <reason> / Check: <what does not fit>, for a message not yet handled. */
export function allocationState(i: AllocationItem): AllocationState {
  if (i.blocker) return { tone: 'check', text: `Check: ${i.blocker}` };
  if (i.liveReason === 'check_failed') return { tone: 'check', text: 'Check: could not be verified right now, reload to try again' };
  if (!i.live) return { tone: 'stale', text: `Stale: ${i.liveReason === 'ok' ? 'not confirmed' : STALE[i.liveReason]}` };
  if (i.mismatch) return { tone: 'check', text: `Check: ${MISMATCH[i.mismatch]}` };
  return { tone: 'live', text: 'Live' };
}

/** A mismatch the state chip does not already say (a message that is not live still shows what does not fit). A pre-cut-over payment is
 *  never live (the database answers before_cutover, or link_gone first), so its chip shows only beside another stale reason. */
export function extraMismatch(i: AllocationItem): string | null {
  if (!i.mismatch || allocationState(i).text === `Check: ${MISMATCH[i.mismatch]}`) return null;
  if (i.mismatch === 'pre_cutover_payment' && i.liveReason === 'before_cutover') return null;
  return `Check: ${MISMATCH[i.mismatch]}`;
}

/** An amount in its currency: rand as the app shows rand, anything else with its code ("USD 1 150.00"), never an R on a foreign figure. */
export const moneyIn = (amount: number | null | undefined, currency: string | null | undefined): string => {
  if (amount === null || amount === undefined) return '—';
  return !currency || currency === 'ZAR' ? formatCurrency(amount) : `${currency} ${formatAmount(amount)}`;
};

export const STATE_CLASS: Record<AllocationState['tone'], string> = {
  live: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/30',
  stale: 'bg-slate-500/10 text-slate-600 dark:text-slate-300 border-slate-500/30',
  check: 'bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30',
};

export const HANDLED_LABEL: Record<AllocationItem['status'], string> = {
  pending: 'Waiting', failed: 'Needs attention', accepted: 'Accepted', rejected: 'Rejected', dismissed: 'Dismissed', withdrawn: 'Cancelled by sender',
};

export const isOpen = (i: AllocationItem): boolean => i.status === 'pending' || i.status === 'failed';

/** P4-D: an accepted payment whose clearing receipt was voided since (read-only; nothing re-clears it). */
export const VOIDED_CHIP = 'Clearing voided';

/** The payment as a person names it: its number, else its reference. */
export const paymentLabel = (i: AllocationItem): string => i.paymentNumber ?? i.paymentReference ?? 'payment';

/** A row as buttons and notices name it: the payment and the invoice it pays ("payment SP-1 on INV-900"); without an invoice of this
 *  company, the payer's bill; without either, the message. */
export function rowLabel(i: AllocationItem): string {
  const on = i.issuerInvoice?.number ?? (i.payerDocumentNumber ? `bill ${i.payerDocumentNumber}` : null);
  return on ? `payment ${paymentLabel(i)} on ${on}` : `payment ${paymentLabel(i)} (message ${i.id.slice(0, 8)})`;
}

/** Every row's label, unique on the page: a repeated pair (a stale and a live message of one payment and invoice) gets "(1 of 2)". */
export function rowLabels(items: AllocationItem[]): Map<string, string> {
  const base = items.map(rowLabel);
  const total = new Map<string, number>();
  for (const b of base) total.set(b, (total.get(b) ?? 0) + 1);
  const seen = new Map<string, number>();
  return new Map(items.map((i, k) => {
    const b = base[k]!;
    const n = total.get(b)!;
    if (n === 1) return [i.id, b];
    seen.set(b, (seen.get(b) ?? 0) + 1);
    return [i.id, `${b} (${seen.get(b)} of ${n})`];
  }));
}
