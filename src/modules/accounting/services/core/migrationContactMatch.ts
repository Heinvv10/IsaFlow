/**
 * Contact matching for the migration wizard.
 *
 * A source file names a customer or supplier as free text; the wizard has to
 * find the row it means. Exact match first, then a dice-coefficient match at
 * 0.7 or better, which tolerates the spelling and punctuation drift of a
 * hand-maintained ledger without inventing a match.
 *
 * Pure: no database, no tenant scoping of its own. Callers pass candidates
 * they have ALREADY scoped by company_id.
 */

import type { DbRow } from '@/types/db';

export function matchContact(name: string, candidates: DbRow[]): string | null {
  const normalized = name.toLowerCase().trim();
  const exact = candidates.find(c => String(c.name).toLowerCase().trim() === normalized);
  if (exact) return String(exact.id);
  let best: { id: string; score: number } | null = null;
  for (const c of candidates) {
    const score = diceCoefficient(normalized, String(c.name).toLowerCase().trim());
    if (score >= 0.7 && (!best || score > best.score)) best = { id: String(c.id), score };
  }
  return best?.id ?? null;
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
