/**
 * Bank Categorisation Rules Service — CRUD
 * Rule-matching and auto-application logic lives in bankRulesMatchingService.ts.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { assertCustomerInCompany, assertSupplierInCompany } from '../core/contactDirectoryService';
import {
  AUTO_APPLY_MODES, DEFAULT_AUTO_APPLY, parseAutoApplyMode, type AutoApplyMode,
} from '../shared/autoAllocateStrategy';
import type {
  BankCategorisationRule, RuleCreateInput, RuleApplyResult,
} from '../../types/bank.types';
import { removeRules, writeNewRule, writeRuleChange, type HeldRuleChange, type RuleWrite } from './bankRuleChangeControl';
import { assertNotContactControl } from './contactControlGuard';

// Re-export matching function for backward compatibility
export type { RuleApplyResult, HeldRuleChange };

/**
 * A rule write's outcome (forensic-controls step 2): the rule as written, or,
 * under the `bank_rule` switch, a change HELD for another person's approval
 * (nothing applied) — bankRuleChangeControl.ts decides which.
 */
export type RuleOutcome = (BankCategorisationRule & { status: 'applied' }) | HeldRuleChange;
const outcome = (w: RuleWrite): RuleOutcome => (w.status === 'applied' ? { ...mapRuleRow(w.row), status: 'applied' } : w);
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
): Promise<RuleOutcome> {
  // R-067: the rule's client_id is copied onto every matching bank line as
  // suggested_client_id, and both are read back with the customer name joined.
  await assertCustomerInCompany(companyId, input.clientId);
  // R-068: the (supplier_id, company_id) FK already refuses a foreign supplier,
  // but as a 23503 mid-statement; this refuses it typed, before the INSERT.
  await assertSupplierInCompany(companyId, input.supplierId);
  // An account rule may not target AP/AR control: its auto-post would move the control with no document
  // (contactControlGuard). A rule that names a supplier or customer posts there properly, with the document.
  if (!input.supplierId && !input.clientId) {
    await assertNotContactControl(companyId, input.glAccountId, `Rule "${input.ruleName}"`, 'rule');
  }
  const vatCode = input.vatCode || 'none';
  // Refused, never coerced: a typo'd mode silently becoming 'fifo' would have
  // an unattended sweep apply cash the rule's author asked to leave on account.
  //
  // `?? DEFAULT_AUTO_APPLY` and NOT `undefined`: the column is NOT NULL with a
  // DEFAULT, and a parameter bound as undefined reaches pg as an explicit NULL.
  // An explicit NULL in an INSERT's column list does NOT take the column
  // default — it violates the NOT NULL and raises 23502 — so binding undefined
  // failed EVERY rule creation that did not name a mode, which is the normal
  // case from the UI. A mocked-sql unit test cannot see this; the DB-gated one
  // in tests/unit/services/bank/bankRuleAutoApplyDb.test.ts can.
  const autoApply = assertAutoApply(input.autoApply) ?? DEFAULT_AUTO_APPLY;
  const written = outcome(await writeNewRule(companyId, {
    rule_name: input.ruleName, match_field: input.matchField, match_type: input.matchType, match_pattern: input.matchPattern,
    gl_account_id: input.glAccountId || null, supplier_id: input.supplierId || null, client_id: input.clientId || null,
    description_template: input.descriptionTemplate || null, priority: input.priority || 100,
    auto_create_entry: input.autoCreateEntry === true, vat_code: vatCode, auto_apply: autoApply,
  }, userId));
  if (written.status === 'applied') log.info('Created bank rule', { id: written.id, ruleName: input.ruleName }, 'accounting');
  return written;
}

