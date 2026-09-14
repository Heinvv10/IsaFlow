import {randomUUID} from 'node:crypto';
import Decimal from 'decimal.js';
import {assignmentState,type CompensationSources} from './payrollCompensationSource';
import {endOfMonthIso} from '../payroll/leaveAccrualService';
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
  const from=input.effectiveFrom;
  const onceOffEnd=endOfMonthIso(Number(from.slice(0,4)),Number(from.slice(5,7)));
  for(const line of s.sourceLines){
   const componentId=String(line.component_id);if(components.has(componentId))throw new Error('Duplicate package component');components.add(componentId);
   // Supersede every assignment this apply OVERLAPS, not only the open-ended ones: a once-off row
   // is inserted already closed, so an effective_to IS NULL predicate steps over the previous
   // apply's row and leaves two live windows the run pays twice.
   for(const old of s.assignments.filter(r=>r.employee_id===input.source.employeeId&&r.component_id===componentId
    &&(r.effective_to===null||String(r.effective_to)>=from))){
    actions.push({...assignmentState(old,'end'),effectiveTo:previousDay(from)});
   }
   // A once-off package row is paid once: the reader filters on the date window only and ignores
   // is_recurring, so an open-ended row is paid in every later run. Closed at the end of
   // effectiveFrom's own month — the one rule shared with the batch and the manual assignment.
   const isRecurring=line.is_recurring===true;
   assign(input.source.employeeId,componentId,String(line.amount),from,isRecurring?null:onceOffEnd,isRecurring);
  }
 }else{
  const header=s.sourceHeader;if(!header||header.status!=='validated')throw new Error('Payroll batch must be validated');
  if(Number(header.line_count)!==s.sourceLines.length||!new D(String(header.total_amount)).eq(s.sourceLines.reduce((sum,line)=>sum.add(String(line.value??0)),new D(0))))throw new Error('Batch source population does not reconcile');
  for(const line of s.sourceLines){
   // Same close rule as the package and the manual assignment: a once-off line with no
   // effective_to of its own dies at the end of its OWN effective_from month. The batch period
   // end would be wrong in both directions — a backdated line would pay every month up to it,
   // and a line dated past it would clamp to a single day the run never evaluates.
   const lineFrom=String(line.effective_from),lineRecurring=header.is_recurring===true;
   const args={employee:String(line.employee_id),from:lineFrom,recurring:lineRecurring,
    to:line.effective_to!==null?String(line.effective_to)
     :lineRecurring?null:endOfMonthIso(Number(lineFrom.slice(0,4)),Number(lineFrom.slice(5,7)))};
   if(header.batch_type==='component_values')assign(args.employee,String(header.component_id),String(line.value),args.from,args.to,args.recurring);
   else{
    const taxable=new D(String(line.taxable_portion??0)),nonTaxable=new D(String(line.non_taxable_portion??0));
    const km=new D(String(line.km??0)),rate=new D(String(line.rate_per_km??0));
    if(!km.gt(0)||!rate.gt(0))throw new Error('Positive travel distance and rate required');
    const amount=km.mul(rate).toDecimalPlaces(2);
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
  if(!employee||(action.kind!=='end'&&employee.status!=='active'))throw new Error('Active owned employee required');
  if(!s.components.some(c=>c.id===action.componentId&&(action.kind==='end'||c.is_active===true)))throw new Error('Active owned component required');
  if(String(employee.start_date)>action.effectiveFrom||(employee.end_date&&(!action.effectiveTo||String(employee.end_date)<action.effectiveTo)))throw new Error('Compensation exceeds employee employment dates');
  const row=s.assignments.find(r=>r.id===action.assignmentId),before=row?assignmentState(row,action.kind):null;
  dates.push(assertCompensationWindow(action,before,s.company,s.runs));exposures.push({before:before?.amount??null,after:action.amount});
 }
 return{payload,amount:compensationExposure(exposures),effectiveDate:dates.sort()[0]!};
}
