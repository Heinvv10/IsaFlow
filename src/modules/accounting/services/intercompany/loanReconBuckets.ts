/**
 * The bucket and the contribution of ONE allocation message in the loan reconciliation (P5, plan sections (d), (l).1, (l).3, (l).4). Pure.
 *
 * The contribution is ONE formula for every bucket and both directions: contrib = -a x ([pc AND lc] - [rc]), where a = round(payload.amount,
 * 2), pc = the payer side stands (b2 'standing'), lc = the payer journal credits the payer side's current loan account, rc = the receiver's
 * clearing receipt stands and debits the receiver side's current loan account. The payer's loan line is a credit (-a), the receiver's a debit
 * (+a), and D = own_balance + partner_balance is the same sum whichever company is asking, so there is NO direction sign ((l).1). The bucket
 * only NAMES the message; the amount never depends on it, so no cell can fall through.
 *
 * The bucket is the first match of (l).4: withdrawn, loan_account_changed, anomaly, payer_timing, timing, then by (pc AND lc, rc). With the
 * partner withheld (b0 not ok) a partner-fact input is NULL: then there is no bucket and no contribution ((l).3), never a throw.
 */
import type { Bucket, MessageFacts } from './loanReconTypes';

/** Money as integer cents (2 dp first: a sub-cent payload is a mismatch, never dust). */
export function toCents(v: string | number | null | undefined): number {
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) || 0 : 0;
}

/** Whether every input the bucket needs is known (the partner's side is not withheld). */
function judged(f: MessageFacts): boolean {
  return f.payerState !== null && f.payerCounts !== null && f.payerLoanCredit !== null && f.payerAfterT !== null
    && f.receiverState !== null && f.receiverCounts !== null && f.receiverAfterT !== null && f.loanAccountChanged !== null;
}

/** contrib_m in cents, or null when the partner is withheld. */
export function contributionCents(f: MessageFacts): number | null {
  if (!judged(f)) return null;
  const a = toCents(f.amount);
  const payer = f.payerCounts && f.payerLoanCredit ? 1 : 0;
  const receiver = f.receiverCounts ? 1 : 0;
  return -a * (payer - receiver) || 0;
}

/** The (l).4 bucket, first match wins; null when the partner is withheld. */
export function bucketOf(f: MessageFacts): Bucket | null {
  if (!judged(f)) return null;
  const accepted = f.status === 'accepted';
  const rc = f.receiverCounts === true;
  if (f.status === 'withdrawn' || f.sourceCancelled) return 'withdrawn';
  // before anomaly: it forces lc / rc false, so an accepted message with a re-pointed payer account would otherwise read as one
  if (f.loanAccountChanged) return 'loan_account_changed';
  if ((rc && !accepted) || (accepted && rc && !f.payerLoanCredit)) return 'anomaly';
  if (f.payerAfterT) return 'payer_timing';
  if (f.receiverAfterT) return 'timing';
  const payer = f.payerCounts === true && f.payerLoanCredit === true;
  if (payer && rc) return 'matched';
  if (payer) {
    if (f.status === 'pending' || f.status === 'failed') return 'in_flight';
    if (f.status === 'rejected' || f.status === 'dismissed') return 'rejected_or_dismissed';
    return 'receiver_undone';
  }
  // rc here means accepted: (3) took every other status
  if (rc) return 'payer_undone';
  if (f.payerState === 'standing') return 'not_through_loan';
  return accepted ? 'both_undone' : 'not_live';
}

/** The three buckets of the "Accepted, then undone" list. */
export const UNDONE_BUCKETS: ReadonlySet<Bucket> = new Set(['payer_undone', 'receiver_undone', 'both_undone']);

/** The buckets that are listed under Needs attention (matched and in_flight are not: they are the normal course). */
export const ATTENTION_BUCKETS: ReadonlySet<Bucket> = new Set([
  'not_live', 'not_through_loan', 'rejected_or_dismissed', 'withdrawn', 'anomaly', 'loan_account_changed', 'timing', 'payer_timing',
]);

/** Rows that keep "Reconciles" off even at U = 0 ((l).6), with payer_journal_differs. */
export const BLOCKING_BUCKETS: ReadonlySet<Bucket> = new Set(['anomaly', 'loan_account_changed', 'withdrawn']);
