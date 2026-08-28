/**
 * Bank Rules Matching Helpers — pure helpers used by bankRulesMatchingService.
 * Kept separate to keep the main service file under the 300-line cap.
 */

import { sql } from '@/lib/neon';
import { getSystemAccountId } from '../gl/systemAccountResolver';
import type { JournalLineInput } from '../../types/gl.types';

export type RuleAllocType = 'account' | 'supplier' | 'customer';

/**
 * Discriminated period state for a given entry date.
 * - `open`       — a covering fiscal_periods row exists and status='open'
 * - `closed`     — a covering row exists but status is 'closed' or 'locked'
 * - `no_period`  — no row covers this date at all (fiscal year not created)
 *
 * The `no_period` case must be reported separately from `closed`: the remedy
 * differs (create the fiscal year vs. re-open the period), and conflating
 * them in the UI sent users in circles when their periods were all open but
 * the year hadn't been created.
 */
export type PeriodStatus = 'open' | 'closed' | 'no_period';

/**
 * Resolve the fiscal-period state for a transaction date. Used by applyRules
 * to pre-filter auto-post candidates so we never insert a draft JE that will
 * fail to post — that would leave orphan drafts in the GL.
 */
export async function getPeriodStatusForDate(
  companyId: string,
  entryDate: string,
): Promise<PeriodStatus> {
  const rows = (await sql`
    SELECT status FROM fiscal_periods
    WHERE company_id = ${companyId}::UUID
      AND start_date <= ${entryDate}::DATE
      AND end_date   >= ${entryDate}::DATE
    LIMIT 1
  `) as Record<string, unknown>[];
  if (rows.length === 0) return 'no_period';
  return String(rows[0]!.status) === 'open' ? 'open' : 'closed';
}

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

export interface BuildLinesArgs {
  allocType: RuleAllocType;
  totalAmount: number;
  netAmount: number;
  vatAmount: number;
  hasVat: boolean;
  vatAccountKey: 'vat_input' | 'vat_output';
  vatType: 'standard' | 'zero_rated' | 'exempt' | undefined;
  isDeposit: boolean;
  bankGlAccountId: string;
  ruleGlAccountId: string | null;
  apAccountId: string | null;
  arAccountId: string | null;
  entryDesc: string;
  companyId: string;
}

/** Build the journal lines for a single auto-create rule match. */
export async function buildAutoCreateLines(args: BuildLinesArgs): Promise<JournalLineInput[]> {
  const {
    allocType, totalAmount, netAmount, vatAmount, hasVat, vatAccountKey, vatType,
    isDeposit, bankGlAccountId, ruleGlAccountId, apAccountId, arAccountId, entryDesc, companyId,
  } = args;
  const vatLine = async () => {
    const id = await getSystemAccountId(vatAccountKey, companyId);
    return { glAccountId: id, debit: 0, credit: 0, description: 'VAT @ 15%', vatType: 'standard' as const };
  };
  if (allocType === 'supplier') {
    const lines: JournalLineInput[] = [
      { glAccountId: apAccountId!, debit: netAmount, credit: 0, description: entryDesc, vatType },
      { glAccountId: bankGlAccountId, debit: 0, credit: totalAmount, description: entryDesc },
    ];
    if (hasVat) lines.splice(1, 0, { ...await vatLine(), debit: vatAmount });
    return lines;
  }
  if (allocType === 'customer') {
    const lines: JournalLineInput[] = [
      { glAccountId: bankGlAccountId, debit: totalAmount, credit: 0, description: entryDesc },
      { glAccountId: arAccountId!, debit: 0, credit: netAmount, description: entryDesc, vatType },
    ];
    if (hasVat) lines.push({ ...await vatLine(), credit: vatAmount });
    return lines;
  }
  if (isDeposit) {
    const lines: JournalLineInput[] = [
      { glAccountId: bankGlAccountId, debit: totalAmount, credit: 0, description: entryDesc },
      { glAccountId: ruleGlAccountId!, debit: 0, credit: netAmount, description: entryDesc, vatType },
    ];
    if (hasVat) lines.splice(1, 0, { ...await vatLine(), credit: vatAmount });
    return lines;
  }
  const lines: JournalLineInput[] = [
    { glAccountId: ruleGlAccountId!, debit: netAmount, credit: 0, description: entryDesc, vatType },
    { glAccountId: bankGlAccountId, debit: 0, credit: totalAmount, description: entryDesc },
  ];
  if (hasVat) lines.splice(1, 0, { ...await vatLine(), debit: vatAmount });
  return lines;
}
