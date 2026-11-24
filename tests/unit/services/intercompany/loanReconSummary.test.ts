/**
 * Intercompany P5, the arithmetic of the summary ((d), (k).4, (l).1, (l).3, (l).6) in integer cents: I1 (balance = attributed + other), the
 * contribution with NO direction sign, the residuals, Unexplained U = own_other + partner_other + residual_S + residual_X, the I2 code
 * assertion D = sum(contrib) + U (arithmetic given I1: a check of this code's sums, no safety net; a throw only when the caller asks for
 * strict), and the badge: "Reconciles" only when residual_S = 0 AND residual_X = 0 AND D = sum(contrib) (so the hand postings, own_other +
 * partner_other, net to 0: U = 0) AND no anomaly / loan_account_changed / withdrawn row AND no payer / receiver journal that differs. Mirrored
 * hand-posted openings are the normal case: they reconcile (the card notes them); residuals that cancel never do. The worked example from BOTH
 * sessions gives the same D, contributions and U and reconciles, with its hand-posted openings and without them; its two variants never
 * reconcile. The partner withheld: null figures, no throw.
 */
import { describe, expect, it } from 'vitest';
import { summarize, LoanReconIdentityError } from '@/modules/accounting/services/intercompany/loanReconSummary';
import type { MessageFacts, SummaryRow } from '@/modules/accounting/services/intercompany/loanReconTypes';

const stand = { payerState: 'standing' as const, payerCounts: true, payerLoanCredit: true, payerAfterT: false, payerJournalDiffers: false };
const notAcc = { receiverState: 'not_accepted' as const, receiverCounts: false, receiverAfterT: false };
const rcv = { receiverState: 'clearing_standing' as const, receiverCounts: true, receiverAfterT: false };
const m = (amount: number, over: Partial<MessageFacts>, direction: 'out' | 'in' = 'out'): MessageFacts => ({
  status: 'pending', sourceCancelled: false, direction, amount, ...stand, ...notAcc, receiverJournalDiffers: false, loanAccountChanged: false,
  partnerDocument: 'open', ...over,
});

/** The worked example (d): m1-m5, S = the payer of all five. */
const example = (direction: 'out' | 'in'): MessageFacts[] => [
  m(10000, { status: 'accepted', ...rcv }, direction),
  m(2500, {}, direction),
  m(1200, { status: 'accepted', receiverState: 'clearing_voided', receiverCounts: false }, direction),
  m(800, { status: 'accepted', payerState: 'payment_not_posted', payerCounts: false, ...rcv }, direction),
  m(300, { payerLoanCredit: false }, direction),
];
const sRow = (over: Partial<SummaryRow> = {}): SummaryRow => ({
  partner_state: 'ok', as_of: '2026-11-30', own_balance: '-63700.00', own_attributed: '-13700.00', own_other: '-50000.00', own_loan_shared: false,
  partner_balance: '60800.00', partner_other: '50000.00', ...over,
});
const xRow = (over: Partial<SummaryRow> = {}): SummaryRow => ({
  partner_state: 'ok', as_of: '2026-11-30', own_balance: '60800.00', own_attributed: '10800.00', own_other: '50000.00', own_loan_shared: false,
  partner_balance: '-63700.00', partner_other: '-50000.00', ...over,
});

