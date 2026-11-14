/**
 * Splitting a journal that SEVERAL documents carry, for `party_ledger_check`.
 *
 * Two real posting paths put one journal on more than one document: a split
 * bank allocation naming several contacts (`bank/bankSplitContacts`: one payment
 * or receipt per contact, all carrying the split's journal) and a supplier
 * batch (`ap/batchPaymentService.processBatch`: one journal on the batch row,
 * none on the member payments). Journal lines carry no party and no document
 * (a line description is prose, not a key), so a document's own leg can only be
 * established from amounts. Summing the whole journal for each document counts
 * it N times and leaks one party's cash into another party's check.
 *
 * So a leg is counted only when it is PROVABLE:
 *
 *   line_match   the journal's control lines, as a multiset of amounts, equal the
 *                documents' own amounts exactly -- each line is one document's.
 *   batch_total  every document is a member of ONE payment batch, the batch
 *                journal posts the whole batch as a single control line, and
 *                that line equals the members' amounts summed. Each member's leg
 *                is its own amount.
 *
 * Anything else is `unattributable`: the documents get NO leg and are taken out
 * of the party's statement-minus-GL comparison, and a distinct flag names the
 * journal and everyone sharing it. Guessing a share would compare the statement
 * with a number the ledger never stated.
 *
 * Documents of the other subledger sharing the journal are not counted: their lines are
 * on the other control account, which the control-line read excludes.
 *
 * A reversal reverses the whole journal, so a document's leg is scaled by the
 * chain's net over the head's net (1 when never reversed, 0 when fully reversed).
 */
import { round2 } from './reconciliationMath';

export interface SharedRef {
  id: string;
  /** The document's own signed control amount, or null when it is not this side's document. */
  expected: number | null;
}

export interface SharedInput {
  /** The head entry's lines on the control accounts, signed in the statement orientation. */
  headLines: readonly number[];
  /** The whole chain's net on the control accounts (head plus reversals in force). */
  chainNet: number;
  refs: readonly SharedRef[];
  /** Every ref is a member of the one batch whose journal this is. */
  isBatch: boolean;
}

export type SharedAttribution =
  | { kind: 'attributed'; basis: 'line_match' | 'batch_total'; legs: Map<string, number> }
  | { kind: 'unattributable' };

function cents(n: number): number {
  return Math.round(n * 100);
}

function sameMultiset(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  const x = a.map(cents).sort((p, q) => p - q);
  const y = b.map(cents).sort((p, q) => p - q);
  return x.every((v, i) => v === y[i]);
}

export function attributeSharedJournal(input: SharedInput): SharedAttribution {
  const { headLines, chainNet, refs, isBatch } = input;
  const unattributable: SharedAttribution = { kind: 'unattributable' };
  // A document of the OTHER subledger (a split money-out line can pay a supplier and refund a
  // customer on one journal) has its lines on the other control account, which `headLines`
  // already leaves out. It is no claim on THIS side's lines, so it drops out of the match.
  const own = refs.filter((r): r is SharedRef & { expected: number } => r.expected !== null);
  const expected = own.map((r) => r.expected);
  const legsFrom = (scale: number): Map<string, number> =>
    new Map(own.map((r) => [r.id, round2(r.expected * scale)]));

  // Nothing of the head reached a control account (unposted, dated later, or on
  // other accounts): there is no leg to divide, and the chain cannot have one.
  if (headLines.length === 0) {
    return chainNet === 0 ? { kind: 'attributed', basis: 'line_match', legs: new Map(own.map((r) => [r.id, 0])) } : unattributable;
  }
  const headNet = round2(headLines.reduce((s, v) => s + v, 0));
  let basis: 'line_match' | 'batch_total';
  if (sameMultiset(headLines, expected)) basis = 'line_match';
  else if (isBatch && headLines.length === 1 && cents(headNet) === cents(expected.reduce((s, v) => s + v, 0))) basis = 'batch_total';
  else return unattributable;

  // headNet is the sum of the matched lines, so it is 0 only when the documents
  // themselves net to zero -- then the chain's scale is not recoverable.
  if (headNet === 0) return chainNet === 0 ? { kind: 'attributed', basis, legs: legsFrom(0) } : unattributable;
  return { kind: 'attributed', basis, legs: legsFrom(chainNet / headNet) };
}
