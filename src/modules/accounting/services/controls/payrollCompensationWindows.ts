import type {PayrollCompensationAction} from './payrollCompensationPlan';
type Row=Record<string,unknown>;
const dayAfter=(date:string)=>new Date(Date.parse(`${date}T00:00:00Z`)+86400000).toISOString().slice(0,10);
/** Dates describe affected payroll days, not when the operator clicked save. */
export function assertCompensationWindow(action:PayrollCompensationAction,before:PayrollCompensationAction|null,company:Row,runs:readonly Row[]):string{
 let start=action.effectiveFrom,end=action.effectiveTo??'9999-12-31';
 if(action.kind==='end'){
  if(!before||!action.effectiveTo)throw new Error('Existing assignment and ending date required');
  if(before.effectiveTo&&action.effectiveTo>before.effectiveTo)throw new Error('Ending cannot extend an assignment');
  start=dayAfter(action.effectiveTo);end=before.effectiveTo??'9999-12-31';
 }
 if(company.lockdown_enabled===true&&company.lockdown_date&&start<=String(company.lockdown_date))throw new Error('Compensation affects company lockdown');
 for(const run of runs){
  if(!['approved','paid','cancelled'].includes(String(run.status)))continue;
  const year=Number(run.period_year),month=Number(run.period_month);
  const periodStart=`${year}-${String(month).padStart(2,'0')}-01`,periodEnd=new Date(Date.UTC(year,month,0)).toISOString().slice(0,10);
  if(start<=periodEnd&&end>=periodStart)throw new Error('Compensation affects a locked payroll period; use approved reopening first');
 }
 return start;
}
