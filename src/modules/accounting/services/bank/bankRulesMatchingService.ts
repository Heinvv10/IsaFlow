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
import type { JournalLineInput } from '../../types/gl.types';

/** Convert rule match type to SQL ILIKE pattern */
function toSqlPattern(matchType: string, matchPattern: string): string {
  switch (matchType) {
    case 'contains':    return `%${matchPattern}%`;
    case 'starts_with': return `${matchPattern}%`;
    case 'ends_with':   return `%${matchPattern}`;
    case 'exact':       return matchPattern;
    default:            return `%${matchPattern}%`;
  }
}

export async function applyRules(
  companyId: string,
  bankAccountId: string,
  userId: string
): Promise<RuleApplyResult> {
  try {
    const rules = (await sql`
      SELECT * FROM bank_categorisation_rules
      WHERE company_id = ${companyId}::UUID AND is_active = true
      ORDER BY priority ASC
    `) as Record<string, unknown>[];

    if (rules.length === 0) return { applied: 0, skipped: 0, entries: [] };

    // Look up the bank account's linked GL account for journal entries
    const bankAccRows = (await sql`
      SELECT gl_account_id FROM bank_accounts
      WHERE id = ${bankAccountId}::UUID AND company_id = ${companyId}::UUID
    `) as Record<string, unknown>[];
    const bankGlAccountId = bankAccRows[0]?.gl_account_id ? String(bankAccRows[0].gl_account_id) : null;

    let totalApplied = 0;
    const entries: RuleApplyResult['entries'] = [];

    const autoCreateRules = rules.filter((r: Record<string, unknown>) => Boolean(r.auto_create_entry));
    const hasSuggestionRules = rules.some((r: Record<string, unknown>) => !r.auto_create_entry);

    if (hasSuggestionRules) {
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
            AND bt.status IN ('imported', 'allocated')
            AND bt.suggested_gl_account_id IS NULL
            AND bt.suggested_supplier_id IS NULL
            AND bt.suggested_client_id IS NULL
            AND bt.suggested_category IS NULL
        ),
        top_match AS (SELECT * FROM matched WHERE rn = 1)
        UPDATE bank_transactions bt
        SET
          suggested_gl_account_id = tm.gl_account_id,
          suggested_supplier_id   = tm.supplier_id,
          suggested_client_id     = tm.client_id,
          suggested_category      = tm.rule_name,
          suggested_vat_code      = COALESCE(tm.vat_code, 'none')
        FROM top_match tm
        WHERE bt.id = tm.tx_id
        RETURNING bt.id, tm.rule_name
      `) as Record<string, unknown>[];

      for (const row of updated) {
        entries.push({ bankTxId: String(row.id), ruleName: String(row.rule_name), suggestion: true });
      }
      totalApplied += updated.length;

      await sql`
        UPDATE bank_transactions bt
        SET suggested_vat_code = r.vat_code
        FROM (
          SELECT DISTINCT ON (rule_name) rule_name, vat_code
          FROM bank_categorisation_rules
          WHERE company_id = ${companyId}::UUID AND is_active = true AND vat_code != 'none'
          ORDER BY rule_name, priority ASC
        ) r
        WHERE bt.bank_account_id = ${bankAccountId}::UUID
          AND bt.status IN ('imported', 'allocated')
          AND bt.suggested_category = r.rule_name
          AND bt.suggested_vat_code = 'none'
      `;
    }

    // Auto-create JE mode — sequential (each transaction needs its own JE)
    if (autoCreateRules.length > 0 && !bankGlAccountId) {
      log.warn('Bank account has no linked GL account — skipping auto-create rules', { bankAccountId }, 'accounting');
    }
    for (const rule of (bankGlAccountId ? autoCreateRules : [])) {
      const pattern = toSqlPattern(String(rule.match_type), String(rule.match_pattern));
      const field = String(rule.match_field);
      const ruleName = String(rule.rule_name);

      let matchingTxs: Record<string, unknown>[];
      if (field === 'description') {
        matchingTxs = (await sql`
          SELECT id, amount, transaction_date, description
          FROM bank_transactions
          WHERE bank_account_id = ${bankAccountId}::UUID
            AND company_id = ${companyId}::UUID
            AND status IN ('imported', 'allocated')
            AND matched_journal_line_id IS NULL
            AND description ILIKE ${pattern}
          ORDER BY transaction_date
        `) as Record<string, unknown>[];
      } else if (field === 'reference') {
        matchingTxs = (await sql`
          SELECT id, amount, transaction_date, description, reference
          FROM bank_transactions
          WHERE bank_account_id = ${bankAccountId}::UUID
            AND company_id = ${companyId}::UUID
            AND status IN ('imported', 'allocated')
            AND matched_journal_line_id IS NULL
            AND reference ILIKE ${pattern}
          ORDER BY transaction_date
        `) as Record<string, unknown>[];
      } else {
        matchingTxs = (await sql`
          SELECT id, amount, transaction_date, description, reference
          FROM bank_transactions
          WHERE bank_account_id = ${bankAccountId}::UUID
            AND company_id = ${companyId}::UUID
            AND status IN ('imported', 'allocated')
            AND matched_journal_line_id IS NULL
            AND (description ILIKE ${pattern} OR reference ILIKE ${pattern})
          ORDER BY transaction_date
        `) as Record<string, unknown>[];
      }

      for (const tx of matchingTxs) {
        const totalAmount = Math.abs(Number(tx.amount));
        const isDeposit = Number(tx.amount) > 0;
        const entryDesc = rule.description_template
          ? String(rule.description_template)
              .replace('{description}', String(tx.description || ''))
              .replace('{amount}', totalAmount.toFixed(2))
          : `Bank: ${tx.description || 'Categorised by rule'}`;

        const vatCode = String(rule.vat_code || 'none');
        const hasVat = vatCode === 'standard';
        const netAmount = hasVat ? Math.round((totalAmount * 100 / 115) * 100) / 100 : totalAmount;
        const vatAmount = hasVat ? Math.round((totalAmount - netAmount) * 100) / 100 : 0;
        const vatAccountKey = isDeposit ? 'vat_output' as const : 'vat_input' as const;
        const mapVatType = vatCode === 'standard' ? 'standard' as const
          : vatCode === 'zero_rated' ? 'zero_rated' as const
          : vatCode === 'exempt' ? 'exempt' as const
          : undefined;

        let lines: JournalLineInput[];
        if (isDeposit) {
          lines = [
            { glAccountId: bankGlAccountId!, debit: totalAmount, credit: 0, description: entryDesc },
            { glAccountId: String(rule.gl_account_id), debit: 0, credit: netAmount, description: entryDesc, vatType: mapVatType },
          ];
          if (hasVat) {
            const vatAcctId = await getSystemAccountId(vatAccountKey, companyId);
            lines.splice(1, 0, { glAccountId: vatAcctId, debit: 0, credit: vatAmount, description: `VAT @ 15%`, vatType: 'standard' });
          }
        } else {
          lines = [
            { glAccountId: String(rule.gl_account_id), debit: netAmount, credit: 0, description: entryDesc, vatType: mapVatType },
            { glAccountId: bankGlAccountId!, debit: 0, credit: totalAmount, description: entryDesc },
          ];
          if (hasVat) {
            const vatAcctId = await getSystemAccountId(vatAccountKey, companyId);
            lines.splice(1, 0, { glAccountId: vatAcctId, debit: vatAmount, credit: 0, description: `VAT @ 15%`, vatType: 'standard' });
          }
        }

        const je = await createJournalEntry(companyId, {
          entryDate: tx.transaction_date instanceof Date
            ? tx.transaction_date.toISOString().split('T')[0]!
            : String(tx.transaction_date).split('T')[0]!,
          description: entryDesc,
          source: 'auto_bank_recon',
          lines,
        }, userId);
        await postJournalEntry(companyId, je.id, userId);

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
                allocation_type = 'account',
                allocated_entity_name = ${ruleName},
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
        AND status IN ('imported', 'allocated')
        AND suggested_gl_account_id IS NULL
        AND matched_journal_line_id IS NULL
    `) as Record<string, unknown>[];
    const skipped = Number(remaining[0]?.cnt ?? 0);

    log.info('Applied bank rules', { bankAccountId, applied: totalApplied, skipped }, 'accounting');
    return { applied: totalApplied, skipped, entries };
  } catch (err) {
    log.error('Failed to apply bank rules', { error: err }, 'accounting');
    throw err;
  }
}
