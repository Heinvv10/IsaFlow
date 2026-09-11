import type {PayrollCompensationAction} from './payrollCompensationPlan';
import {lockdownBlock} from '../gl/postingPeriodGuard';
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
 // `start` is the first payroll day the change reaches, not the day the operator acts: a lockdown freezes
 // the days it covers, and a compensation change is only ever felt on the days it applies to. A change whose
 // first affected day is after the lockdown date touches nothing frozen, however long ago it was requested.
 if(lockdownBlock(company,start))throw new Error('Compensation affects company lockdown');
 for(const run of runs){
  if(!['approved','paid','cancelled'].includes(String(run.status)))continue;
  const year=Number(run.period_year),month=Number(run.period_month);
  const periodStart=`${year}-${String(month).padStart(2,'0')}-01`,periodEnd=new Date(Date.UTC(year,month,0)).toISOString().slice(0,10);
  if(start<=periodEnd&&end>=periodStart)throw new Error('Compensation affects a locked payroll period; use approved reopening first');
 }
 return start;
}
