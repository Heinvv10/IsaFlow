/**
 * Bank Rules Matching Helpers — pure helpers used by bankRulesMatchingService.
 * Kept separate to keep the main service file under the 300-line cap.
 */

import { sql } from '@/lib/neon';

export type RuleAllocType = 'account' | 'supplier' | 'customer';

/** Convert rule match type to SQL ILIKE pattern. */
export function toSqlPattern(matchType: string, matchPattern: string): string {
  switch (matchType) {
    case 'contains':    return `%${matchPattern}%`;
    case 'starts_with': return `${matchPattern}%`;
    case 'ends_with':   return `%${matchPattern}`;
    case 'exact':       return matchPattern;
    default:            return `%${matchPattern}%`;
  }
}

/**
 * How many candidates one rule may process in a single run.
 *
 * Each candidate takes a row lock that is held to the end of the request, so an
 * unbounded match set means an unbounded number of locked rows in one
 * transaction — a rule matching every line of a large import would block the
 * whole account for the duration. Capped, the run does 500 and reports that it
 * stopped; a re-run picks up the rest.
 */
export const MAX_RULE_CANDIDATES = 500;

/**
 * Find still-imported bank transactions that match a rule's pattern.
 *
 * Fetches one row past the cap so the caller can tell "exactly 500 matched"
 * from "500 processed, more waiting" — `applyRules` trims and reports it.
 *
 * Each row carries `period_status`: the status of the fiscal period covering
 * its date, or null when none does. The sweep counts a line whose period is
 * not open WITHOUT attempting it — the controlled allocation would refuse it
 * (`ClosedFiscalPeriodError`) every run, and a line that can never clear must
 * not consume the per-request attempt budget on every import until a person
 * re-opens the period. Postable-period rows sort first, so they take the
 * candidate cap before rows that are only going to be counted.
 */
export async function findMatchingTxs(
  companyId: string,
  bankAccountId: string,
  field: string,
  pattern: string,
): Promise<Record<string, unknown>[]> {
  const matches = field === 'description' ? sql`bt.description ILIKE ${pattern}`
    : field === 'reference' ? sql`bt.reference ILIKE ${pattern}`
    : sql`(bt.description ILIKE ${pattern} OR bt.reference ILIKE ${pattern})`;
  return (await sql`
    SELECT bt.id, bt.amount, bt.transaction_date, bt.description, bt.reference, fp.status AS period_status
    FROM bank_transactions bt
    LEFT JOIN fiscal_periods fp
      ON fp.company_id = bt.company_id AND fp.start_date <= bt.transaction_date AND fp.end_date >= bt.transaction_date
    WHERE bt.bank_account_id = ${bankAccountId}::UUID
      AND bt.company_id = ${companyId}::UUID
      AND bt.status = 'imported'
      AND bt.matched_journal_line_id IS NULL
      AND ${matches}
    ORDER BY (fp.status = 'open') DESC NULLS LAST, bt.transaction_date
    LIMIT ${MAX_RULE_CANDIDATES + 1}
  `) as Record<string, unknown>[];
}
