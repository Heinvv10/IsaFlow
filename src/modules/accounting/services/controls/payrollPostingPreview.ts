import { assertEffectivePermission } from '@/lib/auth/effectivePermissions';
import type { ControlTx } from './contracts';
import type { ExactPayrollLine } from './payrollExactPlan';
import { materializePayrollOperation } from './payrollOperationMaterializer';
/** Read-only exact writer plan; detailed payroll source snapshots never leave this boundary. */
export async function getPayrollPostingPreview(ctx:ControlTx,runId:string) {
  await assertEffectivePermission(ctx,'read:payroll');
  const material=await materializePayrollOperation(ctx,{entityType:'payroll_run',entityId:runId,operation:'payroll_run.post'});
  const facts=material.observedSources[0]!.facts as {header:{status:unknown};plan:{lines:ExactPayrollLine[]};
    targetPeriod:{status:unknown};company:{lockdown_enabled:boolean;lockdown_date:string|null}};
  const blockers:string[]=[];
  if(!['draft','calculated','processed','approved'].includes(String(facts.header.status))) blockers.push('Payroll run is not approvable');
  if(facts.targetPeriod.status!=='open') blockers.push('Fiscal period is not open');
  if(facts.company.lockdown_enabled && (!facts.company.lockdown_date || material.binding.accountingDate!<=facts.company.lockdown_date)) blockers.push('Company accounting date is locked');
  return {runId,status:String(facts.header.status),accountingDate:material.binding.accountingDate,amount:material.binding.amount,
    currency:material.binding.currency,versionBasis:material.versionBasis,calculationVerified:true as const,blockers,
    lines:facts.plan.lines.map(line=>({glAccountId:line.glAccountId,debit:line.debit,credit:line.credit,description:line.description}))};
}
