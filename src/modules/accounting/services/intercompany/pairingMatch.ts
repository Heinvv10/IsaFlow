/**
 * Pure rules of the pairing screen: which of this company's open documents and which of the partner's look like the same
 * invoice. A pair is proposed when the document NUMBER (case, punctuation and leading zeros ignored) and the TOTAL (to the cent)
 * agree; a number that agrees with a different total is an amount mismatch; an amount alone is never a match. Foreign-currency
 * documents are never proposed (the plan is ZAR only) and are listed on their own. Nothing here reads or writes the database.
 */
import type { PairingCandidate, PairingDoc, PairingMatches } from './pairingTypes';

const HOME_CURRENCY = 'ZAR';

/** 'INV-0042', 'inv 42' and 'INV/42' are one number; '10' and '1' are not. A number of nothing but punctuation is ''. */
export function normaliseNumber(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/(^|\D)0+(?=\d)/g, '$1');
}

const cents = (amount: number): number => Math.round(amount * 100);
const byDateThenId = (a: PairingDoc, b: PairingDoc): number =>
  a.date.localeCompare(b.date) || a.number.localeCompare(b.number) || a.id.localeCompare(b.id);

function group(docs: PairingDoc[]): Map<string, PairingDoc[]> {
  const out = new Map<string, PairingDoc[]>();
  for (const d of [...docs].sort(byDateThenId)) {
    const key = normaliseNumber(d.number);
    out.set(key, [...(out.get(key) ?? []), d]);
  }
  return out;
}

const candidate = (mine: PairingDoc, theirs: PairingDoc, ambiguous: boolean): PairingCandidate => ({
  mine, theirs, ambiguous, openDiffers: cents(mine.open) !== cents(theirs.open),
});

/** Sorts both sides' open documents into suggestions, amount mismatches and the documents with no counterpart. */
export function matchDocuments(mine: PairingDoc[], theirs: PairingDoc[]): PairingMatches {
  const unsupported = [...mine, ...theirs].filter((d) => d.currency !== HOME_CURRENCY);
  const unsupportedIds = new Set(unsupported.map((d) => d.id));
  const ours = group(mine.filter((d) => !unsupportedIds.has(d.id)));
  const partners = group(theirs.filter((d) => !unsupportedIds.has(d.id)));

  const suggestions: PairingCandidate[] = [];
  const mismatches: PairingCandidate[] = [];
  const unmatchedMine: PairingDoc[] = [];
  const unmatchedTheirs: PairingDoc[] = [];

  for (const [key, left] of ours) {
    const right = key === '' ? [] : [...(partners.get(key) ?? [])];
    partners.delete(key);
    const ambiguous = left.length > 1 || right.length > 1;
    const rest: PairingDoc[] = [];
    for (const m of left) {
      const at = right.findIndex((t) => cents(t.total) === cents(m.total));
      if (at < 0) { rest.push(m); continue; }
      suggestions.push(candidate(m, right.splice(at, 1)[0]!, ambiguous));
    }
    for (const m of rest) {
      const t = right.shift();
      if (t) mismatches.push(candidate(m, t, ambiguous));
      else unmatchedMine.push(m);
    }
    unmatchedTheirs.push(...right);
  }
  for (const rest of partners.values()) unmatchedTheirs.push(...rest);

  const order = (a: PairingCandidate, b: PairingCandidate) => byDateThenId(a.mine, b.mine);
  return {
    suggestions: suggestions.sort(order),
    mismatches: mismatches.sort(order),
    unmatchedMine: unmatchedMine.sort(byDateThenId),
    unmatchedTheirs: unmatchedTheirs.sort(byDateThenId),
    unsupported: unsupported.sort(byDateThenId),
  };
}
