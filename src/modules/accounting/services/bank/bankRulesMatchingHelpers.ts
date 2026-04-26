/**
 * Bank Rules Matching Helpers — pure helpers used by bankRulesMatchingService.
 * Kept separate to keep the main service file under the 300-line cap.
 */

import { sql } from '@/lib/neon';
import { getSystemAccountId } from '../gl/systemAccountResolver';
import type { JournalLineInput } from '../../types/gl.types';

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

/** Find still-imported bank transactions that match a rule's pattern. */
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
