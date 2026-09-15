/**
 * Bank Rules Matching Helpers — pure helpers used by bankRulesMatchingService.
 * Kept separate to keep the main service file under the 300-line cap.
 */

import { sql } from '@/lib/neon';

export type RuleAllocType = 'account' | 'supplier' | 'customer';

/**
 * Escape the LIKE metacharacters a rule's own pattern may contain.
 *
 * `match_pattern` is a literal the operator typed, not a pattern language they
 * were offered. Unescaped, `_` is ILIKE's single-character wildcard, so a rule
 * keyed on `SALARY_JAN` also claims `SALARYXJAN` and `exact` is not exact; `%`
 * matches any run of characters, so `50% OFF` claims `50ANYTHING OFF`.
 * `applyRules` auto-posts a journal for every row the match returns, so an
 * over-match is a posted misallocation rather than a display glitch.
 *
 * Backslash is ILIKE's default escape character, so escaping it first (before
 * the two wildcards) is what makes a literal backslash in the pattern stay one.
 */
function escapeLikeLiteral(matchPattern: string): string {
  return matchPattern.replace(/[\\%_]/g, ch => `\\${ch}`);
}

/** Convert rule match type to SQL ILIKE pattern. */
export function toSqlPattern(matchType: string, matchPattern: string): string {
  const lit = escapeLikeLiteral(matchPattern);
  switch (matchType) {
    case 'contains':    return `%${lit}%`;
    case 'starts_with': return `${lit}%`;
    case 'ends_with':   return `%${lit}`;
    case 'exact':       return lit;
    default:            return `%${lit}%`;
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
      AND bt.feed_state = 'posted'
      AND bt.matched_journal_line_id IS NULL
      AND ${matches}
    ORDER BY (fp.status = 'open') DESC NULLS LAST, bt.transaction_date
    LIMIT ${MAX_RULE_CANDIDATES + 1}
  `) as Record<string, unknown>[];
}
