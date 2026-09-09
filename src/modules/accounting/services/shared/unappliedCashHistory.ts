import {beginCashPopulation,reconcileCashPopulation,type CashPopulationCoverage} from './unappliedCashCensus';
import Decimal from 'decimal.js';
import {fmtDate} from '@/lib/fmtDate';
import {queryUnappliedCashHistory} from './unappliedCashHistoryQuery';
const D=Decimal.clone({precision:80});
type Row=Record<string,unknown>;
export interface CashHistoryCoverage {
 population:CashPopulationCoverage;status:'complete'|'partial';unresolvedPaymentCount:number;unresolvedAllocationCount:number;reasons:string[];
}
export interface CashHistoryRow extends Row {allocated_amount:number;unapplied_amount:number}
function children(value:unknown):Row[]{return Array.isArray(value)?value as Row[]:[];}
function date(value:unknown){return value==null?null:fmtDate(value as string|Date);}
/** Unknown legacy dates are excluded from asserted totals and counted explicitly. */
export function analyzeUnappliedCashHistory(source:Row[],asAt:string,populationCount:number){
 if(source.length>100000)throw new Error('Cash history population exceeds complete-report bound');
 const population=beginCashPopulation(source,populationCount);
 const historyCoverage:CashHistoryCoverage={population,status:'complete',unresolvedPaymentCount:0,unresolvedAllocationCount:0,reasons:[]};
 const rows:CashHistoryRow[]=[],reasons=new Set<string>();let watermark=0;
 function consume(...values:unknown[]){for(const value of values){if(value==null)continue;const timestamp=new Date(String(value)).getTime();if(Number.isFinite(timestamp))watermark=Math.max(watermark,timestamp);}}
 for(const payment of source){
  population.analyzedCount++;
  consume(payment.created_at,payment.updated_at,payment.journal_created_at);
  const allocations=children(payment.allocations),contras=children(payment.contras),cancellations=children(payment.cancellations);
  if(allocations.length>10000)throw new Error('Cash allocation history exceeds complete-report bound');
  for(const row of [...contras,...cancellations])consume(row.createdAt,row.occurredAt,row.committedAt);
  let unknown=false,allocated=new D(0);
  const unresolved=(reason:string)=>{unknown=true;reasons.add(reason);};
  for(const a of allocations){
   consume(a.createdAt,a.applicationCreatedAt,a.reversedAt,a.inverseCreatedAt);
   if(!a.applicationId||!a.applicationDate||(a.reversedAt!=null||a.inverseId!=null)&&(!a.inverseId||!a.inverseDate)){
    historyCoverage.unresolvedAllocationCount++;unresolved('Allocation accounting date or inverse evidence is missing');continue;
   }
   if(date(a.applicationDate)!<=asAt&&(!a.inverseDate||date(a.inverseDate)!>asAt))allocated=allocated.add(String(a.amount));
  }
  const status=String(payment.status),paymentDate=date(payment.payment_date);
  // Drafts without a posted journal are not recognized cash.
  if(['draft','approved','pending'].includes(status)&&payment.journal_status!=='posted'){population.inactiveCount++;continue;}
  if(payment.journal_status!=='posted'||date(payment.journal_date)!==paymentDate)unresolved('Original posted cash accounting date is missing or inconsistent');
  let cancellationDate:string|null=null;
  if(status==='cancelled'){
   if(contras.length===1&&cancellations.length===1&&date(contras[0]!.date)===date(cancellations[0]!.date))cancellationDate=date(contras[0]!.date);
   else unresolved('Cancellation accounting evidence is missing or ambiguous');
  }else if(!['confirmed','processed','reconciled'].includes(status)||contras.length||cancellations.length)unresolved('Cash lifecycle evidence conflicts with current state');
  if(unknown){historyCoverage.unresolvedPaymentCount++;population.unresolvedCount++;continue;}
  if(!paymentDate||paymentDate>asAt||cancellationDate&&cancellationDate<=asAt){population.inactiveCount++;continue;}
  const unapplied=new D(String(payment.total_amount)).sub(allocated);
  if(unapplied.gt('0.01')){population.recognizedRemainderCount++;rows.push({...payment,allocated_amount:allocated.toNumber(),unapplied_amount:unapplied.toNumber()});}
  else population.fullyAppliedCount++;
 }
 reconcileCashPopulation(population);
 historyCoverage.status=historyCoverage.unresolvedPaymentCount?'partial':'complete';historyCoverage.reasons=[...reasons].sort();
 return{rows,historyCoverage,postedThrough:new Date(watermark).toISOString()};
}
export async function loadUnappliedCashHistory(companyId:string,kind:'customer'|'supplier',asAt:string){
 const source=await queryUnappliedCashHistory(companyId,kind,asAt);
 return analyzeUnappliedCashHistory(source.rows,asAt,source.populationCount);
}
export function cashHistoryPage(rows:CashHistoryRow[],opts:{limit:number;after?:{paymentDate:string;id:string}|null}){
 if(!Number.isSafeInteger(opts.limit)||opts.limit<1||opts.limit>10000)throw new Error('Invalid cash history page limit');
 const attributed=rows.filter(row=>row.party_id!=null),orphans=rows.filter(row=>row.party_id==null);
 if(orphans.length>500)throw new Error('Unattributed cash exceeds complete-report bound');
 const page=attributed.filter(row=>!opts.after||date(row.payment_date)!>opts.after.paymentDate||date(row.payment_date)===opts.after.paymentDate&&String(row.id)>opts.after.id).slice(0,opts.limit);
 const total=(items:CashHistoryRow[])=>items.reduce((sum,row)=>sum.add(String(row.unapplied_amount)),new D(0)).toNumber();
 return{page,orphans,rowsTotal:attributed.length,totalUnapplied:total(attributed),totalUnattributed:total(orphans)};
}
