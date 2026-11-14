/**
 * Pure: which bank line, if any, a proof of payment is attached to (POP inbox, phase 2).
 *
 * The SQL (popMatchSweep.ts) supplies every (POP, bank line) pair that agrees on company, amount
 * (line = -POP amount) and date (payment_date .. payment_date + 3), for the POPs being checked AND
 * for every other open POP of the company that wants one of those lines, with whether the line's bank
 * account is imported past the window. This module adds the name test and the decision rules (Hein,
 * 2026-11-14: auto-attach only on a unique match):
 *   - a pair stands only when the beneficiary is named AFTER "ABSA BANK" in the line's description
 *     (descriptionNamesBeneficiary);
 *   - a POP is attached only when exactly one line stands for it, no other open POP stands for that
 *     line, and that line's account is imported past payment_date + window (a later line on the
 *     account exists). Not yet imported past it: not_found, looked at again next tick. ~30 payments of
 *     exactly R3,000.00 can share one day, so amount and date never decide.
 */

export interface MatchPair {
  popId: string;
  beneficiary: string;
  bankTxId: string;
  description: string | null;
  /** The line's bank account has a posted line dated after this POP's payment_date + window. */
  windowImported: boolean;
}

export type MatchDecision =
  | { outcome: 'attach'; bankTxId: string }
  | { outcome: 'ambiguous'; candidateBankTxIds: string[] }
  | { outcome: 'not_found' };

/** A beneficiary shorter than this, normalised, names nothing ("A", "MR") and never matches. */
export const MIN_BENEFICIARY_CHARS = 3;
/** ABSA prints the beneficiary cut to this many characters: a name this long may end mid-word. */
export const ABSA_BENEFICIARY_CHARS = 20;
/** Every ABSA statement wording of an outgoing payment names the beneficiary after this. */
const ABSA_BANK = ' ABSA BANK ';

/** Accents folded (é → E), upper case, every run of other characters → one space, trimmed. */
export function normalizeForMatch(text: string | null | undefined): string {
  return (text ?? '').normalize('NFD').replace(/\p{M}/gu, '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
}

/**
 * The line's description names the beneficiary: in the text after the first "ABSA BANK" (a description
 * without it never matches), starting at a word, and ending at a word unless the beneficiary is exactly
 * ABSA's 20-character cut ("AMOEPONG BED AND BRE"), whose end is open.
 */
export function descriptionNamesBeneficiary(description: string | null, beneficiary: string): boolean {
  const name = normalizeForMatch(beneficiary);
  if (name.length < MIN_BENEFICIARY_CHARS) return false;
  const text = ` ${normalizeForMatch(description)} `;
  const at = text.indexOf(ABSA_BANK);
  if (at < 0) return false;
  const payee = text.slice(at + ABSA_BANK.length - 1); // keeps the leading space
  const openEnd = beneficiary.length === ABSA_BENEFICIARY_CHARS;
  return payee.includes(openEnd ? ` ${name}` : ` ${name} `);
}

/** One decision per id in `popIds`, from the amount/date pairs of those POPs and of their rivals. */
export function decideMatches(popIds: readonly string[], pairs: readonly MatchPair[]): Map<string, MatchDecision> {
  const linesByPop = new Map<string, Map<string, MatchPair>>();
  const popsByLine = new Map<string, Set<string>>();
  for (const p of pairs) {
    if (!descriptionNamesBeneficiary(p.description, p.beneficiary)) continue;
    if (!linesByPop.has(p.popId)) linesByPop.set(p.popId, new Map());
    linesByPop.get(p.popId)!.set(p.bankTxId, p);
    if (!popsByLine.has(p.bankTxId)) popsByLine.set(p.bankTxId, new Set());
    popsByLine.get(p.bankTxId)!.add(p.popId);
  }

  const decisions = new Map<string, MatchDecision>();
  for (const popId of popIds) {
    const mine = linesByPop.get(popId) ?? new Map<string, MatchPair>();
    const lines = [...mine.keys()].sort();
    if (lines.length === 0) {
      decisions.set(popId, { outcome: 'not_found' });
    } else if (lines.length > 1 || popsByLine.get(lines[0]!)!.size > 1) {
      decisions.set(popId, { outcome: 'ambiguous', candidateBankTxIds: lines });
    } else if (!mine.get(lines[0]!)!.windowImported) {
      decisions.set(popId, { outcome: 'not_found' }); // a second line may still be imported
    } else {
      decisions.set(popId, { outcome: 'attach', bankTxId: lines[0]! });
    }
  }
  return decisions;
}
