/**
 * Phase 2: Bank Categorisation Rules Service
 * Quick entry rules + statement mapping for auto-categorisation
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { createJournalEntry, postJournalEntry } from './journalEntryService';
import type {
  BankCategorisationRule, RuleCreateInput, RuleApplyResult,
} from '../types/bank.types';
import type { JournalLineInput } from '../types/gl.types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

// ── CRUD ────────────────────────────────────────────────────────────────────

export async function getRules(_companyId: string): Promise<BankCategorisationRule[]> {
  const rows = (await sql`
    SELECT r.*, ga.account_code AS gl_account_code, ga.account_name AS gl_account_name,
           s.company_name AS supplier_name, c.company_name AS client_name
    FROM bank_categorisation_rules r
    LEFT JOIN gl_accounts ga ON ga.id = r.gl_account_id
    LEFT JOIN suppliers s ON s.id = r.supplier_id
    LEFT JOIN clients c ON c.id = r.client_id
    ORDER BY r.priority ASC, r.rule_name ASC
  `) as Row[];
  return rows.map(mapRuleRow);
}

export async function createRule(_companyId: string, input: RuleCreateInput, userId: string): Promise<BankCategorisationRule> {
  const vatCode = input.vatCode || 'none';
  const rows = (await sql`
    INSERT INTO bank_categorisation_rules (
      rule_name, match_field, match_type, match_pattern,
      gl_account_id, supplier_id, client_id, description_template,
      priority, auto_create_entry, vat_code, created_by
    ) VALUES (
      ${input.ruleName}, ${input.matchField}, ${input.matchType}, ${input.matchPattern},
      ${input.glAccountId || null}::UUID, ${input.supplierId ? Number(input.supplierId) : null},
      ${input.clientId || null}::UUID,
      ${input.descriptionTemplate || null},
      ${input.priority || 100}, ${input.autoCreateEntry !== false}, ${vatCode}, ${userId}::UUID
    ) RETURNING *
  `) as Row[];
  log.info('Created bank rule', { id: rows[0].id, ruleName: input.ruleName }, 'accounting');
  return mapRuleRow(rows[0]);
}

export async function updateRule(_companyId: string, id: string, input: Partial<RuleCreateInput>): Promise<BankCategorisationRule> {
  const rows = (await sql`
    UPDATE bank_categorisation_rules SET
      rule_name = COALESCE(${input.ruleName || null}, rule_name),
      match_field = COALESCE(${input.matchField || null}, match_field),
      match_type = COALESCE(${input.matchType || null}, match_type),
      match_pattern = COALESCE(${input.matchPattern || null}, match_pattern),
      gl_account_id = COALESCE(${input.glAccountId || null}::UUID, gl_account_id),
      supplier_id = COALESCE(${input.supplierId ? Number(input.supplierId) : null}, supplier_id),
      client_id = COALESCE(${input.clientId || null}::UUID, client_id),
      description_template = COALESCE(${input.descriptionTemplate || null}, description_template),
      priority = COALESCE(${input.priority || null}, priority),
      auto_create_entry = COALESCE(${input.autoCreateEntry ?? null}, auto_create_entry),
      vat_code = COALESCE(${input.vatCode || null}, vat_code)
    WHERE id = ${id}::UUID RETURNING *
  `) as Row[];
  if (!rows[0]) throw new Error(`Rule ${id} not found`);
  return mapRuleRow(rows[0]);
}

export async function deleteRule(_companyId: string, id: string): Promise<void> {
  await sql`DELETE FROM bank_categorisation_rules WHERE id = ${id}::UUID`;
}

export async function deleteRules(_companyId: string, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const rows = await sql`
    DELETE FROM bank_categorisation_rules
    WHERE id = ANY(${ids}::UUID[])
    RETURNING id
  ` as { id: string }[];
  return rows.length;
}

export async function toggleRule(_companyId: string, id: string, isActive: boolean): Promise<void> {
  await sql`UPDATE bank_categorisation_rules SET is_active = ${isActive} WHERE id = ${id}::UUID`;
}

// ── Apply Rules ─────────────────────────────────────────────────────────────

/** Lookup a GL account UUID by account code */
async function glAccountByCode(code: string): Promise<string> {
  const rows = (await sql`
    SELECT id FROM gl_accounts WHERE account_code = ${code} AND is_active = TRUE LIMIT 1
  `) as Row[];
  if (rows.length === 0) throw new Error(`GL account ${code} not found`);
  return String(rows[0].id);
}

