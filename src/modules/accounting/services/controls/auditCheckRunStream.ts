import {createHash} from 'node:crypto';
import Decimal from 'decimal.js';
import {sql} from '@/lib/neon';
import {log} from '@/lib/logger';
import type {ControlTx} from './contracts';
import {canonicalMoney} from './canonical';
import {CheckRunResourceLimitError} from './auditCheckRunBudget';
import {journalRiskMissingReasons,type JournalRiskSourceRow} from './journalRiskShared';
import {journalRiskPopulationSql} from './journalRiskPopulationSql';
import type {AUDIT_CHECK_RUN_LIMITS} from './auditCheckRunContract';
export type CheckRunLimits=typeof AUDIT_CHECK_RUN_LIMITS.journal_risk_checks;
const CURSOR='audit_check_run_journals';
interface CursorRow extends JournalRiskSourceRow {slab_day:string|null;slab_person:string|null;slab_currency:string|null;lines?:unknown}
export interface CheckRunPopulation {populationCount:number;missing:string[];populationDigest:string;populationTotals:Record<string,string>;sourceVersionCount:number}
export interface CheckRunStreamInput {
 cutoff:string;limits:CheckRunLimits;check:()=>void;onSlab:(rows:readonly JournalRiskSourceRow[])=>Promise<void>;
 /** Whether this row can join ANY threshold group; the shared detector's own eligibility, never a copy of it. */
 groupable:(row:JournalRiskSourceRow)=>boolean;
}
/**
 * One NO SCROLL cursor over the complete population inside the caller's repeatable-read transaction. Slabs are cut on
 * the SQL-computed (day, person, currency) tuple and carried across FETCH pages, so a threshold group that straddles a
 * page is still analysed whole. Both LATERALs travel with the cursor row: there is no per-parent child query.
 *
 * Only rows that can join a threshold group are held in the slab and counted against `maxSlabRows`. A row that can
 * join none has a result that depends on no other row, so it is analysed at once, alone, by the same detector — one
 * busy posting day of ungroupable journals can no longer make a tenant's every run `unknown`.
 */
export async function streamJournalRiskSlabs(ctx:ControlTx,input:CheckRunStreamInput):Promise<CheckRunPopulation>{
 const {limits,check,onSlab,groupable}=input;
 if(!/^\d{1,4}MB$/.test(limits.workMem))throw new Error('Invalid check-run work memory bound');
 if(!Number.isSafeInteger(limits.fetchRows)||limits.fetchRows<1||limits.fetchRows>100000)throw new Error('Invalid check-run fetch size');
 await ctx.sql`${sql.unsafe(`SET LOCAL work_mem='${limits.workMem}'`)}`;
 await ctx.sql`DECLARE audit_check_run_journals NO SCROLL CURSOR FOR ${journalRiskPopulationSql({companyId:ctx.principal.companyId,cutoff:input.cutoff,slabTuple:true})}`;
 const fetchPage=sql.unsafe(`FETCH ${limits.fetchRows} FROM ${CURSOR}`);
 const Money=Decimal.clone({precision:80}),totals:Record<string,string>={},digest=createHash('sha256');
 const missing=new Set<string>();let populationCount=0,sourceVersionCount=0;
 let slab:JournalRiskSourceRow[]=[],slabKey:string|null=null;
 async function flush(){if(!slab.length)return;check();await onSlab(slab);slab=[];check();}
 try{
  for(;;){
   check();
   const page=await ctx.sql`${fetchPage}` as CursorRow[];
   if(!page.length)break;
   for(const row of page){
    // Line facts travel with the cursor for the sync row shape; the detector never reads them, so none are held.
    const {slab_day:day,slab_person:person,slab_currency:currency,lines:_lines,...source}=row;
    populationCount++;if(source.version!==null&&source.version!==undefined)sourceVersionCount++;
    for(const reason of journalRiskMissingReasons(source))missing.add(reason);
    digest.update(`${source.id}\n${source.version??''}\n${source.accountingDate}\n${source.actualAt}\n${source.amount}\n${source.currency}\n`);
    if(/^[A-Z]{3}$/.test(source.currency)){
     const amount=new Money(canonicalMoney(source.amount));
     if(amount.isFinite())totals[source.currency]=new Money(totals[source.currency]??'0').add(amount).toFixed();
    }
    const key=JSON.stringify([day,person,currency]);
    if(key!==slabKey){await flush();slabKey=key;}
    if(!groupable(source)){check();await onSlab([source]);continue;}
    slab.push(source);
    if(slab.length>limits.maxSlabRows)throw new CheckRunResourceLimitError('slab_rows_exceed_limit');
   }
   if(page.length<limits.fetchRows)break;
  }
  await flush();
 }finally{
  // The cursor dies with the transaction either way; CLOSE only frees it early on the success path. On the failure
  // path the transaction is already unusable or about to roll back, so a refusal here is recorded, never raised over
  // the original error.
  try{await ctx.sql`${sql.unsafe(`CLOSE ${CURSOR}`)}`;}
  catch(error){log.warn('Audit check run cursor could not be closed before rollback',{message:error instanceof Error?error.message:'unknown'},'audit-worker');}
 }
 return{populationCount,missing:[...missing].sort(),populationDigest:digest.digest('hex'),populationTotals:totals,sourceVersionCount};
}
