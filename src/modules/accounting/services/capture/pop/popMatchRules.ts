/**
 * Pure: which bank line, if any, a proof of payment is attached to (POP inbox, phase 2).
 *
 * The SQL (popMatchSweep.ts) supplies every (POP, bank line) pair that agrees on company, amount
 * (line = -POP amount) and date (payment_date .. payment_date + 3), for the POPs being checked AND
 * for every other open POP of the company that wants one of those lines. This module adds the name
 * test and the uniqueness rule (Hein, 2026-11-14: auto-attach only on a unique match):
 *   - a pair stands only when the line's description contains the beneficiary as ABSA printed it
 *     (truncated to 20 characters), both normalised, starting on a word boundary;
 *   - a POP is attached only when exactly one line stands for it AND no other open POP stands for
 *     that line. ~30 payments of exactly R3,000.00 can share one day, so amount and date never decide.
 */

export interface MatchPair {
  popId: string;
  beneficiary: string;
  bankTxId: string;
  description: string | null;
}

export type MatchDecision =
  | { outcome: 'attach'; bankTxId: string }
  | { outcome: 'ambiguous'; candidateBankTxIds: string[] }
  | { outcome: 'not_found' };

/** A beneficiary shorter than this, normalised, names nothing ("A", "MR") and never matches. */
export const MIN_BENEFICIARY_CHARS = 3;

/** Upper case; every run of characters that are not A-Z or 0-9 becomes one space; trimmed. */
export function normalizeForMatch(text: string | null | undefined): string {
  return (text ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
}

/** The line's description names the beneficiary: contained, starting at a word, after normalising both. */
export function descriptionNamesBeneficiary(description: string | null, beneficiary: string): boolean {
  const name = normalizeForMatch(beneficiary);
  if (name.length < MIN_BENEFICIARY_CHARS) return false;
  // ABSA cuts the beneficiary mid-word ("AMOEPONG BED AND BRE"), so only its start is anchored.
  return ` ${normalizeForMatch(description)} `.includes(` ${name}`);
}

/** One decision per id in `popIds`, from the amount/date pairs of those POPs and of their rivals. */
export function decideMatches(popIds: readonly string[], pairs: readonly MatchPair[]): Map<string, MatchDecision> {
  const linesByPop = new Map<string, Set<string>>();
  const popsByLine = new Map<string, Set<string>>();
  for (const p of pairs) {
    if (!descriptionNamesBeneficiary(p.description, p.beneficiary)) continue;
    if (!linesByPop.has(p.popId)) linesByPop.set(p.popId, new Set());
    linesByPop.get(p.popId)!.add(p.bankTxId);
    if (!popsByLine.has(p.bankTxId)) popsByLine.set(p.bankTxId, new Set());
    popsByLine.get(p.bankTxId)!.add(p.popId);
  }

  const decisions = new Map<string, MatchDecision>();
  for (const popId of popIds) {
    const lines = [...(linesByPop.get(popId) ?? [])].sort();
    if (lines.length === 0) {
      decisions.set(popId, { outcome: 'not_found' });
    } else if (lines.length === 1 && popsByLine.get(lines[0]!)!.size === 1) {
      decisions.set(popId, { outcome: 'attach', bankTxId: lines[0]! });
    } else {
      decisions.set(popId, { outcome: 'ambiguous', candidateBankTxIds: lines });
    }
  }
  return decisions;
}
