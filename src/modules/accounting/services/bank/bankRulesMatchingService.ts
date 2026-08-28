/**
 * Bank Rules Matching Service
 * Rule-matching and auto-application logic for bank categorisation.
 * CRUD for rules lives in bankRulesService.ts.
 */

import { sql, withSavepoint } from '@/lib/neon';
import { log } from '@/lib/logger';
import { getSystemAccountId } from '../gl/systemAccountResolver';
import type { RuleApplyResult } from '../../types/bank.types';
import {
  toSqlPattern, findMatchingTxs, MAX_RULE_CANDIDATES, type RuleAllocType,
} from './bankRulesMatchingHelpers';
import { BankTransactionLockTimeoutError } from './bankTxLock';
import { autoPostRuleLine } from './bankRuleAutoPostLine';

export async function applyRules(
  companyId: string,
  bankAccountId: string,
  userId: string,
  ruleIds?: string[]
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

    // Auto-create JE mode — sequential (each transaction needs its own JE)
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
    // Counts of auto-post attempts skipped because the transaction date
    // can't be posted. Tracked separately because the remedies differ:
    //   - closedPeriod  → re-open the period (or accept that history is sealed)
    //   - noPeriod      → create the fiscal year so a covering period exists
    // Conflating them ("everything is closed") sent users in circles when
    // their periods were all open but the year hadn't been created.
    let autoPostSkippedClosedPeriod = 0;
    let autoPostSkippedNoPeriod = 0;
    let autoPostSkippedRaced = 0;
    let autoPostSkippedLocked = 0;
    let autoPostTruncatedRules = 0;
    for (const rule of (bankGlAccountId ? autoCreateRules : [])) {
      const pattern = toSqlPattern(String(rule.match_type), String(rule.match_pattern));
      const field = String(rule.match_field);
      const ruleName = String(rule.rule_name);
      const ruleGlAccountId = rule.gl_account_id ? String(rule.gl_account_id) : null;
      const ruleSupplierId = rule.supplier_id ? String(rule.supplier_id) : null;
      const ruleClientId = rule.client_id ? String(rule.client_id) : null;

      // Determine allocation shape from the rule. Account/bank rules use rule.gl_account_id
      // as the contra. Supplier rules post to AP, customer rules to AR (via systemAccountResolver).
      const allocType: RuleAllocType = ruleSupplierId ? 'supplier'
        : ruleClientId ? 'customer'
        : 'account';

      if (allocType === 'account' && !ruleGlAccountId) {
        log.warn('Skipping auto-create rule with no contra account', { ruleId: rule.id, ruleName }, 'accounting');
        continue;
      }

      const matchingTxs = await findMatchingTxs(companyId, bankAccountId, field, pattern);

      // Resolve AP/AR control accounts and entity names lazily (only when needed).
      let apAccountId: string | null = null;
      let arAccountId: string | null = null;
      let supplierName: string | null = null;
      let customerName: string | null = null;
      if (allocType === 'supplier' && ruleSupplierId) {
        apAccountId = await getSystemAccountId('payable', companyId);
        const supRows = (await sql`
          SELECT name FROM suppliers
          WHERE id = ${ruleSupplierId}::UUID AND company_id = ${companyId}::UUID
        `) as Record<string, unknown>[];
        supplierName = supRows[0]?.name ? String(supRows[0].name) : `Supplier #${ruleSupplierId}`;
      } else if (allocType === 'customer' && ruleClientId) {
        arAccountId = await getSystemAccountId('receivable', companyId);
        const custRows = (await sql`
          SELECT name FROM customers
          WHERE id = ${ruleClientId}::UUID AND company_id = ${companyId}::UUID
        `) as Record<string, unknown>[];
        customerName = custRows[0]?.name ? String(custRows[0].name) : `Customer #${ruleClientId}`;
      }

      // findMatchingTxs fetches one row past the cap; the extra row is the
      // signal that this rule matched more than one run may take.
      const capped = matchingTxs.slice(0, MAX_RULE_CANDIDATES);
      if (matchingTxs.length > MAX_RULE_CANDIDATES) autoPostTruncatedRules++;

      // Locked in id order, not the candidate query's date order: every
      // allocation path holds its row lock to the end of the request, so two
      // runs touching the same rows in opposite orders deadlock (40P01).
      const orderedTxs = [...capped].sort((a, b) => {
        const x = String(a.id), y = String(b.id);
        return x < y ? -1 : x > y ? 1 : 0;
      });

      for (const tx of orderedTxs) {
        let outcome;
        try {
          // Savepoint per line: a lock timeout is a REAL 55P03, which aborts
          // the transaction — without the savepoint the next candidate's
          // first statement raises 25P02 and the whole run dies after one skip.
          outcome = await withSavepoint('rule_autopost_line', () => autoPostRuleLine({
            companyId, userId, tx, rule, ruleName, allocType, ruleGlAccountId,
            bankGlAccountId: bankGlAccountId!, apAccountId, arAccountId,
            supplierName, customerName,
          }));
        } catch (lineErr) {
          // Another request is holding this row. One contended transaction must
          // not abort a run that has already posted for earlier ones — the
          // route's catch would 400 while withAuth still COMMITted them.
          // Counted and retryable; anything else is a real failure.
          if (!(lineErr instanceof BankTransactionLockTimeoutError)) throw lineErr;
          autoPostSkippedLocked++;
          continue;
        }
        if (outcome.kind === 'raced') { autoPostSkippedRaced++; continue; }
        if (outcome.kind === 'no_period') { autoPostSkippedNoPeriod++; continue; }
        if (outcome.kind === 'closed_period') { autoPostSkippedClosedPeriod++; continue; }

        entries.push({ bankTxId: String(tx.id), ruleName, journalEntryId: outcome.journalEntryId });
        totalApplied++;
      }
    }

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
      {
        bankAccountId,
        applied: totalApplied,
        skipped,
        autoPostRulesSkippedNoBankGl,
        autoPostSkippedClosedPeriod,
        autoPostSkippedNoPeriod,
        autoPostSkippedRaced,
        autoPostSkippedLocked,
        autoPostTruncatedRules,
      },
      'accounting',
    );
    return {
      applied: totalApplied,
      skipped,
      entries,
      autoPostRulesSkippedNoBankGl,
      autoPostSkippedClosedPeriod,
      autoPostSkippedNoPeriod,
      autoPostSkippedRaced,
      autoPostSkippedLocked,
      autoPostTruncatedRules,
    };
  } catch (err) {
    log.error('Failed to apply bank rules', { error: err }, 'accounting');
    throw err;
  }
}
