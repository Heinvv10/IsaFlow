/**
 * Bank Rules Suggestion Pass — the non-auto-create arm of `applyRules`.
 *
 * Split out of `bankRulesMatchingService.ts` to keep that file under the
 * 300-line cap. One statement: match every still-imported transaction against
 * every active suggestion-mode rule and write the highest-priority hit into the
 * `suggested_*` columns.
 */

import { sql } from '@/lib/neon';
import type { RuleApplyResult } from '../../types/bank.types';
import { toSqlPattern } from './bankRulesMatchingHelpers';

/**
 * `match_type` is nullable. The SQL this arm used to build fell through to the
 * EXACT branch for NULL (`CASE NULL::text WHEN 'contains' ... ELSE pattern END`
 * returns the bare pattern), but `String(null)` is `'null'`, which
 * `toSqlPattern`'s `default:` widens to `%pattern%`. Legacy rows can carry a
 * NULL — `bankRulesService.createRule` binds the value straight through — and
 * these suggestions are posted UNATTENDED by `autoPostGateService.sweep`, so
 * silently widening one is a posted misallocation. `exact` keeps the old
 * meaning; an unrecognised non-null value still means `contains`.
 */
export function rulePattern(rule: Record<string, unknown>): string {
  return toSqlPattern(String(rule.match_type ?? 'exact'), String(rule.match_pattern));
}

/** Returns one entry per transaction whose suggestion this pass changed. */
export async function applySuggestionRules(
  companyId: string,
  bankAccountId: string,
  suggestionRules: Record<string, unknown>[],
): Promise<RuleApplyResult['entries']> {
  // Match every still-imported transaction against every active suggestion-mode
  // rule, then keep the highest-priority match per transaction. We deliberately
  // overwrite any existing suggestion: a freshly-created or higher-priority rule
  // should take precedence over a stale AI suggestion or earlier rule hit.
  const suggestionRuleIds = suggestionRules.map((r: Record<string, unknown>) => String(r.id));
  // Escaped in TS and carried into the query beside its rule id, so this arm
  // runs the identical `toSqlPattern` output as the auto-create arm.
  // Built in SQL from the raw `r.match_pattern`, `_` and `%` stayed live
  // ILIKE wildcards on this arm alone — and the UPDATE below writes the
  // suggested_* columns that `autoPostGateService.sweep` posts UNATTENDED,
  // so the over-match still arrived as a posted misallocation, through the
  // gate rather than through the rule.
  const suggestionPatterns = suggestionRules.map(rulePattern);
  const updated = (await sql`
    WITH matched AS (
      SELECT
        bt.id                                              AS tx_id,
        r.gl_account_id,
        r.supplier_id,
        r.client_id,
        r.rule_name,
        r.vat_code,
        -- created_at, id after priority: two active rules at the same priority
        -- left the winner to heap order, and the auto-post gate sweep posts
        -- the chosen suggestion unattended.
        ROW_NUMBER() OVER (
          PARTITION BY bt.id ORDER BY r.priority ASC, r.created_at ASC, r.id ASC) AS rn
      FROM bank_transactions bt
      CROSS JOIN unnest(${suggestionRuleIds}::UUID[], ${suggestionPatterns}::TEXT[])
        AS rp(rule_id, pattern)
      JOIN bank_categorisation_rules r ON (
        r.id = rp.rule_id
        AND r.company_id = ${companyId}::UUID
        AND r.is_active = true
        AND r.auto_create_entry = false
        AND (
          (r.match_field IN ('description', 'both') AND bt.description ILIKE rp.pattern)
          OR
          (r.match_field IN ('reference', 'both') AND bt.reference ILIKE rp.pattern)
        )
      )
      WHERE bt.bank_account_id = ${bankAccountId}::UUID
        AND bt.company_id = ${companyId}::UUID
        AND bt.status = 'imported'
        AND bt.matched_journal_line_id IS NULL
    ),
    top_match AS (SELECT * FROM matched WHERE rn = 1)
    UPDATE bank_transactions bt
    SET
      suggested_gl_account_id = tm.gl_account_id,
      suggested_supplier_id   = tm.supplier_id,
      suggested_client_id     = tm.client_id,
      suggested_category      = tm.rule_name,
      suggested_vat_code      = COALESCE(NULLIF(tm.vat_code, ''), 'none')
    FROM top_match tm
    WHERE bt.id = tm.tx_id
      AND (
        bt.suggested_category    IS DISTINCT FROM tm.rule_name
        OR bt.suggested_gl_account_id IS DISTINCT FROM tm.gl_account_id
        OR bt.suggested_supplier_id   IS DISTINCT FROM tm.supplier_id
        OR bt.suggested_client_id     IS DISTINCT FROM tm.client_id
      )
    RETURNING bt.id, tm.rule_name
  `) as Record<string, unknown>[];

  return updated.map((row) => ({
    bankTxId: String(row.id), ruleName: String(row.rule_name), suggestion: true,
  }));
}
