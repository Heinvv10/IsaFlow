/**
 * Bank Rules Matching Service
 * Rule-matching and auto-application logic for bank categorisation.
 * CRUD for rules lives in bankRulesService.ts.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { RuleApplyResult } from '../../types/bank.types';
import { sweepAutoPostRules, emptyAutoPostCounters } from './bankRulesAutoPostSweep';

export interface ApplyRulesOptions {
  /**
   * `false` runs the suggestion rules only and never the auto-post sweep. For
   * a caller with no control principal (`extension-ingest` under
   * `withExtensionToken`): the controlled allocation would refuse its first
   * line, and a refusal it can never clear must be stated, not discovered.
   */
  autoPost?: boolean;
}

export async function applyRules(
  companyId: string,
  bankAccountId: string,
  userId: string,
  ruleIds?: string[],
  options: ApplyRulesOptions = {},
): Promise<RuleApplyResult> {
  try {
    const rules = ruleIds && ruleIds.length > 0
      ? (await sql`
          SELECT * FROM bank_categorisation_rules
          WHERE company_id = ${companyId}::UUID
            AND is_active = true
            AND id = ANY(${ruleIds}::UUID[])
          ORDER BY priority ASC
        `) as Record<string, unknown>[]
      : (await sql`
          SELECT * FROM bank_categorisation_rules
          WHERE company_id = ${companyId}::UUID AND is_active = true
          ORDER BY priority ASC
        `) as Record<string, unknown>[];

    if (rules.length === 0) return { applied: 0, skipped: 0, entries: [] };

    // bank_transactions.bank_account_id is an FK to gl_accounts(id) — the
    // "bank account" the user picked is a GL account with account_subtype='bank'.
    // The earlier code looked up bank_accounts.gl_account_id, which is a
    // separate OAuth-bank-feed registry and is empty for almost every tenant,
    // so auto-post rules silently skipped because bankGlAccountId came back
    // null. Use the bank account id directly (it IS the GL account id) and
    // verify the row exists + is bank-subtype.
    const bankAccRows = (await sql`
      SELECT id FROM gl_accounts
      WHERE id = ${bankAccountId}::UUID
        AND company_id = ${companyId}::UUID
        AND account_subtype = 'bank'
    `) as Record<string, unknown>[];
    const bankGlAccountId = bankAccRows[0]?.id ? String(bankAccRows[0].id) : null;

    let totalApplied = 0;
    const entries: RuleApplyResult['entries'] = [];

    const autoCreateRules = rules.filter((r: Record<string, unknown>) => Boolean(r.auto_create_entry));
    const hasSuggestionRules = rules.some((r: Record<string, unknown>) => !r.auto_create_entry);

    if (hasSuggestionRules) {
      // Match every still-imported transaction against every active suggestion-mode
      // rule, then keep the highest-priority match per transaction. We deliberately
      // overwrite any existing suggestion: a freshly-created or higher-priority rule
      // should take precedence over a stale AI suggestion or earlier rule hit.
      const suggestionRuleIds = rules
        .filter((r: Record<string, unknown>) => !r.auto_create_entry)
        .map((r: Record<string, unknown>) => String(r.id));
      const updated = (await sql`
        WITH matched AS (
          SELECT
            bt.id                                              AS tx_id,
            r.gl_account_id,
            r.supplier_id,
            r.client_id,
            r.rule_name,
            r.vat_code,
            ROW_NUMBER() OVER (PARTITION BY bt.id ORDER BY r.priority ASC) AS rn
          FROM bank_transactions bt
          JOIN bank_categorisation_rules r ON (
            r.company_id = ${companyId}::UUID
            AND r.is_active = true
            AND r.auto_create_entry = false
            AND r.id = ANY(${suggestionRuleIds}::UUID[])
            AND (
              (r.match_field IN ('description', 'both')
                AND bt.description ILIKE
                  CASE r.match_type
                    WHEN 'contains'    THEN '%' || r.match_pattern || '%'
                    WHEN 'starts_with' THEN        r.match_pattern || '%'
                    WHEN 'ends_with'   THEN '%' || r.match_pattern
                    ELSE                           r.match_pattern
                  END)
              OR
              (r.match_field IN ('reference', 'both')
                AND bt.reference ILIKE
                  CASE r.match_type
                    WHEN 'contains'    THEN '%' || r.match_pattern || '%'
                    WHEN 'starts_with' THEN        r.match_pattern || '%'
                    WHEN 'ends_with'   THEN '%' || r.match_pattern
                    ELSE                           r.match_pattern
                  END)
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

      for (const row of updated) {
        entries.push({ bankTxId: String(row.id), ruleName: String(row.rule_name), suggestion: true });
      }
      totalApplied += updated.length;
    }

    // Auto-create mode — one controlled allocation per matched line.
    const autoPostRulesSkippedNoBankGl = (autoCreateRules.length > 0 && !bankGlAccountId)
      ? autoCreateRules.length
      : 0;
    if (autoPostRulesSkippedNoBankGl > 0) {
      log.warn(
        'Bank account is not a valid bank-subtype GL account — skipping auto-post rules',
        { bankAccountId, skippedRules: autoPostRulesSkippedNoBankGl },
        'accounting',
      );
    }
    // A fault inside the sweep (a pg error, a coding defect, a poisoned request)
    // propagates from here: every caller lets it reach withErrorHandler as a
    // 500, so withAuth rolls the request back rather than committing the lines
    // posted before it and reporting a partial run as a result.
    const sweep = bankGlAccountId && autoCreateRules.length > 0 && options.autoPost !== false
      ? await sweepAutoPostRules(companyId, bankAccountId, userId, autoCreateRules)
      : { entries: [], applied: 0, counters: emptyAutoPostCounters() };
    entries.push(...sweep.entries);
    totalApplied += sweep.applied;

    const remaining = (await sql`
      SELECT COUNT(*) AS cnt FROM bank_transactions
      WHERE bank_account_id = ${bankAccountId}::UUID
        AND company_id = ${companyId}::UUID
        AND status = 'imported'
        AND matched_journal_line_id IS NULL
        AND suggested_gl_account_id IS NULL
        AND suggested_supplier_id IS NULL
        AND suggested_client_id IS NULL
    `) as Record<string, unknown>[];
    const skipped = Number(remaining[0]?.cnt ?? 0);

    log.info(
      'Applied bank rules',
      { bankAccountId, applied: totalApplied, skipped, autoPostRulesSkippedNoBankGl, ...sweep.counters },
      'accounting',
    );
    return {
      applied: totalApplied,
      skipped,
      entries,
      autoPostRulesSkippedNoBankGl,
      ...sweep.counters,
    };
  } catch (err) {
    log.error('Failed to apply bank rules', { error: err }, 'accounting');
    throw err;
  }
}
