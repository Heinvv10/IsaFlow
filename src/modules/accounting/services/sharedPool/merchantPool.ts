/**
 * Shared merchant-pattern pool — the pure aggregation (Hein, 2026-10-21, decisions 2-4). No I/O.
 *
 * Input: observations — one company's coding of one text (a learned pattern, a bank rule's match text, or a
 * decided bank line), already translated from the company's GL account to an ISAFlow category through that
 * company's own mapping. Output: the rows the pool may publish.
 *
 *   1. Every text goes through the PII filter (merchantPiiFilter.ts) first; a rejected text is dropped
 *      before it is counted anywhere.
 *   2. An observation from a company not in `eligible` is dropped (decision 3; the loader only loads
 *      eligible companies, this is the second gate).
 *   3. One company = one vote per merchant: its majority category over its own observations. A company
 *      tied between two categories abstains. So a company with 10 000 lines weighs the same as one with
 *      ten, and cannot alone carry the agreement.
 *   4. A merchant is published when at least MIN_DISTINCT_COMPANIES companies voted, and the winning
 *      category has at least MIN_AGREEMENT of those votes, and the category is poolable. Only the winner,
 *      the voter count, the agreement and the voters' total line count leave this function: never which
 *      companies voted, nor what the minority said.
 *   5. The pool never votes for itself. A company that accepted a pool suggestion for a merchant took the
 *      pool's word: that line, and everything else of the company's on that merchant key (the learned
 *      pattern the acceptance wrote, a rule made from it, a later 'pattern' suggestion accepted), is
 *      dropped. Only its 'recoded' decisions there still vote: the person chose an account themselves.
 *
 * The two thresholds are also CHECK constraints on shared_merchant_patterns (migration 906), so the table
 * refuses a row under them whatever the writer; merchantPool.test.ts pins the constants to that file.
 */

import { filterMerchant } from './merchantPiiFilter';
import { merchantCategory } from './merchantCategories';

/** Hein chose 5 (2026-10-21); the research report suggested k >= 10. See docs/security/shared-merchant-patterns.md. */
export const MIN_DISTINCT_COMPANIES = 5;
export const MIN_AGREEMENT = 0.8;

export interface PoolObservation {
  companyId: string;
  text: string;
  categoryCode: string;
  /** How many lines / patterns this observation stands for within the company (>= 1). */
  weight: number;
  /**
   * 'pool_accepted': a bank line whose pool suggestion was accepted as is (never a vote; mutes the company's
   * other evidence on the merchant, rule 5). 'recoded': a line the person coded away from the suggestion.
   * Absent: any other source (a pattern, a rule, an accepted non-pool suggestion).
   */
  origin?: 'pool_accepted' | 'recoded';
}

/** Exactly the five fields shared_pool_publish accepts; it refuses any other key. */
export interface PublishRow {
  merchant: string;
  category: string;
  companies: number;
  agreement: number;
  observations: number;
}

export interface AggregationStats {
  observations: number;
  rejectedByFilter: number;
  ineligibleDropped: number;
  merchantsSeen: number;
  published: number;
  /** Observations dropped because the company had taken the pool's word on that merchant (rule 5). */
  poolEchoDropped: number;
}

/** A company's vote: its majority category, or null on a tie. */
function companyVote(tally: Map<string, number>): string | null {
  let best: string | null = null;
  let bestN = 0;
  let tied = false;
  for (const [cat, n] of tally) {
    if (n > bestN) { best = cat; bestN = n; tied = false; } else if (n === bestN) { tied = true; }
  }
  return tied ? null : best;
}

export function aggregatePool(
  observations: PoolObservation[], eligible: ReadonlySet<string>,
): { rows: PublishRow[]; stats: AggregationStats } {
  const stats: AggregationStats = {
    observations: observations.length, rejectedByFilter: 0, ineligibleDropped: 0, merchantsSeen: 0, published: 0, poolEchoDropped: 0,
  };
  const kept: Array<{ o: PoolObservation; merchant: string }> = [];
  const poolTaken = new Set<string>(); // `${companyId} ${merchant}`
  for (const o of observations) {
    if (!eligible.has(o.companyId)) { stats.ineligibleDropped++; continue; }
    if (!merchantCategory(o.categoryCode)) continue;
    const f = filterMerchant(o.text);
    if (!f.ok) { stats.rejectedByFilter++; continue; }
    if (o.origin === 'pool_accepted') poolTaken.add(`${o.companyId} ${f.merchant}`);
    kept.push({ o, merchant: f.merchant });
  }
  // merchant -> company -> category -> weight
  const byMerchant = new Map<string, Map<string, Map<string, number>>>();
  for (const { o, merchant } of kept) {
    if (poolTaken.has(`${o.companyId} ${merchant}`) && o.origin !== 'recoded') { stats.poolEchoDropped++; continue; }
    const weight = Number.isFinite(o.weight) && o.weight >= 1 ? Math.floor(o.weight) : 1;
    const companies = byMerchant.get(merchant) ?? new Map<string, Map<string, number>>();
    const tally = companies.get(o.companyId) ?? new Map<string, number>();
    tally.set(o.categoryCode, (tally.get(o.categoryCode) ?? 0) + weight);
    companies.set(o.companyId, tally);
    byMerchant.set(merchant, companies);
  }
  stats.merchantsSeen = byMerchant.size;

  const rows: PublishRow[] = [];
  for (const [merchant, companies] of byMerchant) {
    const votes = new Map<string, number>();
    let voters = 0;
    let lines = 0;
    for (const tally of companies.values()) {
      const vote = companyVote(tally);
      if (vote === null) continue;
      voters++;
      votes.set(vote, (votes.get(vote) ?? 0) + 1);
      for (const n of tally.values()) lines += n;
    }
    if (voters < MIN_DISTINCT_COMPANIES) continue;
    const top = companyVote(votes);
    if (top === null || merchantCategory(top)?.poolable !== true) continue;
    const agreement = Math.floor(((votes.get(top) ?? 0) / voters) * 10_000) / 10_000;
    if (agreement < MIN_AGREEMENT) continue;
    rows.push({ merchant, category: top, companies: voters, agreement, observations: lines });
  }
  rows.sort((a, b) => (a.merchant < b.merchant ? -1 : a.merchant > b.merchant ? 1 : 0));
  stats.published = rows.length;
  return { rows, stats };
}

export interface CategoryMappingRow { categoryCode: string; glAccountId: string }

/**
 * A company's GL account -> category, for reading its coding into the pool. An account more than one
 * category maps to (Telephone & Internet) cannot say which category a line on it was, so it is left out:
 * its lines are ignored rather than guessed.
 */
export function accountToCategory(mappings: CategoryMappingRow[]): Map<string, string> {
  const seen = new Map<string, Set<string>>();
  for (const m of mappings) {
    const key = m.glAccountId.toLowerCase();
    const cats = seen.get(key) ?? new Set<string>();
    cats.add(m.categoryCode);
    seen.set(key, cats);
  }
  const out = new Map<string, string>();
  for (const [acct, cats] of seen) if (cats.size === 1) out.set(acct, [...cats][0]!);
  return out;
}
