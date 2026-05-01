/**
 * Bank Rules Matching Service
 * Rule-matching and auto-application logic for bank categorisation.
 * CRUD for rules lives in bankRulesService.ts.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { createJournalEntry, postJournalEntry } from '../gl/journalEntryService';
import { getSystemAccountId } from '../gl/systemAccountResolver';
import type { RuleApplyResult } from '../../types/bank.types';
import {
  toSqlPattern, findMatchingTxs, buildAutoCreateLines, type RuleAllocType,
} from './bankRulesMatchingHelpers';

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
    // Count of auto-post attempts that failed because the transaction date
    // falls in a closed/locked fiscal period. We swallow the error per-tx so
    // one bad date doesn't abort the whole apply, then surface the total
    // count in the result so the UI can warn the user.
    let autoPostSkippedClosedPeriod = 0;
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

      for (const tx of matchingTxs) {
        const totalAmount = Math.abs(Number(tx.amount));
        const isDeposit = Number(tx.amount) > 0;
        const entryDesc = rule.description_template
          ? String(rule.description_template)
              .replace('{description}', String(tx.description || ''))
              .replace('{amount}', totalAmount.toFixed(2))
          : allocType === 'supplier' ? `Payment to ${supplierName}`
          : allocType === 'customer' ? `Receipt from ${customerName}`
          : `Bank: ${tx.description || 'Categorised by rule'}`;

        const vatCode = String(rule.vat_code || 'none');
        const hasVat = vatCode === 'standard';
        const netAmount = hasVat ? Math.round((totalAmount * 100 / 115) * 100) / 100 : totalAmount;
        const vatAmount = hasVat ? Math.round((totalAmount - netAmount) * 100) / 100 : 0;
        // Supplier payment is a money-out from this bank → vat_input on the AP side.
        // Customer receipt is a money-in to this bank → vat_output on the AR side.
        const vatAccountKey: 'vat_input' | 'vat_output' = allocType === 'supplier' ? 'vat_input'
          : allocType === 'customer' ? 'vat_output'
          : (isDeposit ? 'vat_output' : 'vat_input');
        const mapVatType = vatCode === 'standard' ? 'standard' as const
          : vatCode === 'zero_rated' ? 'zero_rated' as const
          : vatCode === 'exempt' ? 'exempt' as const
          : undefined;

        const source: import('../../types/gl.types').GLEntrySource = allocType === 'supplier'
          ? 'auto_supplier_payment'
          : allocType === 'customer'
          ? 'auto_payment'
          : 'auto_bank_recon';
        const allocEntityName = allocType === 'supplier' ? supplierName!
          : allocType === 'customer' ? customerName!
          : ruleName;

        const lines = await buildAutoCreateLines({
          allocType, totalAmount, netAmount, vatAmount, hasVat, vatAccountKey,
          vatType: mapVatType, isDeposit,
          bankGlAccountId: bankGlAccountId!, ruleGlAccountId, apAccountId, arAccountId,
          entryDesc, companyId,
        });

        let je: Awaited<ReturnType<typeof createJournalEntry>>;
        try {
          je = await createJournalEntry(companyId, {
            entryDate: tx.transaction_date instanceof Date
              ? tx.transaction_date.toISOString().split('T')[0]!
              : String(tx.transaction_date).split('T')[0]!,
            description: entryDesc,
            source,
            lines,
          }, userId);
          await postJournalEntry(companyId, je.id, userId);
        } catch (err) {
          // Closed/locked fiscal period is the expected failure for historical
          // transactions; count it and move on instead of aborting the whole
          // apply. Anything else re-throws.
          const msg = err instanceof Error ? err.message : String(err);
          if (/closed fiscal period|locked fiscal period|no fiscal period/i.test(msg)) {
            autoPostSkippedClosedPeriod++;
            continue;
          }
          throw err;
        }

        const bankLineRows = (await sql`
          SELECT jl.id FROM gl_journal_lines jl
          WHERE jl.journal_entry_id = ${je.id}::UUID AND jl.gl_account_id = ${bankGlAccountId}::UUID
            AND jl.company_id = ${companyId}::UUID
          LIMIT 1
        `) as Record<string, unknown>[];

        if (bankLineRows[0]) {
          await sql`
            UPDATE bank_transactions
            SET status = 'allocated', matched_journal_line_id = ${bankLineRows[0].id}::UUID,
                allocation_type = ${allocType},
                allocated_entity_name = ${allocEntityName},
                suggested_gl_account_id = NULL,
                suggested_supplier_id = NULL,
                suggested_client_id = NULL,
                suggested_category = NULL,
                suggested_vat_code = NULL,
                updated_at = NOW()
            WHERE id = ${tx.id}::UUID AND company_id = ${companyId}::UUID
          `;
        }

        entries.push({ bankTxId: String(tx.id), ruleName, journalEntryId: je.id });
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
      },
      'accounting',
    );
    return {
      applied: totalApplied,
      skipped,
      entries,
      autoPostRulesSkippedNoBankGl,
      autoPostSkippedClosedPeriod,
    };
  } catch (err) {
    log.error('Failed to apply bank rules', { error: err }, 'accounting');
    throw err;
  }
}
