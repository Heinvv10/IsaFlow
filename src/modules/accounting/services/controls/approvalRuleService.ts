import Decimal from 'decimal.js';
import type {operationRuleType} from './operationPermissions';
import { canonicalMoney } from './canonical';
import { assertControlTx } from './context';
import type { ControlTx, PolicyBinding } from './contracts';
const Money = Decimal.clone({ precision: 80 });

export interface ApprovalRuleRow {
  id: string; document_type: string; condition_field: string; condition_operator: string;
  condition_value: string; approver_role: string; control_version: number; is_active: boolean;
  aggregate_window_days: number | null; aggregate_by: string | null;
  mandatory?: boolean;
}

export function matchApprovalRules(rules: readonly ApprovalRuleRow[], amount: string | null,
  priorExposure: ReadonlyMap<string, string>): PolicyBinding[] {
  const value = amount === null ? null : new Money(canonicalMoney(amount));
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
    const threshold = new Money(canonicalMoney(String(rule.condition_value)));
    if (threshold.isNegative()) throw new Error('Invalid approval policy threshold');
    if (value === null && (rule.condition_operator !== 'any' || rule.aggregate_window_days !== null)) {
      throw new Error('Monetary approval policy cannot evaluate a nonfinancial operation');
    }
    const tested = rule.aggregate_window_days === null ? value
      : value!.add(canonicalMoney(priorExposure.get(rule.id) ?? '0'));
    if (rule.condition_operator === 'any'
      || (rule.condition_operator === 'greater_than' && tested!.gt(threshold))
      || (rule.condition_operator === 'greater_equal' && tested!.gte(threshold))) {
      matches.push({ policyId: rule.id, policyVersion: rule.control_version,
        approverRole: rule.approver_role, mandatory: rule.mandatory === true });
    }
  }
  return matches;
}

/** Lock active policy population; unsupported conditions always fail closed. */
export async function loadApprovalRules(ctx: ControlTx, documentType: ReturnType<typeof operationRuleType>): Promise<ApprovalRuleRow[]> {
  assertControlTx(ctx);
  const configuredType=documentType==='invoice_match_override'?'supplier_invoice':documentType;
  const rows = await ctx.sql`
    SELECT id,document_type,condition_field,condition_operator,condition_value::text,
      approver_role,control_version,is_active,aggregate_window_days,aggregate_by
    FROM approval_rules WHERE company_id=${ctx.principal.companyId}::uuid
      AND document_type=${configuredType} AND is_active=true ORDER BY id LIMIT 101 FOR SHARE
  ` as ApprovalRuleRow[];
  if (rows.length > 100) throw new Error('Approval policy population exceeds execution limit');
  const rules = rows.map(row => ({ ...row, control_version: Number(row.control_version) }));
  if (documentType === 'payment_release') {
    const policies = await ctx.sql`
      SELECT id,version AS control_version,approver_role
      FROM control_mandatory_release_policies WHERE company_id=${ctx.principal.companyId}::uuid
    ` as { id: string; control_version: number | string; approver_role: string }[];
    const policy = policies[0];
    if (policies.length !== 1 || !policy || Number(policy.control_version) !== 1 || policy.approver_role !== 'admin') {
      throw new Error('Mandatory release policy is unavailable');
    }
    rules.push({ id: policy.id, document_type: documentType, condition_field: 'amount',
      condition_operator: 'any', condition_value: '0', approver_role: policy.approver_role,
      control_version: Number(policy.control_version), is_active: true, aggregate_window_days: null,
      aggregate_by: null, mandatory: true });
  }
  if(documentType==='historical_import'){
    const policies=await ctx.sql`SELECT id,version AS control_version,approver_role FROM control_mandatory_import_policies
      WHERE company_id=${ctx.principal.companyId}::uuid` as {id:string;control_version:number|string;approver_role:string}[];
    const policy=policies[0];
    if(policies.length!==1||!policy||Number(policy.control_version)!==1||policy.approver_role!=='admin')throw new Error('Mandatory import policy is unavailable');
    rules.push({id:policy.id,document_type:documentType,condition_field:'amount',condition_operator:'any',condition_value:'0',
      approver_role:policy.approver_role,control_version:1,is_active:true,aggregate_window_days:null,aggregate_by:null,mandatory:true});
  }
  if(documentType==='invoice_match_override'){
    const policies=await ctx.sql`SELECT id,version AS control_version,approver_role
      FROM control_mandatory_match_override_policies WHERE company_id=${ctx.principal.companyId}::uuid` as {id:string;control_version:number|string;approver_role:string}[];
    const policy=policies[0];
    if(policies.length!==1||!policy||Number(policy.control_version)!==1||policy.approver_role!=='admin')throw new Error('Mandatory match override policy is unavailable');
    rules.push({id:policy.id,document_type:documentType,condition_field:'amount',condition_operator:'any',condition_value:'0',
      approver_role:policy.approver_role,control_version:1,is_active:true,aggregate_window_days:null,aggregate_by:null,mandatory:true});
  }
  return rules;
}
