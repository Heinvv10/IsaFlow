import Decimal from 'decimal.js';
import { canonicalMoney } from './canonical';
import { assertControlTx } from './context';
import type { ControlTx, PolicyBinding } from './contracts';

export interface ApprovalRuleRow {
  id: string; document_type: string; condition_field: string; condition_operator: string;
  condition_value: string; approver_role: string; control_version: number; is_active: boolean;
  aggregate_window_days: number | null; aggregate_by: string | null;
}

export function matchApprovalRules(rules: readonly ApprovalRuleRow[], amount: string,
  priorExposure: ReadonlyMap<string, string>): PolicyBinding[] {
  const value = new Decimal(canonicalMoney(amount));
  const matches: PolicyBinding[] = [];
  for (const rule of rules) {
    if (rule.is_active !== true) continue;
    if (!['amount', 'total'].includes(rule.condition_field)
      || !['any', 'greater_than', 'greater_equal'].includes(rule.condition_operator)
      || !rule.approver_role?.trim() || !Number.isSafeInteger(rule.control_version) || rule.control_version < 1
      || !((rule.aggregate_window_days === null && rule.aggregate_by === null)
        || (rule.aggregate_window_days === 1 && rule.aggregate_by === 'supplier'))) {
      throw new Error('Unsupported approval policy');
    }
    const threshold = new Decimal(canonicalMoney(String(rule.condition_value)));
    if (threshold.isNegative()) throw new Error('Invalid approval policy threshold');
    const tested = rule.aggregate_window_days === null ? value
      : value.add(canonicalMoney(priorExposure.get(rule.id) ?? '0'));
    if (rule.condition_operator === 'any'
      || (rule.condition_operator === 'greater_than' && tested.gt(threshold))
      || (rule.condition_operator === 'greater_equal' && tested.gte(threshold))) {
      matches.push({ policyId: rule.id, policyVersion: rule.control_version,
        approverRole: rule.approver_role, mandatory: false });
    }
  }
  return matches;
}

/** Lock active policy population; unsupported conditions always fail closed. */
export async function loadApprovalRules(ctx: ControlTx, documentType: 'payment' | 'supplier_invoice'): Promise<ApprovalRuleRow[]> {
  assertControlTx(ctx);
  const rows = await ctx.sql`
    SELECT id,document_type,condition_field,condition_operator,condition_value::text,
      approver_role,control_version,is_active,aggregate_window_days,aggregate_by
    FROM approval_rules WHERE company_id=${ctx.principal.companyId}::uuid
      AND document_type=${documentType} AND is_active=true ORDER BY id LIMIT 101 FOR SHARE
  ` as ApprovalRuleRow[];
  if (rows.length > 100) throw new Error('Approval policy population exceeds execution limit');
  return rows.map(row => ({ ...row, control_version: Number(row.control_version) }));
}
