import type {ControlTx} from './contracts';
import {assertCompensationWindow} from './payrollCompensationWindows';
import {assertControlledEffectPermit,type ControlledEffectPermit} from './approvalExecutionService';
import {loadPayrollCompensationIntent,type CompensationEffectResult} from './payrollCompensationMaterial';
import {loadPayrollCompensationSources,compensationFingerprint,assignmentState,type CompensationRow} from './payrollCompensationSource';
import {readControlEntityVersion} from './operationVersions';
import {recordCommittedChange} from './changeEventService';
/** Only the shared execution kernel can issue this transaction-bound effect authority. */
export async function executePayrollCompensationEffect(ctx:ControlTx,intentId:string,permit:ControlledEffectPermit):Promise<CompensationEffectResult>{
 assertControlledEffectPermit(ctx,permit,{entityType:'payroll_compensation_intent',entityId:intentId,operation:'payroll_compensation.change'});
 const {plan,sources,effect}=await loadPayrollCompensationIntent(ctx,intentId);if(effect)throw new Error('Compensation already executed');
 const company=ctx.principal.companyId;let inserted=0,ended=0,amended=0;
 for(const action of plan.actions){
  const before=sources.assignments.find(row=>row.id===action.assignmentId)??null;
  const accountingDate=assertCompensationWindow(action,before?assignmentState(before,action.kind):null,sources.company,sources.runs);
  let rows:CompensationRow[];
  if(action.kind==='assign'){
   rows=await ctx.sql`INSERT INTO payroll_employee_components(id,employee_id,component_id,amount,effective_from,effective_to,is_recurring)
    SELECT ${action.assignmentId}::uuid,e.id,c.id,${action.amount}::numeric,${action.effectiveFrom}::date,${action.effectiveTo}::date,${action.isRecurring}
    FROM payroll_employees e JOIN payroll_components c ON c.company_id=e.company_id AND c.id=${action.componentId}::uuid
    WHERE e.company_id=${company}::uuid AND e.id=${action.employeeId}::uuid
    RETURNING *` as CompensationRow[];inserted++;
  }else{
   if(!before)throw new Error('Compensation assignment disappeared');
   rows=await ctx.sql`UPDATE payroll_employee_components a SET amount=${action.amount}::numeric,effective_to=${action.effectiveTo}::date
    FROM payroll_employees e WHERE e.company_id=${company}::uuid AND e.id=a.employee_id AND a.id=${action.assignmentId}::uuid
     AND a.employee_id=${action.employeeId}::uuid AND a.component_id=${action.componentId}::uuid AND a.amount=${String(before.amount)}::numeric
     AND a.effective_from=${String(before.effective_from)}::date AND a.effective_to IS NOT DISTINCT FROM ${before.effective_to}::date
    RETURNING a.*` as CompensationRow[];
   if(action.kind==='end')ended++;else amended++;
  }
  if(rows.length!==1)throw new Error('Compensation assignment changed before effect');
  const ref={entityType:'payroll_employee_component',entityId:action.assignmentId},prior=await readControlEntityVersion(ctx,ref);
  await recordCommittedChange(ctx,{...ref,previousVersion:prior?.version??null,newVersion:(prior?.version??0)+1,action:`payroll_compensation.${action.kind}`,
   accountingDate,before,after:rows[0]!,bindingHash:null,protectedEvidenceRef:null,operationId:permit.operationId});
 }
 if(plan.source.kind==='batch'){
  const rows=await ctx.sql`UPDATE payroll_batches SET status='posted',posted_at=clock_timestamp(),posted_by=${ctx.principal.personId},updated_at=clock_timestamp()
   WHERE company_id=${company}::uuid AND id=${plan.source.sourceId}::uuid AND status='validated' RETURNING id`;
  if(rows.length!==1)throw new Error('Compensation batch changed before effect');
 }
 const after=await loadPayrollCompensationSources(ctx,plan.source);
 return{intentId,assignmentIds:plan.actions.map(action=>action.assignmentId),inserted,ended,amended,afterFingerprint:compensationFingerprint(after)};
}
