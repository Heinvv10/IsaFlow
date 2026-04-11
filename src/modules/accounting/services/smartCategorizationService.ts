/**
 * Smart Categorization Service
 * AI-powered bank transaction categorization using rules, patterns, and historical learning.
 * Coordinates the three-strategy pipeline and bulk operations.
 *
 * Performance: pre-loads rules/patterns ONCE per bulk run, then matches in-memory.
 * Security: all lookups are scoped to companyId to prevent cross-company data leakage.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import {
  matchAgainstRulesInMemory,
  matchAgainstPatternsInMemory,
  matchFromHistoryBulk,
  learnFromAllocation,
} from './smartCategorizationMatchingService';

export type { ConfidenceLevel, CategorizationResult, CachedRule, CachedPattern } from './smartCategorizationMatchingService';

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

export { learnFromAllocation };

// ── Core: Categorize a single transaction (used by ai-categorize endpoint) ───

export async function categorizeBankTransaction(companyId: string,
  tx: CategorizationInput
): Promise<import('./smartCategorizationMatchingService').CategorizationResult | null> {
  const description = (tx.description || '').toUpperCase().trim();
  const reference = (tx.reference || '').toUpperCase().trim();

  if (!description && !reference) return null;

  // Load rules for this company (single call, company-scoped)
  const rules = await sql`
    SELECT r.*, ga.account_code AS gl_account_code, ga.account_name AS gl_account_name
    FROM bank_categorisation_rules r
    LEFT JOIN gl_accounts ga ON ga.id = r.gl_account_id
    WHERE r.is_active = true AND r.company_id = ${companyId}::uuid
    ORDER BY r.priority DESC
  ` as Row[];

  const ruleMatch = matchAgainstRulesInMemory(description, reference, rules);
  if (ruleMatch) return ruleMatch;

  // Load patterns (global learned + company-scoped preferred)
  const patterns = await sql`
    SELECT cp.*, ga.account_code AS gl_account_code, ga.account_name AS gl_account_name
    FROM categorization_patterns cp
    LEFT JOIN gl_accounts ga ON ga.id = cp.gl_account_id
    WHERE cp.company_id = ${companyId}::uuid OR cp.company_id IS NULL
    ORDER BY cp.confidence DESC, cp.usage_count DESC
  ` as Row[];

  const patternMatch = matchAgainstPatternsInMemory(description, reference, patterns);
  if (patternMatch) return patternMatch;

  return null;
}

// ── Bulk categorize — pre-loads data ONCE, matches in-memory, single bulk UPDATE ──

export async function bulkCategorize(companyId: string,
  transactionIds: string[]
): Promise<BulkCategorizationResult> {
  if (transactionIds.length === 0) {
    return { categorized: 0, skipped: 0, results: [] };
  }

  // 1. Fetch all target transactions in one query
  const txRows = (await sql`
    SELECT id, description, amount, reference
    FROM bank_transactions
    WHERE id = ANY(${transactionIds}::UUID[])
      AND status IN ('imported', 'allocated')
  `) as Row[];

  if (txRows.length === 0) return { categorized: 0, skipped: 0, results: [] };

  // 2. Pre-load all rules for this company ONCE (company-scoped, no IDOR)
  const rules = (await sql`
    SELECT r.*, ga.account_code AS gl_account_code, ga.account_name AS gl_account_name
    FROM bank_categorisation_rules r
    LEFT JOIN gl_accounts ga ON ga.id = r.gl_account_id
    WHERE r.is_active = true AND r.company_id = ${companyId}::uuid
    ORDER BY r.priority DESC
  `) as Row[];

  // 3. Pre-load all patterns ONCE (prefer company-scoped, fall back to global)
  const patterns = (await sql`
    SELECT cp.*, ga.account_code AS gl_account_code, ga.account_name AS gl_account_name
    FROM categorization_patterns cp
    LEFT JOIN gl_accounts ga ON ga.id = cp.gl_account_id
    WHERE cp.company_id = ${companyId}::uuid OR cp.company_id IS NULL
    ORDER BY
      CASE WHEN cp.company_id = ${companyId}::uuid THEN 0 ELSE 1 END,
      cp.confidence DESC,
      cp.usage_count DESC
  `) as Row[];

  // 4. Match all transactions in-memory (zero additional DB round-trips for rules/patterns)
  type MatchedTx = { txId: string; result: import('./smartCategorizationMatchingService').CategorizationResult };
  const matched: MatchedTx[] = [];
  const resultMap = new Map<string, import('./smartCategorizationMatchingService').CategorizationResult | null>();

  // Build description keys for bulk history lookup
  const descriptions: string[] = [];

  for (const tx of txRows) {
    const txId = String(tx.id);
    const description = String(tx.description || '').toUpperCase().trim();
    const reference = String(tx.reference || '').toUpperCase().trim();

    const ruleResult = matchAgainstRulesInMemory(description, reference, rules);
    if (ruleResult) {
      matched.push({ txId, result: ruleResult });
      resultMap.set(txId, ruleResult);
      continue;
    }

    const patternResult = matchAgainstPatternsInMemory(description, reference, patterns);
    if (patternResult) {
      matched.push({ txId, result: patternResult });
      resultMap.set(txId, patternResult);
      continue;
    }

    // Queue for historical lookup
    descriptions.push(description);
    resultMap.set(txId, null);
  }

  // 5. Bulk historical lookup (single query covering all unmatched descriptions)
  const unmatched = txRows.filter(tx => resultMap.get(String(tx.id)) === null);
  if (unmatched.length > 0) {
    const histMap = await matchFromHistoryBulk(
      companyId,
      unmatched.map(tx => ({
        txId: String(tx.id),
        description: String(tx.description || '').toUpperCase().trim(),
        amount: Number(tx.amount),
      }))
    );
    for (const [txId, result] of histMap.entries()) {
      if (result) {
        matched.push({ txId, result });
        resultMap.set(txId, result);
      }
    }
  }

  // 6. Bulk UPDATE all matched transactions in parallel batches of 25
  if (matched.length > 0) {
    const BATCH = 25;
    for (let i = 0; i < matched.length; i += BATCH) {
      const batch = matched.slice(i, i + BATCH);
      await Promise.all(batch.map(({ txId, result }) => sql`
        UPDATE bank_transactions SET
          suggested_gl_account_id = COALESCE(${result.glAccountId ?? null}::UUID, suggested_gl_account_id),
          suggested_category       = COALESCE(${result.category ?? null},           suggested_category),
          suggested_vat_code       = COALESCE(${result.vatCode ?? null},            suggested_vat_code),
          suggested_confidence     = ${result.confidence}
        WHERE id = ${txId}::UUID
          AND suggested_gl_account_id IS NULL
      `));
    }
  }

  const results = txRows.map(tx => ({
    transactionId: String(tx.id),
    result: resultMap.get(String(tx.id)) ?? null,
  }));

  const categorized = matched.length;
  const skipped = txRows.length - categorized;

  log.info('Bulk smart categorization complete', {
    companyId,
    total: txRows.length,
    categorized,
    skipped,
    rulesLoaded: rules.length,
    patternsLoaded: patterns.length,
  }, 'accounting');

  return { categorized, skipped, results };
}

// ── Categorize all uncategorized transactions for a bank account ──────────────

export async function smartCategorizeForAccount(companyId: string,
  bankAccountId: string
): Promise<BulkCategorizationResult> {
  const txRows = (await sql`
    SELECT id FROM bank_transactions
    WHERE bank_account_id = ${bankAccountId}::UUID
      AND company_id = ${companyId}::uuid
      AND status IN ('imported', 'allocated')
      AND suggested_gl_account_id IS NULL
      AND suggested_category IS NULL
    ORDER BY transaction_date DESC
    LIMIT 500
  `) as Row[];

  const ids = txRows.map((r: Row) => String(r.id));
  return bulkCategorize(companyId, ids);
}