describe('the worked example', () => {
  it("from S's session (all out): D = -2 900 = sum(contrib), U = 0; the mirrored openings cancel: Reconciles", () => {
    const s = summarize(sRow(), example('out'), { strict: true });
    expect(s.difference).toBe(-2900);
    expect(s.unexplained).toEqual({ total: 0, ownOther: -50000, partnerOther: 50000, residualOwn: 0, residualPartner: 0 });
    expect(s.reconciles).toBe(true);
    expect(s.blockingRows).toBe(0);
    expect(s.identityFailures).toBe(0);
    expect(s.components).toEqual(expect.arrayContaining([
      { key: 'matched', amount: 0, count: 1 }, { key: 'in_flight', amount: -2500, count: 1 }, { key: 'receiver_undone', amount: -1200, count: 1 },
      { key: 'payer_undone', amount: 800, count: 1 }, { key: 'not_through_loan', amount: 0, count: 1 },
    ]));
    expect(s.components?.reduce((a, c) => a + c.count, 0)).toBe(5);
    expect(s.own).toEqual({ balance: -63700, attributed: -13700, other: -50000, loanShared: false });
    expect(s.partner).toEqual({ balance: 60800, attributed: 10800, other: 50000 });
  });

  it("from X's session (all in): the SAME D, contributions and U, not sign-flipped", () => {
    const s = summarize(xRow(), example('in'), { strict: true });
    const o = summarize(sRow(), example('out'), { strict: true });
    expect(s.difference).toBe(-2900);
    expect(s.unexplained?.total).toBe(0);
    expect(s.reconciles).toBe(true);
    expect(s.components).toEqual(o.components);
  });

  it('without the hand-posted openings: Reconciles from both sessions', () => {
    const s = summarize(sRow({ own_balance: '-13700.00', own_other: '0', partner_balance: '10800.00', partner_other: '0' }), example('out'), { strict: true });
    const x = summarize(xRow({ own_balance: '10800.00', own_other: '0', partner_balance: '-13700.00', partner_other: '0' }), example('in'), { strict: true });
    for (const r of [s, x]) {
      expect(r.difference).toBe(-2900);
      expect(r.unexplained).toEqual({ total: 0, ownOther: 0, partnerOther: 0, residualOwn: 0, residualPartner: 0 });
      expect(r.reconciles).toBe(true);
    }
  });

  it('variant 1: the partner opened at R49 000: the hand postings do not cancel, U = -1 000, no Reconciles, from both sessions', () => {
    const s = summarize(sRow({ partner_balance: '59800.00', partner_other: '49000.00' }), example('out'), { strict: true });
    const x = summarize(xRow({ own_balance: '59800.00', own_other: '49000.00' }), example('in'), { strict: true });
    expect(s.difference).toBe(-3900);
    expect(s.unexplained).toEqual({ total: -1000, ownOther: -50000, partnerOther: 49000, residualOwn: 0, residualPartner: 0 });
    expect(x.unexplained).toEqual({ total: -1000, ownOther: 49000, partnerOther: -50000, residualOwn: 0, residualPartner: 0 });
    expect(s.reconciles).toBe(false);
    expect(x.reconciles).toBe(false);
  });

  it('the openings cancel but the residuals only cancel each other: U = 0, no Reconciles', () => {
    // S's attributed journals carry -300 more than its messages, X's +300 more, on top of the cancelling openings
    const s = summarize(sRow({ own_balance: '-64000.00', own_attributed: '-14000.00', partner_balance: '61100.00' }), example('out'), { strict: true });
    expect(s.unexplained).toEqual({ total: 0, ownOther: -50000, partnerOther: 50000, residualOwn: -300, residualPartner: 300 });
    expect(s.difference).toBe(-2900);
    expect(s.reconciles).toBe(false);
  });

  it('variant 2: a batch journal crediting R5 000 for two pending R2 000 messages: residual_S = -1 000, no Reconciles', () => {
    const msgs = [m(2000, { payerJournalDiffers: true }), m(2000, { payerJournalDiffers: true })];
    const s = summarize(sRow({ own_balance: '-55000.00', own_attributed: '-5000.00', own_other: '-50000.00', partner_balance: '50000.00', partner_other: '50000.00' }), msgs, { strict: true });
    expect(s.unexplained?.residualOwn).toBe(-1000);
    expect(s.unexplained?.total).toBe(-1000);
    expect(s.reconciles).toBe(false);
    expect(s.blockingRows).toBe(2);
  });
});

