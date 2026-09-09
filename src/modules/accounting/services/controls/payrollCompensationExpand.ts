import {randomUUID} from 'node:crypto';
import Decimal from 'decimal.js';
import {assignmentState,type CompensationSources} from './payrollCompensationSource';
import {assertCompensationWindow} from './payrollCompensationWindows';
import {parsePayrollCompensationInput,parsePayrollCompensationPayload,compensationExposure,type PayrollCompensationAction} from './payrollCompensationPlan';
const D=Decimal.clone({precision:80});
const previousDay=(date:string)=>new Date(Date.parse(`${date}T00:00:00Z`)-86400000).toISOString().slice(0,10);
/** Expansion uses complete locked source populations; callers cannot supply package/batch amounts. */
export function expandPayrollCompensation(value:unknown,s:CompensationSources){
 const input=parsePayrollCompensationInput(value),actions:PayrollCompensationAction[]=[];
 const assign=(employeeId:string,componentId:string,amount:string,effectiveFrom:string,effectiveTo:string|null,isRecurring:boolean)=>{
  const parsed=parsePayrollCompensationInput({version:1,source:{kind:'manual'},actions:[{kind:'assign',employeeId,componentId,amount,effectiveFrom,effectiveTo,isRecurring}]});
  if('actions' in parsed){const action=parsed.actions[0]!;if(action.kind==='assign')actions.push({...action,assignmentId:randomUUID()});}
 };
 if('actions' in input){
  for(const action of input.actions){
   if(action.kind==='assign'){actions.push({...action,assignmentId:randomUUID()});continue;}
   const row=s.assignments.find(r=>r.id===action.assignmentId);if(!row)throw new Error('Owned compensation assignment required');
   const before=assignmentState(row,action.kind);
   if(action.kind==='amend'){
    if(new D(before.amount).eq(action.amount))throw new Error('Compensation amount unchanged');actions.push({...before,amount:action.amount});
   }else{if(before.effectiveTo===action.effectiveTo)throw new Error('Compensation ending unchanged');actions.push({...before,effectiveTo:action.effectiveTo});}
  }
 }else if(input.source.kind==='package'&&'effectiveFrom' in input){
  if(!s.sourceHeader||s.sourceHeader.is_active!==true)throw new Error('Active owned pay package required');
  const components=new Set<string>();
  for(const line of s.sourceLines){
   const componentId=String(line.component_id);if(components.has(componentId))throw new Error('Duplicate package component');components.add(componentId);
   for(const old of s.assignments.filter(r=>r.employee_id===input.source.employeeId&&r.component_id===componentId&&r.effective_to===null)){
    actions.push({...assignmentState(old,'end'),effectiveTo:previousDay(input.effectiveFrom)});
   }
   assign(input.source.employeeId,componentId,String(line.amount),input.effectiveFrom,null,line.is_recurring===true);
  }
 }else{
  const header=s.sourceHeader;if(!header||header.status!=='validated')throw new Error('Payroll batch must be validated');
  if(Number(header.line_count)!==s.sourceLines.length||!new D(String(header.total_amount)).eq(s.sourceLines.reduce((sum,line)=>sum.add(String(line.value??0)),new D(0))))throw new Error('Batch source population does not reconcile');
  for(const line of s.sourceLines){
   const args={employee:String(line.employee_id),from:String(line.effective_from),to:line.effective_to===null?null:String(line.effective_to),recurring:header.is_recurring===true};
   if(header.batch_type==='component_values')assign(args.employee,String(header.component_id),String(line.value),args.from,args.to,args.recurring);
   else{
    const taxable=new D(String(line.taxable_portion??0)),nonTaxable=new D(String(line.non_taxable_portion??0));
    const amount=new D(String(line.km??0)).mul(String(line.rate_per_km??0)).toDecimalPlaces(2);
    if(taxable.isNegative()||nonTaxable.isNegative()||!taxable.add(nonTaxable).eq(amount)||!amount.eq(String(line.value)))throw new Error('Travel portions do not reconcile to source amount');
    for(const [code,part] of [['3702',taxable],['3703',nonTaxable]] as const){
     if(part.isZero())continue;const matches=s.components.filter(c=>String(c.sars_source_code)===code&&c.is_active===true);
     if(matches.length!==1)throw new Error('Unambiguous owned travel component required');
     assign(args.employee,String(matches[0]!.id),part.toFixed(2),args.from,args.to,args.recurring);
    }
   }
  }
 }
 const payload=parsePayrollCompensationPayload({version:1,source:input.source,actions});
 const exposures:{before:string|null;after:string}[]=[],dates:string[]=[];
 for(const action of payload.actions){
  const employee=s.employees.find(e=>e.id===action.employeeId);
  if(!employee||(action.kind!=='end'&&(employee.status!=='active'||employee.is_active===false)))throw new Error('Active owned employee required');
  if(!s.components.some(c=>c.id===action.componentId&&(action.kind==='end'||c.is_active===true)))throw new Error('Active owned component required');
  if(String(employee.start_date)>action.effectiveFrom||(employee.end_date&&(!action.effectiveTo||String(employee.end_date)<action.effectiveTo)))throw new Error('Compensation exceeds employee employment dates');
  const row=s.assignments.find(r=>r.id===action.assignmentId),before=row?assignmentState(row,action.kind):null;
  dates.push(assertCompensationWindow(action,before,s.company,s.runs));exposures.push({before:before?.amount??null,after:action.amount});
 }
 return{payload,amount:compensationExposure(exposures),effectiveDate:dates.sort()[0]!};
}
