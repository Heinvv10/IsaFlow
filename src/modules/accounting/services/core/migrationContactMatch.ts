/**
 * Contact matching for the migration wizard.
 *
 * A source file names a customer or supplier as free text; the wizard has to
 * find the row it means. Exact match first, then a dice-coefficient match at
 * 0.7 or better, which tolerates the spelling and punctuation drift of a
 * hand-maintained ledger without inventing a match.
 *
 * Pure: no database, no tenant scoping of its own. Callers pass candidates
 * they have ALREADY scoped by company_id. The wizard pages import
 * `matchContactWithConfidence` too, so the preview an operator approves is
 * the match the server will make — the pages used to substring-match, which
 * disagreed with this in both directions.
 */

/** The only fields matching reads; a DbRow or a page's `{ id, name }` both fit. */
export interface ContactCandidate {
  id?: unknown;
  name?: unknown;
}

export type ContactMatchConfidence = 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';

export interface ContactMatch {
  id?: string;
  confidence: ContactMatchConfidence;
}

/** The score a match must reach; below it the row is unmatched. */
export const CONTACT_MATCH_THRESHOLD = 0.7;

export function matchContactWithConfidence(name: string, candidates: readonly ContactCandidate[]): ContactMatch {
  const normalized = name.toLowerCase().trim();
  if (normalized === '') return { confidence: 'NONE' };
  const exact = candidates.find(c => String(c.name).toLowerCase().trim() === normalized);
  if (exact) return { id: String(exact.id), confidence: 'HIGH' };
  let best: { id: string; score: number } | null = null;
  for (const c of candidates) {
    const score = diceCoefficient(normalized, String(c.name).toLowerCase().trim());
    if (score >= CONTACT_MATCH_THRESHOLD && (!best || score > best.score)) best = { id: String(c.id), score };
  }
  if (!best) return { confidence: 'NONE' };
  return { id: best.id, confidence: best.score >= 0.85 ? 'MEDIUM' : 'LOW' };
}

export function matchContact(name: string, candidates: readonly ContactCandidate[]): string | null {
  return matchContactWithConfidence(name, candidates).id ?? null;
}

function diceCoefficient(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const ba = new Set<string>(), bb = new Set<string>();
  for (let i = 0; i < a.length - 1; i++) ba.add(a.substring(i, i + 2));
  for (let i = 0; i < b.length - 1; i++) bb.add(b.substring(i, i + 2));
  let n = 0;
  for (const g of ba) { if (bb.has(g)) n++; }
  return (2 * n) / (ba.size + bb.size);
}
