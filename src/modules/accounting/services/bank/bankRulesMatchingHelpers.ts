/**
 * Bank Rules Matching Helpers — pure helpers used by bankRulesMatchingService.
 * Kept separate to keep the main service file under the 300-line cap.
 */

import { sql } from '@/lib/neon';

export type RuleAllocType = 'account' | 'supplier' | 'customer';

// PeriodStatus and getPeriodStatusForDate encode a GL rule, so they live in
// the GL module. Re-exported here because the bank-rules call sites (and their
// tests) have always imported them from this file.
export type { PeriodStatus } from '../gl/periodStatusService';
export { getPeriodStatusForDate } from '../gl/periodStatusService';

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
 */
export async function findMatchingTxs(
  companyId: string,
  bankAccountId: string,
  field: string,
  pattern: string,
): Promise<Record<string, unknown>[]> {
  if (field === 'description') {
    return (await sql`
      SELECT id, amount, transaction_date, description, reference
      FROM bank_transactions
      WHERE bank_account_id = ${bankAccountId}::UUID
        AND company_id = ${companyId}::UUID
        AND status = 'imported'
        AND matched_journal_line_id IS NULL
        AND description ILIKE ${pattern}
      ORDER BY transaction_date
      LIMIT ${MAX_RULE_CANDIDATES + 1}
    `) as Record<string, unknown>[];
  }
  if (field === 'reference') {
    return (await sql`
      SELECT id, amount, transaction_date, description, reference
      FROM bank_transactions
      WHERE bank_account_id = ${bankAccountId}::UUID
        AND company_id = ${companyId}::UUID
        AND status = 'imported'
        AND matched_journal_line_id IS NULL
        AND reference ILIKE ${pattern}
      ORDER BY transaction_date
      LIMIT ${MAX_RULE_CANDIDATES + 1}
    `) as Record<string, unknown>[];
  }
  return (await sql`
    SELECT id, amount, transaction_date, description, reference
    FROM bank_transactions
    WHERE bank_account_id = ${bankAccountId}::UUID
      AND company_id = ${companyId}::UUID
      AND status = 'imported'
      AND matched_journal_line_id IS NULL
      AND (description ILIKE ${pattern} OR reference ILIKE ${pattern})
    ORDER BY transaction_date
    LIMIT ${MAX_RULE_CANDIDATES + 1}
  `) as Record<string, unknown>[];
}