/** Convert rule match type to SQL ILIKE pattern */
function toSqlPattern(matchType: string, matchPattern: string): string {
  switch (matchType) {
    case 'contains': return `%${matchPattern}%`;
    case 'starts_with': return `${matchPattern}%`;
    case 'ends_with': return `%${matchPattern}`;
    case 'exact': return matchPattern;
    default: return `%${matchPattern}%`;
  }
}

export async function applyRules(_companyId: string, 
  bankAccountId: string,
  userId: string
): Promise<RuleApplyResult> {
  try {
    // Get active rules ordered by priority
    const rules = (await sql`
      SELECT * FROM bank_categorisation_rules
      WHERE is_active = true
      ORDER BY priority ASC
    `) as Row[];

    if (rules.length === 0) return { applied: 0, skipped: 0, entries: [] };

    let totalApplied = 0;
    const entries: RuleApplyResult['entries'] = [];

    const autoCreateRules = rules.filter((r: Row) => Boolean(r.auto_create_entry));
    const hasSuggestionRules = rules.some((r: Row) => !r.auto_create_entry);

    if (hasSuggestionRules) {
      // Single-query approach: JOIN all suggestion-mode rules against all unmatched
      // transactions in one CTE, assign the highest-priority matching rule per tx.
      // ILIKE patterns are generated inline using CASE on match_type column —
      // one network round-trip to Neon regardless of rule count.
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
            r.is_active = true
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
      `) as Row[];

      for (const row of updated) {
        entries.push({ bankTxId: String(row.id), ruleName: String(row.rule_name), suggestion: true });
      }
      totalApplied += updated.length;

      // Backfill vat_code for already-suggested transactions (suggested before the vat_code column existed)
      await sql`
        UPDATE bank_transactions bt
        SET suggested_vat_code = r.vat_code
        FROM (
          SELECT DISTINCT ON (rule_name) rule_name, vat_code
          FROM bank_categorisation_rules
          WHERE is_active = true AND vat_code != 'none'
          ORDER BY rule_name, priority ASC
        ) r
        WHERE bt.bank_account_id = ${bankAccountId}::UUID
          AND bt.status IN ('imported', 'allocated')
          AND bt.suggested_category = r.rule_name
          AND bt.suggested_vat_code = 'none'
      `;
    }

    // Auto-create JE mode — sequential (each transaction needs its own JE)
    for (const rule of autoCreateRules) {
      const pattern = toSqlPattern(String(rule.match_type), String(rule.match_pattern));
      const field = String(rule.match_field);
      const ruleName = String(rule.rule_name);

      let matchingTxs: Row[];
      if (field === 'description') {
        matchingTxs = (await sql`
          SELECT id, amount, transaction_date, description
          FROM bank_transactions
          WHERE bank_account_id = ${bankAccountId}::UUID
            AND status IN ('imported', 'allocated')
            AND matched_journal_line_id IS NULL
            AND description ILIKE ${pattern}
          ORDER BY transaction_date
        `) as Row[];
      } else if (field === 'reference') {
        matchingTxs = (await sql`
          SELECT id, amount, transaction_date, description, reference
          FROM bank_transactions
          WHERE bank_account_id = ${bankAccountId}::UUID
            AND status IN ('imported', 'allocated')
            AND matched_journal_line_id IS NULL
            AND reference ILIKE ${pattern}
          ORDER BY transaction_date
        `) as Row[];
      } else {
        matchingTxs = (await sql`
          SELECT id, amount, transaction_date, description, reference
          FROM bank_transactions
          WHERE bank_account_id = ${bankAccountId}::UUID
            AND status IN ('imported', 'allocated')
            AND matched_journal_line_id IS NULL
            AND (description ILIKE ${pattern} OR reference ILIKE ${pattern})
          ORDER BY transaction_date
        `) as Row[];
      }

      for (const tx of matchingTxs) {
        const totalAmount = Math.abs(Number(tx.amount));
        const isDeposit = Number(tx.amount) > 0;
        const entryDesc = rule.description_template
          ? String(rule.description_template).replace('{description}', String(tx.description || '')).replace('{amount}', totalAmount.toFixed(2))
          : `Bank: ${tx.description || 'Categorised by rule'}`;

        // VAT splitting — mirrors allocateTransaction logic
        const vatCode = String(rule.vat_code || 'none');
        const hasVat = vatCode === 'standard';
        const netAmount = hasVat ? Math.round((totalAmount * 100 / 115) * 100) / 100 : totalAmount;
        const vatAmount = hasVat ? Math.round((totalAmount - netAmount) * 100) / 100 : 0;
        const vatAccountCode = isDeposit ? '2120' : '1140';
        const mapVatType = vatCode === 'standard' ? 'standard' as const
          : vatCode === 'zero_rated' ? 'zero_rated' as const
          : vatCode === 'exempt' ? 'exempt' as const
          : undefined;

        let lines: JournalLineInput[];
        if (isDeposit) {
          lines = [
            { glAccountId: bankAccountId, debit: totalAmount, credit: 0, description: entryDesc },
            { glAccountId: String(rule.gl_account_id), debit: 0, credit: netAmount, description: entryDesc, vatType: mapVatType },
          ];
          if (hasVat) {
            const vatAcctId = await glAccountByCode(vatAccountCode);
            lines.splice(1, 0, { glAccountId: vatAcctId, debit: 0, credit: vatAmount, description: `VAT @ 15%`, vatType: 'standard' });
          }
        } else {
          lines = [
            { glAccountId: String(rule.gl_account_id), debit: netAmount, credit: 0, description: entryDesc, vatType: mapVatType },
            { glAccountId: bankAccountId, debit: 0, credit: totalAmount, description: entryDesc },
          ];
          if (hasVat) {
            const vatAcctId = await glAccountByCode(vatAccountCode);
            lines.splice(1, 0, { glAccountId: vatAcctId, debit: vatAmount, credit: 0, description: `VAT @ 15%`, vatType: 'standard' });
          }
        }

        const je = await createJournalEntry(_companyId, {
          entryDate: tx.transaction_date instanceof Date
            ? tx.transaction_date.toISOString().split('T')[0]
            : String(tx.transaction_date).split('T')[0],
          description: entryDesc,
          source: 'auto_bank_recon',
          lines,
        }, userId);
        await postJournalEntry('', je.id, userId);

        const bankLineRows = (await sql`
          SELECT id FROM gl_journal_lines
          WHERE journal_entry_id = ${je.id}::UUID AND gl_account_id = ${bankAccountId}::UUID
          LIMIT 1
        `) as Row[];

        if (bankLineRows[0]) {
          await sql`
            UPDATE bank_transactions
            SET status = 'allocated', matched_journal_line_id = ${bankLineRows[0].id}::UUID,
                allocation_type = 'account',
                allocated_entity_name = ${ruleName},
                updated_at = NOW()
            WHERE id = ${tx.id}::UUID
          `;
        }

        entries.push({ bankTxId: String(tx.id), ruleName, journalEntryId: je.id });
        totalApplied++;
      }
    }

    // Count remaining unmatched for the skipped total
    const remaining = (await sql`
      SELECT COUNT(*) AS cnt FROM bank_transactions
      WHERE bank_account_id = ${bankAccountId}::UUID
        AND status IN ('imported', 'allocated')
        AND suggested_gl_account_id IS NULL
        AND matched_journal_line_id IS NULL
    `) as Row[];
    const skipped = Number(remaining[0].cnt);

    log.info('Applied bank rules', { bankAccountId, applied: totalApplied, skipped }, 'accounting');
    return { applied: totalApplied, skipped, entries };
  } catch (err) {
    log.error('Failed to apply bank rules', { error: err }, 'accounting');
    throw err;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function mapRuleRow(row: Row): BankCategorisationRule {
  return {
    id: String(row.id),
    ruleName: String(row.rule_name),
    matchField: String(row.match_field) as BankCategorisationRule['matchField'],
    matchType: String(row.match_type) as BankCategorisationRule['matchType'],
    matchPattern: String(row.match_pattern),
    glAccountId: row.gl_account_id ? String(row.gl_account_id) : undefined,
    supplierId: row.supplier_id ? String(row.supplier_id) : undefined,
    clientId: row.client_id ? String(row.client_id) : undefined,
    descriptionTemplate: row.description_template ? String(row.description_template) : undefined,
    priority: Number(row.priority),
    isActive: Boolean(row.is_active),
    autoCreateEntry: Boolean(row.auto_create_entry),
    vatCode: (row.vat_code || 'none') as BankCategorisationRule['vatCode'],
    createdBy: row.created_by ? String(row.created_by) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    glAccountCode: row.gl_account_code ? String(row.gl_account_code) : undefined,
    glAccountName: row.gl_account_name ? String(row.gl_account_name) : undefined,
    supplierName: row.supplier_name ? String(row.supplier_name) : undefined,
    clientName: row.client_name ? String(row.client_name) : undefined,
  };
}
