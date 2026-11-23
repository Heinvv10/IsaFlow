/** Pure: how "Payments from your group" (P4-C) words an allocation message's state, its reasons and its mismatches. */
import type { AllocationItem, AllocationLiveReason, AllocationMismatch } from '@/modules/accounting/services/intercompany/allocationInboxTypes';

const STALE: Record<Exclude<AllocationLiveReason, 'ok' | 'check_failed'>, string> = {
  not_found: 'not found',
  not_pending: 'already handled',
  link_gone: 'the invoice link or the loan connection ended',
  before_cutover: 'the payment is dated before the cut-over',
  allocation_gone: 'the payment was unapplied',
  changed: 'the payment changed after it was sent',
  payment_not_posted: 'the payment is no longer posted',
  journal_reversed: 'the payment journal was reversed',
  bill_gone: 'the payer\'s bill was deleted',
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

export const STATE_CLASS: Record<AllocationState['tone'], string> = {
  live: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/30',
  stale: 'bg-slate-500/10 text-slate-600 dark:text-slate-300 border-slate-500/30',
  check: 'bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30',
};

export const HANDLED_LABEL: Record<AllocationItem['status'], string> = {
  pending: 'Waiting', failed: 'Needs attention', accepted: 'Accepted', rejected: 'Rejected', dismissed: 'Dismissed', withdrawn: 'Cancelled by sender',
};

export const isOpen = (i: AllocationItem): boolean => i.status === 'pending' || i.status === 'failed';

/** The payment as a person names it: its number, else its reference. */
export const paymentLabel = (i: AllocationItem): string => i.paymentNumber ?? i.paymentReference ?? 'payment';