export async function updateRule(
  companyId: string,
  id: string,
  input: Partial<RuleCreateInput> & { isActive?: boolean },
  userId: string,
): Promise<RuleOutcome> {
  // Use ?? not || so legitimately-zero priorities and false booleans are not
  // dropped. Fields with min(1) (ruleName, matchPattern) and enums can't be
  // empty strings, so ?? matches the schema invariants. Only the fields named
  // (not null/undefined) move — the COALESCE semantics this always had.
  await assertCustomerInCompany(companyId, input.clientId);
  await assertSupplierInCompany(companyId, input.supplierId);
  if (input.glAccountId) await assertRuleAccountNotContactControl(companyId, id, input);
  return outcome(await writeRuleChange(companyId, id, {
    rule_name: input.ruleName ?? undefined, match_field: input.matchField ?? undefined,
    match_type: input.matchType ?? undefined, match_pattern: input.matchPattern ?? undefined,
    gl_account_id: input.glAccountId ?? undefined, supplier_id: input.supplierId ?? undefined,
    client_id: input.clientId ?? undefined, description_template: input.descriptionTemplate ?? undefined,
    priority: input.priority ?? undefined, auto_create_entry: input.autoCreateEntry ?? undefined,
    vat_code: input.vatCode ?? undefined, auto_apply: assertAutoApply(input.autoApply) ?? undefined,
    is_active: input.isActive ?? undefined,
  }, userId));
}

/**
 * updateRule's (and toggleRule's) twin of createRule's check: the rule's own supplier/customer and account count
 * when this change names none.
 */
async function assertRuleAccountNotContactControl(
  companyId: string, id: string, input: Partial<RuleCreateInput>,
): Promise<void> {
  const [cur] = (await sql`
    SELECT rule_name, supplier_id, client_id, gl_account_id FROM bank_categorisation_rules
    WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
  `) as Record<string, unknown>[];
  if (!cur) return; // no such rule: writeRuleChange answers that, not this check
  const supplierId = input.supplierId ?? cur.supplier_id;
  const clientId = input.clientId ?? cur.client_id;
  if (supplierId || clientId) return;
  const accountId = input.glAccountId ?? (cur.gl_account_id == null ? null : String(cur.gl_account_id));
  await assertNotContactControl(companyId, accountId, `Rule "${String(input.ruleName ?? cur.rule_name)}"`, 'rule');
}

/**
 * The rule's auto-apply mode, or undefined when the caller did not name one.
 *
 * `parseAutoApplyMode` returns null for anything that is not a mode, and this
 * turns that into a refusal rather than a default — the column has a CHECK
 * constraint, and reaching it would raise 23514 mid-statement instead of a
 * message the caller can act on.
 */
function assertAutoApply(value: AutoApplyMode | undefined): AutoApplyMode | undefined {
  if (value === undefined) return undefined;
  const parsed = parseAutoApplyMode(value);
  if (parsed === null) {
    throw new Error(`auto_apply must be one of: ${AUTO_APPLY_MODES.join(', ')}`);
  }
  return parsed;
}

/** Deleting is always applied (a deleted rule posts nothing); recorded by the rules table. 404 when the rule is not here. */
export async function deleteRule(companyId: string, id: string): Promise<void> {
  await removeRules(companyId, [id]);
}

/** All or nothing: a missing or foreign id refuses the whole batch (404) before any delete. */
export async function deleteRules(companyId: string, ids: string[]): Promise<number> {
  return removeRules(companyId, ids);
}

export async function toggleRule(companyId: string, id: string, isActive: boolean, userId: string): Promise<RuleOutcome> {
  // Re-enabling an account rule that points at AP/AR control (written before the guard, or left there when its
  // supplier was deleted) is refused like a create; the sweep skips it anyway, but it should not read as working.
  if (isActive) await assertRuleAccountNotContactControl(companyId, id, {});
  return outcome(await writeRuleChange(companyId, id, { is_active: isActive }, userId));
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
    // A rule row written before migration 676 reads NULL. That is the DEFAULT,
    // not 'none': reading it as "apply nothing" reproduces the state the
    // default exists to end. Same rule as bankRuleAutoPostLine.
    autoApply: parseAutoApplyMode(row.auto_apply) ?? DEFAULT_AUTO_APPLY,
    createdBy: row.created_by ? String(row.created_by) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    glAccountCode: row.gl_account_code ? String(row.gl_account_code) : undefined,
    glAccountName: row.gl_account_name ? String(row.gl_account_name) : undefined,
    supplierName: row.supplier_name ? String(row.supplier_name) : undefined,
    clientName: row.client_name ? String(row.client_name) : undefined,
  };
}
