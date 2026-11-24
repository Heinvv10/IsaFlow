/**
 * The summary of the loan reconciliation (P5, plan sections (d), (k).4, (l).1, (l).3, (l).6). Pure, in integer cents.
 *
 * From b4's row (the two companies' loan balances at T, each split into the part from this connection's allocation journals and the rest)
 * and every message's facts (b3): D = own_balance + partner_balance; each message's contribution (loanReconBuckets.ts); the residuals
 * residual_Y = attributed_Y - expected_Y, where expected_Y sums -a x [pc AND lc] over the messages Y paid and +a x [rc] over those Y received;
 * Unexplained U = own_other + partner_other + residual_S + residual_X (the headline: other postings on the loan accounts, and journals that
 * differ from their messages). I0 (one bucket per message) is a code assertion. I2 (D = sum(contrib) + U) is kept as a code assertion of
 * this function's own sums, but given I1 and the definitions it is arithmetic: it can catch a defect here (a lost row, a sign), never a
 * wrong ledger, so it is no safety net (round 1, (c)). Strict (the caller says so: the tests) throws on a failure; otherwise it is counted
 * for an "Unexplained (count)" line, never shown as a figure. "Reconciles" ONLY when residual_S = 0 AND residual_X = 0 AND D = sum(contrib)
 * (so U = 0: the hand postings, own_other + partner_other, net to 0), no anomaly / loan_account_changed / withdrawn row, no row whose payer
 * or receiver journal differs from its messages, and no identity failed. Mirrored hand-posted openings are the normal case: they cancel and
 * reconcile (the card notes them); residuals that cancel each other never give green (plan (m).6).
 *
 * The partner withheld (b0 not ok): no difference, no components, no Unexplained, no badge, no assertion ((l).3).
 */
import { BLOCKING_BUCKETS, bucketOf, contributionCents, toCents } from './loanReconBuckets';
import { WITHHELD_SENTENCES } from './loanReconRefusals';
import type { Bucket, Component, Figures, MessageFacts, ReconSummary, SummaryRow } from './loanReconTypes';
import { BUCKETS } from './loanReconTypes';

/** An identity that only a code defect can break (strict mode). */
export class LoanReconIdentityError extends Error {
  constructor(readonly identity: 'I0' | 'I1' | 'I2') {
    super(`intercompany loan reconciliation: identity ${identity} does not hold`);
    this.name = 'LoanReconIdentityError';
  }
}

const rand = (cents: number): number => Math.round(cents) / 100 || 0;

function figures(balance: number, other: number): Figures {
  return { balance: rand(balance), attributed: rand(balance - other), other: rand(other) };
}

export type SummaryCore = Omit<ReconSummary, 'counts' | 'truncated'>;

export function summarize(row: SummaryRow, messages: MessageFacts[], opts: { strict: boolean }): SummaryCore {
  const failures: ('I0' | 'I1' | 'I2')[] = [];
  const ownKnown = row.own_balance !== null && row.own_balance !== undefined;
  const own = { balance: toCents(row.own_balance), attributed: toCents(row.own_attributed), other: toCents(row.own_other) };
  if (ownKnown && own.balance !== own.attributed + own.other) failures.push('I1');
  const ownView = ownKnown ? { ...figures(own.balance, own.other), attributed: rand(own.attributed), loanShared: row.own_loan_shared === true } : null;
  const loanAccountChanged = messages.some((m) => m.loanAccountChanged === true);

  if (row.partner_state !== 'ok') {
    if (opts.strict && failures.length) throw new LoanReconIdentityError(failures[0]!);
    return {
      partnerState: row.partner_state, own: ownView, partner: null,
      withheld: { reason: row.partner_state, sentence: WITHHELD_SENTENCES[row.partner_state] },
      difference: null, components: null, unexplained: null, reconciles: null, blockingRows: null,
      identityFailures: failures.length, loanAccountChanged,
    };
  }

  const partner = { balance: toCents(row.partner_balance), other: toCents(row.partner_other) };
  const partnerAttributed = partner.balance - partner.other;
  const byBucket = new Map<Bucket, { amount: number; count: number }>();
  let sum = 0;
  let expectedOwn = 0;
  let expectedPartner = 0;
  let bucketed = 0;
  let blocking = 0;
  for (const m of messages) {
    const bucket = bucketOf(m);
    const c = contributionCents(m);
    if (bucket === null || c === null) continue;
    bucketed += 1;
    sum += c;
    const cell = byBucket.get(bucket) ?? { amount: 0, count: 0 };
    byBucket.set(bucket, { amount: cell.amount + c, count: cell.count + 1 });
    const a = toCents(m.amount);
    const paid = m.payerCounts && m.payerLoanCredit ? -a : 0;
    const received = m.receiverCounts ? a : 0;
    // the payer's credit goes to the payer's expectation, the receiver's debit to the receiver's, whichever company is asking
    if (m.direction === 'out') { expectedOwn += paid; expectedPartner += received; } else { expectedPartner += paid; expectedOwn += received; }
    if (BLOCKING_BUCKETS.has(bucket) || m.payerJournalDiffers === true || m.receiverJournalDiffers === true) blocking += 1;
  }
  if (bucketed !== messages.length) failures.push('I0');
  const residualOwn = own.attributed - expectedOwn;
  const residualPartner = partnerAttributed - expectedPartner;
  const u = own.other + partner.other + residualOwn + residualPartner;
  const d = own.balance + partner.balance;
  if (d !== sum + u) failures.push('I2');
  if (opts.strict && failures.length) throw new LoanReconIdentityError(failures[0]!);

  const components: Component[] = BUCKETS.filter((b) => byBucket.has(b)).map((b) => ({ key: b, amount: rand(byBucket.get(b)!.amount), count: byBucket.get(b)!.count }));
  return {
    partnerState: 'ok', own: ownView, partner: figures(partner.balance, partner.other), withheld: null,
    difference: rand(d), components,
    unexplained: { total: rand(u), ownOther: rand(own.other), partnerOther: rand(partner.other), residualOwn: rand(residualOwn), residualPartner: rand(residualPartner) },
    reconciles: residualOwn === 0 && residualPartner === 0 && d === sum && u === 0 && blocking === 0 && failures.length === 0,
    blockingRows: blocking, identityFailures: failures.length, loanAccountChanged,
  };
}
