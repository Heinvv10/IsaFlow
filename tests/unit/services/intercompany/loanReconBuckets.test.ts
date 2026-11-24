/**
 * Intercompany P5, the (l).4 precedence table: EVERY cell of (status x source_cancelled_at x payer_state x pc x lc x rc x loan_account_changed
 * x payer_after_t x receiver_after_t x receiver_state x direction) falls in exactly one bucket, the first rule that matches, and its amount is
 * always the one contribution formula -a x ([pc AND lc] - [rc]) ((l).1): the same for `in` and `out`, whatever the bucket. The NULL cells
 * ((l).3): any partner-fact input NULL (the partner withheld) gives no bucket and no contribution, never a throw. The pinned cells are the
 * corrected labels (l).4 names.
 */
import { describe, expect, it } from 'vitest';
import { bucketOf, contributionCents } from '@/modules/accounting/services/intercompany/loanReconBuckets';
import {
  BUCKETS, MESSAGE_STATUSES, PAYER_STATES, RECEIVER_STATES, type Bucket, type MessageFacts,
} from '@/modules/accounting/services/intercompany/loanReconTypes';

const base: MessageFacts = {
  status: 'pending', sourceCancelled: false, direction: 'out', amount: 123.45, payerState: 'standing', payerCounts: true, payerLoanCredit: true,
  payerAfterT: false, payerJournalDiffers: false, receiverState: 'not_accepted', receiverCounts: false, receiverAfterT: false,
  loanAccountChanged: false, partnerDocument: 'open',
};
const f = (over: Partial<MessageFacts>): MessageFacts => ({ ...base, ...over });

/** The table of (l).4 written as data, read top to bottom: the oracle the implementation is held to. */
const RULES: [Bucket, (x: MessageFacts) => boolean][] = [
  ['withdrawn', (x) => x.status === 'withdrawn' || x.sourceCancelled],
  ['loan_account_changed', (x) => x.loanAccountChanged === true],
  ['anomaly', (x) => (x.receiverCounts === true && x.status !== 'accepted') || (x.status === 'accepted' && x.receiverCounts === true && x.payerLoanCredit !== true)],
  ['payer_timing', (x) => x.payerAfterT === true],
  ['timing', (x) => x.receiverAfterT === true],
  ['matched', (x) => !!(x.payerCounts && x.payerLoanCredit) && x.receiverCounts === true],
  ['in_flight', (x) => !!(x.payerCounts && x.payerLoanCredit) && !x.receiverCounts && (x.status === 'pending' || x.status === 'failed')],
  ['rejected_or_dismissed', (x) => !!(x.payerCounts && x.payerLoanCredit) && !x.receiverCounts && (x.status === 'rejected' || x.status === 'dismissed')],
  ['receiver_undone', (x) => !!(x.payerCounts && x.payerLoanCredit) && !x.receiverCounts && x.status === 'accepted'],
  ['payer_undone', (x) => !(x.payerCounts && x.payerLoanCredit) && x.receiverCounts === true && x.status === 'accepted'],
  ['not_through_loan', (x) => !(x.payerCounts && x.payerLoanCredit) && !x.receiverCounts && x.payerState === 'standing'],
  ['both_undone', (x) => !(x.payerCounts && x.payerLoanCredit) && !x.receiverCounts && x.status === 'accepted'],
  ['not_live', (x) => !(x.payerCounts && x.payerLoanCredit) && !x.receiverCounts],
];
const oracle = (x: MessageFacts): Bucket[] => {
  const first = RULES.find(([, p]) => p(x));
  return first ? [first[0]] : [];
};
const formula = (x: MessageFacts) => -Math.round((x.amount ?? 0) * 100) * (Number(!!(x.payerCounts && x.payerLoanCredit)) - Number(!!x.receiverCounts));

function* cells(): Generator<MessageFacts> {
  const bools = [false, true];
  for (const status of MESSAGE_STATUSES) for (const sourceCancelled of bools) for (const payerState of PAYER_STATES)
    for (const payerCounts of bools) for (const payerLoanCredit of bools) for (const receiverCounts of bools) for (const loanAccountChanged of bools)
      for (const payerAfterT of bools) for (const receiverAfterT of bools) for (const receiverState of RECEIVER_STATES) for (const direction of ['out', 'in'] as const) {
        yield f({ status, sourceCancelled, payerState, payerCounts, payerLoanCredit, receiverCounts, loanAccountChanged, payerAfterT, receiverAfterT, receiverState, direction });
      }
}

