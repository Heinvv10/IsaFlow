import { assertControlTx } from './context';
import type { ControlTx, PolicyBinding } from './contracts';
import type { ApMaterial } from './apOperationMaterializer';
import { matchApprovalRules, type ApprovalRuleRow } from './approvalRuleService';
import { supplierExposureBuckets } from './supplierExposureBuckets';

/** Caller holds the tenant policy advisory lock through reservation and commit. */
export async function matchOperationPolicies(ctx: ControlTx, rules: readonly ApprovalRuleRow[],
  material: ApMaterial, day: string): Promise<PolicyBinding[]> {
  assertControlTx(ctx);
  const matches: PolicyBinding[] = [];
  const aggregate = rules.some(rule => rule.aggregate_window_days !== null);
  const buckets = aggregate ? supplierExposureBuckets(material) : [];
  for (const rule of rules) {
    if (rule.aggregate_window_days === null) {
      matches.push(...matchApprovalRules([rule], material.binding.amount, new Map()));
      continue;
    }
    let matched: PolicyBinding | undefined;
    for (const bucket of buckets) {
      const [row] = await ctx.sql`
        SELECT COALESCE(sum(amount),0)::text AS total FROM (
          SELECT DISTINCT ON (e.operation,lower(e.entity_id)) e.amount FROM control_policy_exposure e
          LEFT JOIN control_operation_approvals a ON a.company_id=e.company_id AND a.id=e.approval_id
          WHERE e.company_id=${ctx.principal.companyId}::uuid AND e.policy_id=${rule.id}
            AND e.beneficiary_key=${bucket.beneficiaryKey} AND e.currency=${bucket.currency}
            AND e.window_start=${day}::date
            AND NOT(e.operation=${material.binding.operation} AND lower(e.entity_id)=lower(${material.binding.entityId}))
            AND (e.state='committed' OR (e.state='reserved' AND a.status IN ('pending','approved') AND a.expires_at>clock_timestamp()))
          -- One operation retained under two spellings is one exposure, counted once.
          ORDER BY e.operation,lower(e.entity_id),(e.state='committed') DESC
        ) exposure
      ` as { total: string }[];
      const policies = matchApprovalRules([rule], bucket.amount, new Map([[rule.id, row?.total ?? '0']]));
      if (policies[0]) matched = policies[0];
    }
    if (matched) matches.push(matched);
  }
  return matches;
}
