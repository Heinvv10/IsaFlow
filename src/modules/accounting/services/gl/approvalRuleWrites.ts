/**
 * The ONLY writes to `approval_rules` and `approval_enforcement` (R-035 N1b B,
 * migration 881). Since 881 neither table is writable by app_user: every
 * create, update, delete, row lock and switch goes through a SECURITY DEFINER
 * function that repeats, in SQL, the checks the TypeScript callers run first
 * (approvalService, approvalRuleGuards, approvalEnforcement) and writes the
 * audit row itself. `tests/unit/services/gl/approvalRuleWriteCensus.test.ts`
 * fails if anything else writes, locks or calls them.
 *
 * A refusal from SQL keeps its SQLSTATE (RB0xx, listed in 881) and DETAIL;
 * `sqlRefusal` reads them so each caller can raise its own error type.
 */
import { sql } from '@/lib/neon';
import type { RuleActor } from './approvalRuleGuards';

type Row = Record<string, unknown>;

/** The SQLSTATE and DETAIL of a definer refusal, when `error` is one of `codes`. */
export function sqlRefusal(error: unknown, codes: readonly string[]): { code: string; detail: string; message: string } | null {
  if (typeof error !== 'object' || error === null) return null;
  const { code, detail, message } = error as { code?: unknown; detail?: unknown; message?: unknown };
  if (typeof code !== 'string' || !codes.includes(code)) return null;
  return { code, detail: typeof detail === 'string' ? detail : '', message: typeof message === 'string' ? message : '' };
}

/** NULL is "not sent" to every definer: an absent field keeps the stored value (or the column default). */
const sent = <T>(value: T | undefined): T | null => (value === undefined ? null : value);

/** The rule row, locked FOR UPDATE for the rest of the transaction; undefined when this company has no such rule. */
export async function lockRuleRow(companyId: string, ruleId: string, actor: RuleActor): Promise<Row | undefined> {
  const rows = (await sql`
    SELECT * FROM approval_rule_lock(${companyId}::UUID, ${ruleId}::UUID, ${actor.userId})
  `) as Row[];
  return rows[0];
}

export interface RuleCreateInput {
  name: string; documentType: string; conditionField?: string; conditionOperator?: string;
  conditionValue?: number; approverRole?: string;
}

export async function insertRuleRow(companyId: string, input: RuleCreateInput, actor: RuleActor): Promise<Row> {
  const rows = (await sql`
    SELECT * FROM approval_rule_create(${companyId}::UUID, ${actor.userId}, ${input.name}, ${input.documentType},
      ${sent(input.conditionField)}, ${sent(input.conditionOperator)}, ${sent(input.conditionValue)}::NUMERIC,
      ${sent(input.approverRole)})
  `) as Row[];
  return rows[0]!;
}

export type RuleUpdateInput = Partial<{
  name: string; conditionField: string; conditionOperator: string; conditionValue: number; approverRole: string;
  isActive: boolean;
}>;

/** The updated row; undefined when this company has no such rule. */
export async function updateRuleRow(companyId: string, ruleId: string, input: RuleUpdateInput,
  actor: RuleActor): Promise<Row | undefined> {
  const rows = (await sql`
    SELECT * FROM approval_rule_update(${companyId}::UUID, ${ruleId}::UUID, ${actor.userId}, ${sent(input.name)},
      ${sent(input.conditionField)}, ${sent(input.conditionOperator)}, ${sent(input.conditionValue)}::NUMERIC,
      ${sent(input.approverRole)}, ${sent(input.isActive)}::BOOLEAN)
  `) as Row[];
  return rows[0];
}

/** False when this company has no such rule. */
export async function deleteRuleRow(companyId: string, ruleId: string, actor: RuleActor): Promise<boolean> {
  const rows = (await sql`
    SELECT * FROM approval_rule_delete(${companyId}::UUID, ${ruleId}::UUID, ${actor.userId})
  `) as Row[];
  return rows.length > 0;
}

/**
 * Switches `documentType` — and every type coupled with it — on or off.
 * Returns the rows inserted or deleted (none: it already was), each with
 * `baseline_suppliers` for a supplier bank-detail switch-on.
 */
export async function setEnforcementRows(companyId: string, documentType: string, enabled: boolean,
  actor: RuleActor): Promise<Row[]> {
  return (await sql`
    SELECT * FROM approval_enforcement_set(${companyId}::UUID, ${documentType}, ${enabled}, ${actor.userId})
  `) as Row[];
}