describe('the badge ((l).6)', () => {
  const zero = sRow({ own_balance: '0', own_attributed: '0', own_other: '0', partner_balance: '0', partner_other: '0' });
  it.each<[string, Partial<MessageFacts>]>([
    ['an anomaly row', { status: 'pending', receiverCounts: true }],
    ['a loan_account_changed row', { loanAccountChanged: true, payerCounts: false, payerState: 'journal_reversed' }],
    ['a withdrawn row', { status: 'withdrawn', payerCounts: false, payerState: 'journal_reversed' }],
    ['a payer_journal_differs row', { payerJournalDiffers: true, payerCounts: false, payerState: 'journal_reversed' }],
    ['a receiver_journal_differs row', { receiverJournalDiffers: true, payerCounts: false, payerState: 'journal_reversed' }],
  ])('U = 0 and D = sum(contrib) but %s: no Reconciles', (_n, over) => {
    const s = summarize(zero, [m(100, over)], { strict: true });
    expect(s.unexplained?.total).toBe(0);
    expect(s.difference).toBe(0);
    expect(s.reconciles).toBe(false);
    expect(s.blockingRows).toBe(1);
  });
  it('nothing at all reconciles', () => {
    expect(summarize(zero, [], { strict: true }).reconciles).toBe(true);
  });
  it('hand postings that cancel (S -500, X +500), residuals 0: Reconciles, the parts carried for the note', () => {
    const s = summarize({ ...zero, own_balance: '-500', own_other: '-500', partner_balance: '500', partner_other: '500' }, [], { strict: true });
    expect(s.unexplained).toEqual({ total: 0, ownOther: -500, partnerOther: 500, residualOwn: 0, residualPartner: 0 });
    expect(s.reconciles).toBe(true);
  });
  it("S's loan account shared with another connection: never Reconciles, even when every figure would (round 2, (m).18)", () => {
    // B's view: the other connection's Cr 700 lands in own_other and cancels A's unrelated Dr 700 in partner_other
    const shared = { ...zero, own_balance: '-700', own_other: '-700', own_loan_shared: true, partner_balance: '700', partner_other: '700' };
    const s = summarize(shared, [], { strict: true });
    expect(s.unexplained).toEqual({ total: 0, ownOther: -700, partnerOther: 700, residualOwn: 0, residualPartner: 0 });
    expect(s.reconciles).toBe(false);
    expect(summarize({ ...zero, own_loan_shared: true }, [], { strict: true }).reconciles).toBe(false);
    expect(summarize({ ...shared, own_loan_shared: false }, [], { strict: true }).reconciles).toBe(true);
  });
  it('hand postings that do not cancel (S -500, X +400): no Reconciles', () => {
    const s = summarize({ ...zero, own_balance: '-500', own_other: '-500', partner_balance: '400', partner_other: '400' }, [], { strict: true });
    expect(s.unexplained?.total).toBe(-100);
    expect(s.reconciles).toBe(false);
  });
  it.each<[string, Partial<SummaryRow>, Partial<Record<'ownOther' | 'partnerOther' | 'residualOwn' | 'residualPartner', number>>]>([
    // S's attributed journals carry -300 more than its messages, X's +300 more: the residuals cancel
    ['residuals that cancel', { own_balance: '-300', own_attributed: '-300', partner_balance: '300', partner_other: '0' }, { residualOwn: -300, residualPartner: 300 }],
    // a hand posting of S against a residual of X
    ['a hand posting against a residual', { own_balance: '-200', own_other: '-200', partner_balance: '200', partner_other: '0' }, { ownOther: -200, residualPartner: 200 }],
  ])('U = 0 and D = sum(contrib) but %s: no Reconciles (a residual is not 0)', (_n, row, parts) => {
    const s = summarize({ ...zero, ...row }, [], { strict: true });
    expect(s.unexplained?.total).toBe(0);
    expect(s.difference).toBe(0);
    expect(s.unexplained).toMatchObject(parts);
    expect(s.reconciles).toBe(false);
    expect(s.blockingRows).toBe(0);
  });
});

describe('I1 and I2', () => {
  it('I1: a balance that is not attributed + other is an identity failure (strict: a throw)', () => {
    const bad = sRow({ own_attributed: '-13600.00' });
    expect(() => summarize(bad, example('out'), { strict: true })).toThrow(LoanReconIdentityError);
    const s = summarize(bad, example('out'), { strict: false });
    expect(s.identityFailures).toBeGreaterThan(0);
    expect(s.reconciles).toBe(false);
  });
  it('rounding: sub-cent text is rounded per figure, identities run in integer cents', () => {
    const s = summarize(sRow({ own_balance: '-13700.004', own_attributed: '-13700.001', own_other: '-0.003', partner_balance: '10800.00', partner_other: '0' }),
      example('out'), { strict: true });
    expect(s.own?.balance).toBe(-13700);
    expect(s.reconciles).toBe(true);
  });
});

describe('the partner withheld ((l).3)', () => {
  it.each(['connection_not_active', 'not_group', 'not_one_group', 'loan_unset', 'partner_flag_off', 'partner_setup'] as const)('%s: own figures only, everything else null, no throw', (state) => {
    const facts = example('out').map((x) => ({ ...x, receiverState: null, receiverCounts: null, receiverAfterT: null, loanAccountChanged: null, partnerDocument: null }));
    const s = summarize(sRow({ partner_state: state, partner_balance: null, partner_other: null }), facts, { strict: true });
    expect(s).toMatchObject({ partnerState: state, partner: null, difference: null, components: null, unexplained: null, reconciles: null, blockingRows: null, identityFailures: 0 });
    expect(s.withheld?.reason).toBe(state);
    expect(s.withheld?.sentence).toMatch(/\w/);
    if (state !== 'loan_unset') expect(s.own).toEqual({ balance: -63700, attributed: -13700, other: -50000, loanShared: false });
  });
  it('S without a loan account: own null', () => {
    const s = summarize(sRow({ partner_state: 'loan_unset', own_balance: null, own_attributed: null, own_other: null, own_loan_shared: null, partner_balance: null, partner_other: null }), [], { strict: true });
    expect(s.own).toBeNull();
  });
});
