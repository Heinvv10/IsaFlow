// VENDORED pre-seam reference (plan v6 A15). Verbatim from c39a8e17c:src/modules/accounting/services/controls/journalRiskAnalysis.ts
// (blob 61964efeae1609d5d9981ecbead599c31769cb73) — the integration branch's detector before the check-run seam merged into it, re-vendored from
// bcf5aab53 so the reference carries integration's lineage columns and signals. The ONLY edit: imports of the unvendored
// ./context and ./contracts are rewritten to the @/ alias. Never edit below this header.
import Decimal from 'decimal.js';
const Money=Decimal.clone({precision:80});
export interface JournalRiskRow {
 id:string;accountingDate:string;actualAt:Date|string|null;actualBasis:'posted_at'|'created_at';personId:string|null;
 amount:string;currency:string;reversalOfId:string|null;reversedAt:Date|string|null;periodState:string|null;periodEventId:string|null;version:number|null;
 changes?:readonly {id:string;action:string;periodState:string|null;periodEventId:string|null}[];lineageCount?:number;lineageTie?:boolean;
}
export interface JournalThreshold {id:string;version:number;amount:string;operator:'greater_than'|'greater_equal'}
const parts=(at:Date|string|null)=>{
 const date=at===null?null:new Date(at);if(!date||!Number.isFinite(date.getTime()))return null;
 const sast=new Date(date.getTime()+2*3600000);
 return{day:sast.toISOString().slice(0,10),hour:sast.getUTCHours(),weekday:sast.getUTCDay()};
};
/** Statistical/chronological context is a lead, never a fraud or historical policy violation conclusion. */
export function analyseJournalRisks<T extends JournalRiskRow>(rows:readonly T[],thresholds:readonly JournalThreshold[]){
 const reasons=new Map(rows.map(row=>[row.id,[] as string[]]));
 for(const row of rows){
  const signals=reasons.get(row.id)!,actual=parts(row.actualAt);
  if(actual){
   if(row.accountingDate<actual.day)signals.push('backdated_accounting_date');
   if(actual.hour<8||actual.hour>=18)signals.push('outside_business_hours');
   if(actual.weekday===0||actual.weekday===6)signals.push('weekend_actual_time');
  }
  if(row.changes?.some(change=>change.periodEventId&&['closed','locked'].includes(change.periodState??'')))signals.push('change_after_recorded_period_close');
  if(row.reversalOfId||row.reversedAt)signals.push('reversal_relation');
  // Changes are read across every retained spelling; a fork is named so a reviewer knows two lineages were combined.
  if((row.lineageCount??0)>1)signals.push('change_history_lineage_forked');
  // A top-version tie with no canonical spelling: writers refuse this journal until someone adjudicates it.
  if(row.lineageTie)signals.push('change_history_lineage_tie_unresolvable');
  if(row.actualBasis==='posted_at'&&row.periodEventId&&['closed','locked'].includes(row.periodState??''))signals.push('write_after_recorded_period_close');
 }
 for(const threshold of thresholds){
  const bound=new Money(threshold.amount);if(!bound.isFinite()||bound.lte(0))continue;
  const groups=new Map<string,T[]>();
  for(const row of rows){
   const actual=parts(row.actualAt),amount=new Money(row.amount);
   if(!actual||!row.personId||!amount.isFinite()||amount.lte(0)||(threshold.operator==='greater_than'?amount.gt(bound):amount.gte(bound)))continue;
   const key=JSON.stringify([actual.day,row.personId,row.currency]);groups.set(key,[...(groups.get(key)??[]),row]);
  }
  for(const group of groups.values()){
   const total=group.reduce((sum,row)=>sum.add(row.amount),new Money(0));
   if(group.length>1&&(threshold.operator==='greater_equal'?total.gte(bound):total.gt(bound)))
    for(const row of group)reasons.get(row.id)!.push(`possible_threshold_split:${threshold.id}:v${threshold.version}`);
  }
 }
 return rows.filter(row=>reasons.get(row.id)!.length).map(row=>({row,reasons:reasons.get(row.id)!,classification:'candidate' as const}));
}
