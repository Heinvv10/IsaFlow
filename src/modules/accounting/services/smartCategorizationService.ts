/**
 * Smart Categorization Service
 * AI-powered bank transaction categorization using rules, patterns, and historical learning.
 * Coordinates the three-strategy pipeline and bulk operations.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import {
  matchAgainstRules,
  matchAgainstPatterns,
  matchFromHistory,
} from './smartCategorizationMatchingService';

export type { ConfidenceLevel, CategorizationResult } from './smartCategorizationMatchingService';
export { learnFromAllocation } from './smartCategorizationMatchingService';

type Row = Record<string, unknown>;

export interface CategorizationInput {
  description: string;
  amount: number;
  reference?: string;
}

export interface BulkCategorizationResult {
  categorized: number;
  skipped: number;
  results: Array<{
    transactionId: string;
    result: import('./smartCategorizationMatchingService').CategorizationResult | null;
  }>;
}

// ── Core: Categorize a single transaction ────────────────────────────────────

export async function categorizeBankTransaction(companyId: string,
  tx: CategorizationInput
): Promise<import('./smartCategorizationMatchingService').CategorizationResult | null> {
  const description = (tx.description || '').toUpperCase().trim();
  const reference = (tx.reference || '').toUpperCase().trim();

  if (!description && !reference) return null;

  const ruleMatch = await matchAgainstRules(description, reference);
  if (ruleMatch) return ruleMatch;

  const patternMatch = await matchAgainstPatterns(description, reference);
  if (patternMatch) return patternMatch;

  const historicalMatch = await matchFromHistory(description, tx.amount);
  if (historicalMatch) return historicalMatch;

  return null;
}

// ── Bulk categorize ──────────────────────────────────────────────────────────

export async function bulkCategorize(companyId: string,
  transactionIds: string[]
): Promise<BulkCategorizationResult> {
  if (transactionIds.length === 0) {
    return { categorized: 0, skipped: 0, results: [] };
  }

  const txRows = (await sql`
    SELECT id, description, amount, reference
    FROM bank_transactions
    WHERE id = ANY(${transactionIds}::UUID[])
      AND status IN ('imported', 'allocated')
  `) as Row[];

  let categorized = 0;
  let skipped = 0;
  const results: BulkCategorizationResult['results'] = [];

  for (const tx of txRows) {
    const txId = String(tx.id);
    const input: CategorizationInput = {
      description: String(tx.description || ''),
      amount: Number(tx.amount),
      reference: tx.reference ? String(tx.reference) : undefined,
    };

    const result = await categorizeBankTransaction('', input);

    if (result) {
      await sql`
        UPDATE bank_transactions SET
          suggested_gl_account_id = COALESCE(${result.glAccountId || null}::UUID, suggested_gl_account_id),
          suggested_category = COALESCE(${result.category || null}, suggested_category),
          suggested_vat_code = COALESCE(${result.vatCode || null}, suggested_vat_code),
          suggested_confidence = ${result.confidence}
        WHERE id = ${txId}::UUID
          AND suggested_gl_account_id IS NULL
      `;
      categorized++;
      results.push({ transactionId: txId, result });
    } else {
      skipped++;
      results.push({ transactionId: txId, result: null });
    }
  }

  log.info('Bulk smart categorization complete', { categorized, skipped, total: txRows.length }, 'accounting');
  return { categorized, skipped, results };
}

// ── Categorize all uncategorized transactions for a bank account ──────────────

export async function smartCategorizeForAccount(companyId: string,
  bankAccountId: string
): Promise<BulkCategorizationResult> {
  const txRows = (await sql`
    SELECT id FROM bank_transactions
    WHERE bank_account_id = ${bankAccountId}::UUID
      AND status IN ('imported', 'allocated')
      AND suggested_gl_account_id IS NULL
      AND suggested_category IS NULL
    ORDER BY transaction_date DESC
    LIMIT 500
  `) as Row[];

  const ids = txRows.map((r: Row) => String(r.id));
  return bulkCategorize('', ids);
}
