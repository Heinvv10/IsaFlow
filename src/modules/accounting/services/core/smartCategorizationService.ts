/**
 * Smart Categorization Service
 * AI-powered bank transaction categorization using rules, patterns, and historical learning.
 * Coordinates the three-strategy pipeline and bulk operations.
 *
 * Performance: pre-loads rules/patterns ONCE per bulk run, then matches in-memory.
 * Security: all lookups are scoped to companyId to prevent cross-company data leakage.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import {
  matchAgainstRulesInMemory,
  matchAgainstPatternsInMemory,
  matchFromHistoryBulk,
  learnFromAllocation,
} from './smartCategorizationMatchingService';
import { recordSuggestionsShown } from '../bank/codingDecisionLog';
import { sourceFromStrategy } from '../bank/codingDecisionOutcome';
import { categorizeSweepScope, type CategorizeSweepScope } from './categorizeSweepScope';
import { markAttempted, recentlyAttempted } from './categorizeSweepAttempts';

export type { ConfidenceLevel, CategorizationResult, CachedRule, CachedPattern } from './smartCategorizationMatchingService';

type Row = DbRow;

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
    SELECT cp.*, ga.account_code AS gl_account_code, ga.account_name AS gl_account_name,
           ga.default_vat_code
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

  // 1. Fetch all target transactions in one query (company-scoped to prevent cross-tenant read)
  const txRows = (await sql`
    SELECT id, description, amount, reference
    FROM bank_transactions
    WHERE id = ANY(${transactionIds}::UUID[])
      AND company_id = ${companyId}::UUID
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
    SELECT cp.*, ga.account_code AS gl_account_code, ga.account_name AS gl_account_name,
           ga.default_vat_code
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
    const written = new Set<string>();
    for (let i = 0; i < matched.length; i += BATCH) {
      const batch = matched.slice(i, i + BATCH);
      const updated = await Promise.all(batch.map(({ txId, result }) => sql`
        UPDATE bank_transactions SET
          suggested_gl_account_id = COALESCE(${result.glAccountId ?? null}::UUID, suggested_gl_account_id),
          suggested_category       = COALESCE(${result.category ?? null},           suggested_category),
          suggested_vat_code       = COALESCE(${result.vatCode ?? null},            suggested_vat_code),
          suggested_confidence     = ${result.confidence},
          suggested_strategy       = ${result.matchSource}
        WHERE id = ${txId}::UUID
          AND company_id = ${companyId}::UUID
          AND suggested_gl_account_id IS NULL
        RETURNING id
      `));
      for (const rows of updated) if (Array.isArray(rows)) for (const r of rows as Row[]) written.add(String(r.id));
    }
    // Only the lines this run actually wrote: a line whose suggested_gl_account_id was already set (a person's
    // saved pick, or an earlier suggestion) kept it, so ISAFlow suggested nothing new there.
    await recordSuggestionsShown(companyId, matched.filter(({ txId }) => written.has(txId)).map(({ txId, result }) => ({
      txId, source: sourceFromStrategy(result.matchSource), glAccountId: result.glAccountId ?? null,
      category: result.category ?? null, confidence: result.confidence,
    })));
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

// ── Categorize the recent uncoded transactions of a bank account (categorizeSweepScope.ts) ──

/**
 * The lines one sweep takes: uncoded (imported, no suggested account or category, never in the decision log),
 * dated (SAST calendar day) or imported in the last `recentDays`, at most `maxLines`. Lines in `tried`
 * (categorizeSweepAttempts.ts) come last, so lines no rule matched cannot hold the batch forever; within each
 * group, newest first. Index candidates: idx_bt_company_date and the (company_id, status, created_at) index
 * for the two date arms, categorization_decisions_tx_idx for the NOT EXISTS; no EXPLAIN on a large tenant
 * is recorded yet.
 */
export async function selectSweepLineIds(companyId: string, bankAccountId: string,
  scope: CategorizeSweepScope = categorizeSweepScope(), tried: string[] = []
): Promise<string[]> {
  const txRows = (await sql`
    SELECT bt.id FROM bank_transactions bt
    WHERE bt.company_id = ${companyId}::UUID
      AND bt.bank_account_id = ${bankAccountId}::UUID
      AND bt.status = 'imported'
      AND bt.suggested_gl_account_id IS NULL
      AND bt.suggested_category IS NULL
      AND (bt.transaction_date >= (now() AT TIME ZONE 'Africa/Johannesburg')::date - ${scope.recentDays}::INT
           OR bt.created_at >= now() - make_interval(days => ${scope.recentDays}::INT))
      AND NOT EXISTS (
        SELECT 1 FROM categorization_decisions cd
        WHERE cd.company_id = bt.company_id AND cd.bank_transaction_id = bt.id
      )
    ORDER BY (bt.id = ANY(${tried}::uuid[])), bt.transaction_date DESC, bt.id
    LIMIT ${scope.maxLines}
  `) as Row[];
  return txRows.map((r: Row) => String(r.id));
}

/** A sweep's result plus the lines it tried for the first time within the retry window (the LLM's input). */
export interface SweepCategorizationResult extends BulkCategorizationResult {
  firstAttemptTxIds: string[];
}

export async function smartCategorizeForAccount(companyId: string,
  bankAccountId: string
): Promise<SweepCategorizationResult> {
  const ids = await selectSweepLineIds(companyId, bankAccountId, categorizeSweepScope(),
    recentlyAttempted(companyId, bankAccountId));
  const firstAttemptTxIds = markAttempted(companyId, bankAccountId, ids);
  return { ...(await bulkCategorize(companyId, ids)), firstAttemptTxIds };
}
