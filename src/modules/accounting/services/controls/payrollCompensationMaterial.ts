import Decimal from 'decimal.js';
import {assertControlTx} from './context';
import type {ControlTx,OperationRef} from './contracts';
import type {ApMaterial} from './apOperationMaterializer';
import {readControlEntityVersion} from './operationVersions';
import {parsePayrollCompensationPayload,type PayrollCompensationPayload} from './payrollCompensationPlan';
import {loadPayrollCompensationSources,compensationFingerprint,assignmentState} from './payrollCompensationSource';
import {expandPayrollCompensation} from './payrollCompensationExpand';
interface Intent{id:string;requester_person_id:string;effective_date:string;amount:string;currency:string;payload:unknown;source_fingerprint:string}
export interface CompensationEffectResult{intentId:string;afterFingerprint:string;assignmentIds:string[];inserted:number;ended:number;amended:number}
function assertionInput(payload:PayrollCompensationPayload){
 if(payload.source.kind==='batch')return{version:1,source:payload.source};
 if(payload.source.kind==='package')return{version:1,source:payload.source,effectiveFrom:payload.actions.find(a=>a.kind==='assign')?.effectiveFrom};
 return{version:1,source:payload.source,actions:payload.actions.map(action=>action.kind==='assign'?{kind:action.kind,employeeId:action.employeeId,componentId:action.componentId,amount:action.amount,effectiveFrom:action.effectiveFrom,effectiveTo:action.effectiveTo,isRecurring:action.isRecurring}:
  action.kind==='end'?{kind:action.kind,assignmentId:action.assignmentId,effectiveTo:action.effectiveTo}:{kind:action.kind,assignmentId:action.assignmentId,amount:action.amount})};
}
function actionShape(payload:PayrollCompensationPayload){return payload.actions.map(action=>compensationFingerprint({...action,assignmentId:action.kind==='assign'?null:action.assignmentId})).sort();}
export async function loadPayrollCompensationIntent(ctx:ControlTx,id:string){
 assertControlTx(ctx);
 const [intent]=await ctx.sql`SELECT *,effective_date::text,amount::text FROM control_payroll_compensation_intents WHERE company_id=${ctx.principal.companyId}::uuid AND id=${id}::uuid` as Intent[];
 if(!intent)throw new Error('Owned compensation intent required');
 const plan=parsePayrollCompensationPayload(intent.payload),sources=await loadPayrollCompensationSources(ctx,plan.source),fingerprint=compensationFingerprint(sources);
 const [effect]=await ctx.sql`SELECT id,result FROM control_operation_effects WHERE company_id=${ctx.principal.companyId}::uuid AND entity_type='payroll_compensation_intent' AND entity_id=${id} AND operation='payroll_compensation.change'` as {id:string;result:CompensationEffectResult}[];
 if(effect){
  if(effect.result.intentId!==id||effect.result.afterFingerprint!==fingerprint)throw new Error('Compensation receipt source changed');
  for(const action of plan.actions){const row=sources.assignments.find(r=>r.id===action.assignmentId);
   if(!row||compensationFingerprint(assignmentState(row,action.kind))!==compensationFingerprint(action))throw new Error('Compensation receipt assignment changed');
  }
  if(plan.source.kind==='batch'&&sources.sourceHeader?.status!=='posted')throw new Error('Compensation receipt batch changed');
 }else{
  if(intent.source_fingerprint!==fingerprint)throw new Error('Compensation source changed; prepare a fresh intent');
  if(plan.actions.some(a=>a.kind==='assign'&&sources.assignments.some(row=>row.id===a.assignmentId)))throw new Error('Compensation assignment already exists');
  const expanded=expandPayrollCompensation(assertionInput(plan),sources);
  if(compensationFingerprint(actionShape(plan))!==compensationFingerprint(actionShape(expanded.payload))||expanded.effectiveDate!==intent.effective_date||!new Decimal(expanded.amount).eq(intent.amount)||intent.currency!=='ZAR')throw new Error('Compensation intent does not match complete current source');
 }
 return{intent,plan,sources,effect};
}
export async function materializePayrollCompensationOperation(ctx:ControlTx,ref:OperationRef):Promise<ApMaterial>{
 if(ref.entityType!=='payroll_compensation_intent'||ref.operation!=='payroll_compensation.change')throw new Error('Unsupported compensation operation');
 const material=await loadPayrollCompensationIntent(ctx,ref.entityId),prior=await readControlEntityVersion(ctx,ref),facts={intent:material.intent,source:material.sources};
 const parent={entityType:ref.entityType,entityId:ref.entityId,version:prior?.version??1,tracked:prior!==null,facts,fingerprint:compensationFingerprint(facts)};
 if(ref.expectedVersion!==undefined&&ref.expectedVersion!==parent.version)throw new Error('Compensation intent version changed');
 return{supplierId:'',observedSources:[parent],versionBasis:prior?'recorded_with_current_fingerprint':'untracked_current_observation',binding:{companyId:ctx.principal.companyId,
  entityType:ref.entityType,entityId:ref.entityId,operation:ref.operation,entityVersion:parent.version,accountingDate:material.intent.effective_date,amount:material.intent.amount,currency:material.intent.currency,
  beneficiaries:[],sourceVersions:[{entityType:parent.entityType,entityId:parent.entityId,version:parent.version,fingerprint:parent.fingerprint}]}};
}