describe('the precedence table over every cell', () => {
  it('each cell has exactly one bucket, the first rule that matches; its amount is the formula, the same for in and out', () => {
    let n = 0;
    const seen = new Set<Bucket>();
    for (const x of cells()) {
      n += 1;
      const b = bucketOf(x);
      const want = oracle(x);
      if (want.length !== 1 || b !== want[0]) throw new Error(`cell ${JSON.stringify(x)}: got ${b}, the table says ${want.join(',') || 'nothing'}`);
      seen.add(b);
      const c = contributionCents(x);
      if (c !== formula(x)) throw new Error(`cell ${JSON.stringify(x)}: contribution ${c}, the formula says ${formula(x)}`);
      const other = contributionCents({ ...x, direction: x.direction === 'out' ? 'in' : 'out' });
      if (other !== c) throw new Error(`cell ${JSON.stringify(x)}: the direction changed the amount (${c} vs ${other})`);
      if (bucketOf({ ...x, direction: x.direction === 'out' ? 'in' : 'out' }) !== b) throw new Error(`cell ${JSON.stringify(x)}: the direction changed the bucket`);
    }
    expect(n).toBe(6 * 2 * 7 * 2 ** 6 * 5 * 2);
    expect([...seen].sort()).toEqual([...BUCKETS].sort());
  });

  it('the bucket never moves the amount: a message contributes the same whatever names it', () => {
    // a withdrawn, a re-pointed loan account and an anomaly still carry the formula (the bucket only names it)
    expect(contributionCents(f({ status: 'withdrawn', payerCounts: true, payerLoanCredit: true, receiverCounts: false }))).toBe(-12345);
    expect(contributionCents(f({ loanAccountChanged: true, payerCounts: true, payerLoanCredit: false, receiverCounts: true, status: 'accepted' }))).toBe(12345);
    expect(contributionCents(f({ status: 'pending', receiverCounts: true, payerCounts: true, payerLoanCredit: true }))).toBe(0);
  });
});

describe('the corrected labels of (l).4', () => {
  it.each<[string, Partial<MessageFacts>, Bucket, number]>([
    ['accepted, target missing = receiver_undone (was timing)', { status: 'accepted', receiverState: 'target_missing', receiverCounts: false }, 'receiver_undone', -12345],
    ['accepted, payer standing, no loan credit, no rc = not_through_loan (was both_undone)',
      { status: 'accepted', payerLoanCredit: false, receiverCounts: false, receiverState: 'clearing_voided' }, 'not_through_loan', 0],
    ['pending, payer journal dated after T = payer_timing (was not_live)',
      { status: 'pending', payerState: 'dated_after', payerCounts: false, payerAfterT: true }, 'payer_timing', 0],
    ['a re-pointed payer account on an accepted message is loan_account_changed, not anomaly',
      { status: 'accepted', loanAccountChanged: true, payerLoanCredit: false, receiverCounts: true, receiverState: 'clearing_standing' }, 'loan_account_changed', 12345],
    ['accepted, both stand = matched', { status: 'accepted', receiverCounts: true, receiverState: 'clearing_standing' }, 'matched', 0],
    ['pending, payer cleared = in_flight', {}, 'in_flight', -12345],
    ['failed, payer cleared = in_flight', { status: 'failed' }, 'in_flight', -12345],
    ['rejected while the loan credit stands', { status: 'rejected' }, 'rejected_or_dismissed', -12345],
    ['dismissed while the loan credit stands', { status: 'dismissed' }, 'rejected_or_dismissed', -12345],
    ['accepted, payer voided before the undo gate = payer_undone',
      { status: 'accepted', payerState: 'payment_not_posted', payerCounts: false, receiverCounts: true, receiverState: 'clearing_standing' }, 'payer_undone', 12345],
    ['accepted, both undone', { status: 'accepted', payerState: 'journal_reversed', payerCounts: false, receiverState: 'clearing_voided' }, 'both_undone', 0],
    ['pending, payer voided = not_live', { payerState: 'journal_reversed', payerCounts: false }, 'not_live', 0],
    ['bank-paid pending = not_through_loan', { payerLoanCredit: false }, 'not_through_loan', 0],
    ['source_cancelled_at on a pending message = withdrawn', { sourceCancelled: true }, 'withdrawn', -12345],
    ['rc while pending = anomaly', { receiverCounts: true }, 'anomaly', 0],
    ['accepted, rc without the payer loan credit = anomaly', { status: 'accepted', receiverCounts: true, payerLoanCredit: false }, 'anomaly', 12345],
    ['accepted, receipt chain dated after T = timing', { status: 'accepted', receiverAfterT: true, receiverCounts: true }, 'timing', 0],
    ['accepted, payer reversal dated after T: payer still counts = payer_timing, 0',
      { status: 'accepted', payerAfterT: true, receiverCounts: true, receiverState: 'clearing_standing' }, 'payer_timing', 0],
  ])('%s', (_name, over, bucket, cents) => {
    expect(bucketOf(f(over))).toBe(bucket);
    expect(contributionCents(f(over))).toBe(cents);
  });
});

describe('the NULL cells: the partner withheld', () => {
  const partnerFacts = ['payerState', 'payerCounts', 'payerLoanCredit', 'payerAfterT', 'receiverState', 'receiverCounts', 'receiverAfterT', 'loanAccountChanged'] as const;
  it.each(partnerFacts)('%s NULL: no bucket, no contribution, no throw', (key) => {
    for (const status of MESSAGE_STATUSES) for (const direction of ['out', 'in'] as const) {
      const x = f({ status, direction, [key]: null });
      expect(bucketOf(x)).toBeNull();
      expect(contributionCents(x)).toBeNull();
    }
  });
  it('every partner fact NULL at once (an in message from a withheld payer): null, null', () => {
    const x = f({ direction: 'in', payerState: null, payerCounts: null, payerLoanCredit: null, payerAfterT: null, payerJournalDiffers: null, loanAccountChanged: null });
    expect(bucketOf(x)).toBeNull();
    expect(contributionCents(x)).toBeNull();
  });
  it('a payload without a number contributes 0, never NaN', () => {
    expect(contributionCents(f({ amount: null }))).toBe(0);
    expect(contributionCents(f({ amount: null, receiverCounts: true, status: 'accepted' }))).toBe(0);
  });
});
