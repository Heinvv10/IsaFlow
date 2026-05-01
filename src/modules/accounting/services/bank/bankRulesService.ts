/**
 * Bank Categorisation Rules Service — CRUD
 * Rule-matching and auto-application logic lives in bankRulesMatchingService.ts.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type {
  BankCategorisationRule, RuleCreateInput, RuleApplyResult,
} from '../../types/bank.types';

// Re-export matching function for backward compatibility
export type { RuleApplyResult };
export { applyRules } from './bankRulesMatchingService';

// ── CRUD ────────────────────────────────────────────────────────────────────

export async function getRules(companyId: string): Promise<BankCategorisationRule[]> {
  const rows = (await sql`
    SELECT r.*, ga.account_code AS gl_account_code, ga.account_name AS gl_account_name,
           s.company_name AS supplier_name, c.name AS client_name
    FROM bank_categorisation_rules r
    LEFT JOIN gl_accounts ga ON ga.id = r.gl_account_id
    LEFT JOIN suppliers s ON s.id = r.supplier_id
    LEFT JOIN customers c ON c.id = r.client_id
    WHERE r.company_id = ${companyId}::UUID
    ORDER BY r.priority ASC, r.rule_name ASC
  `) as Record<string, unknown>[];
  return rows.map(mapRuleRow);
}

export async function createRule(
  companyId: string,
  input: RuleCreateInput,
  userId: string
): Promise<BankCategorisationRule> {
  const vatCode = input.vatCode || 'none';
  const rows = (await sql`
    INSERT INTO bank_categorisation_rules (
      company_id, rule_name, match_field, match_type, match_pattern,
      gl_account_id, supplier_id, client_id, description_template,
      priority, auto_create_entry, vat_code, created_by
    ) VALUES (
      ${companyId}::UUID, ${input.ruleName}, ${input.matchField}, ${input.matchType}, ${input.matchPattern},
      ${input.glAccountId || null}::UUID, ${input.supplierId || null}::UUID,
      ${input.clientId || null}::UUID,
      ${input.descriptionTemplate || null},
      ${input.priority || 100}, ${input.autoCreateEntry === true}, ${vatCode}, ${userId}
    ) RETURNING *
  `) as Record<string, unknown>[];
  log.info('Created bank rule', { id: rows[0]!.id, ruleName: input.ruleName }, 'accounting');
  return mapRuleRow(rows[0]!);
}

export async function updateRule(
  companyId: string,
  id: string,
  input: Partial<RuleCreateInput> & { isActive?: boolean }
): Promise<BankCategorisationRule> {
  // Use ?? not || so legitimately-zero priorities and false booleans are not
  // dropped by COALESCE. Fields with min(1) (ruleName, matchPattern) and enums
  // can't be empty strings, so ?? matches the schema invariants.
  const rows = (await sql`
    UPDATE bank_categorisation_rules SET
      rule_name = COALESCE(${input.ruleName ?? null}, rule_name),
      match_field = COALESCE(${input.matchField ?? null}, match_field),
      match_type = COALESCE(${input.matchType ?? null}, match_type),
      match_pattern = COALESCE(${input.matchPattern ?? null}, match_pattern),
      gl_account_id = COALESCE(${input.glAccountId ?? null}::UUID, gl_account_id),
      supplier_id = COALESCE(${input.supplierId ?? null}::UUID, supplier_id),
      client_id = COALESCE(${input.clientId ?? null}::UUID, client_id),
      description_template = COALESCE(${input.descriptionTemplate ?? null}, description_template),
      priority = COALESCE(${input.priority ?? null}, priority),
      auto_create_entry = COALESCE(${input.autoCreateEntry ?? null}, auto_create_entry),
      vat_code = COALESCE(${input.vatCode ?? null}, vat_code),
      is_active = COALESCE(${input.isActive ?? null}, is_active)
    WHERE company_id = ${companyId}::UUID AND id = ${id}::UUID RETURNING *
  `) as Record<string, unknown>[];
  if (!rows[0]) throw new Error(`Rule ${id} not found`);
  return mapRuleRow(rows[0]);
}

export async function deleteRule(companyId: string, id: string): Promise<void> {
  await sql`DELETE FROM bank_categorisation_rules WHERE company_id = ${companyId}::UUID AND id = ${id}::UUID`;
}

export async function deleteRules(companyId: string, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const rows = await sql`
    DELETE FROM bank_categorisation_rules
    WHERE company_id = ${companyId}::UUID AND id = ANY(${ids}::UUID[])
    RETURNING id
  ` as { id: string }[];
  return rows.length;
}

export async function toggleRule(companyId: string, id: string, isActive: boolean): Promise<void> {
  await sql`
    UPDATE bank_categorisation_rules
    SET is_active = ${isActive}
    WHERE company_id = ${companyId}::UUID AND id = ${id}::UUID
  `;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function mapRuleRow(row: Record<string, unknown>): BankCategorisationRule {
  return {
    id: String(row.id),
    ruleName: String(row.rule_name),
    matchField: String(row.match_field) as BankCategorisationRule['matchField'],
    matchType: String(row.match_type) as BankCategorisationRule['matchType'],
    matchPattern: String(row.match_pattern ?? row.match_value ?? ''),
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
