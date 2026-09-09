import {randomUUID} from 'node:crypto';
import {YearEndEligibilityError} from '../controls/yearEndEligibilityError';
import {canonicalJson} from '../controls/canonical';
import {replayKnownOperationEffect} from '../controls/operationReceiptReplay';
import {fmtDate} from '@/lib/fmtDate';
import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import {requireControlTx} from '../controls/context';
import {loadOperationMaterial} from '../controls/operationMaterializer';
import {executeControlledOperation} from '../controls/approvalExecutionService';
import {registerGeneratedJournal} from '../controls/generatedJournalPermit';
import {readControlEntityVersion} from '../controls/operationVersions';
import {recordCommittedChange} from '../controls/changeEventService';
import {postJournalEntry} from './journalEntryPostingService';
import type {ControlTx} from '../controls/contracts';
import type {buildYearEndFinancialMaterial} from '../controls/yearEndFinancialMaterial';
import type {CloseYearOptions,CloseYearResult,CloseYearDryRunResult,CloseYearError,YearEndJournalPreview} from './yearEndCloseService';
type Row=Record<string,unknown>;
type Closing=Awaited<ReturnType<typeof buildYearEndFinancialMaterial>>;
interface Facts {company:Row;periods:Row[];accounts:Row[];closing:Closing}
function actor(companyId:string,userId:string):ControlTx {
 const ctx=requireControlTx();if(ctx.principal.companyId!==companyId||ctx.principal.personId!==userId)throw new Error('Year-close actor does not match authenticated context');return ctx;
}
function preview(year:string,facts:Facts):YearEndJournalPreview {
 const c=facts.closing,accounts=[...facts.accounts,c.retained];
 return{entryDate:c.accountingDate,entryNumber:`YE-${year}`,description:`Year ${year} close`,
  lines:c.plan.map(line=>{const account=accounts.find(a=>a.id===line.glAccountId);return{accountId:line.glAccountId,
   accountCode:String(account?.account_code??''),accountName:String(account?.account_name??''),debit:Number(line.debit),credit:Number(line.credit),
   exactDebit:line.debit,exactCredit:line.credit};}),totalDebit:Number(c.amount),totalCredit:Number(c.amount),exactTotal:c.amount};
}
async function prior(ctx:ControlTx,year:string):Promise<CloseYearResult|null>{
 const [effect]=await ctx.sql`SELECT id,result FROM control_operation_effects WHERE company_id=${ctx.principal.companyId}::uuid
  AND entity_type='fiscal_year' AND entity_id=${year} AND operation='year.close' ORDER BY committed_at DESC LIMIT 1` as {id:string;result:CloseYearResult}[];
 if(!effect)return null;
 const journalId=effect.result.closingEntry.id;
 if(journalId){
  const rows=await ctx.sql`SELECT id FROM gl_journal_entries WHERE company_id=${ctx.principal.companyId}::uuid AND id=${journalId}::uuid
   AND source='year_end' AND entry_number=${`YE-${year}`} AND status='posted' AND reversed_at IS NULL FOR SHARE`;
  if(rows.length!==1)throw new Error('Year closing receipt journal changed');
 }
 return replayKnownOperationEffect<CloseYearResult>(ctx,{entityType:'fiscal_year',entityId:year,operation:'year.close'},effect.id);
}
export async function closeFiscalYear(companyId:string,yearLabel:string,userId:string,options:CloseYearOptions={}):Promise<CloseYearResult|CloseYearDryRunResult|CloseYearError>{
 const ctx=actor(companyId,userId);await assertEffectivePermission(ctx,options.dryRun?'read:reports':'write:locks');
 if(!/^[1-9][0-9]{3}$/.test(yearLabel))throw new Error('Invalid financial year');
 const parent={entityType:'fiscal_year',entityId:yearLabel,operation:'year.close' as const};
 if(!options.dryRun){
  await assertEffectivePermission(ctx,'write:post');const result=await prior(ctx,yearLabel);
  if(result)return options.approvalId?executeControlledOperation<CloseYearResult>(ctx,parent,options.approvalId,async()=>{throw new Error('Receipt replay cannot create a new effect');}):result;
 }
 let material:Awaited<ReturnType<typeof loadOperationMaterial>>;
 try{material=await loadOperationMaterial(ctx,parent);}catch(error){if(error instanceof YearEndEligibilityError)return error.result;throw error;}
 const facts=material.observedSources[0]!.facts as unknown as Facts;
 if(facts.company.lockdown_enabled===true&&(!facts.company.lockdown_date||facts.closing.accountingDate<=String(facts.company.lockdown_date)))throw new Error('Year-close date is within company lockdown');
 const open=facts.periods.filter(p=>p.status==='open');
 if(open.length)return{error:'open_periods',count:open.length,openPeriods:open.map(p=>({id:String(p.id),periodName:String(p.period_name),periodNumber:Number(p.period_number)}))};
 if(facts.periods.some(p=>p.status!=='closed'))throw new Error('Financial year contains locked periods');
 if(facts.closing.retained.is_active!==true)throw new Error('Retained earnings account is inactive');
 if(options.dryRun)return{dryRun:true,netIncome:Number(facts.closing.netIncome),netIncomeExact:facts.closing.netIncome,preview:preview(yearLabel,facts)};
 return executeControlledOperation(ctx,parent,options.approvalId??null,async permit=>{
  if(await prior(ctx,yearLabel))throw new Error('Financial year already closed');
  const current=await loadOperationMaterial(ctx,parent),live=current.observedSources[0]!.facts as unknown as Facts;
  if(live.company.lockdown_enabled===true&&(!live.company.lockdown_date||permit.accountingDate<=String(live.company.lockdown_date)))throw new Error('Year-close date is within company lockdown');
  if(live.periods.some(p=>p.status!=='closed')||live.closing.retained.is_active!==true)throw new Error('Financial year source is no longer eligible');
  const closing=live.closing,period=live.periods.find(p=>fmtDate(p.end_date as string|Date)===permit.accountingDate);
  if(!period)throw new Error('Closing fiscal period unavailable');
  let entry:Row={id:null,source:'year_end',entry_date:permit.accountingDate,emptyYear:true};
  if(closing.plan.length){
   const id=randomUUID();
   const [created]=await ctx.sql`INSERT INTO gl_journal_entries(id,company_id,entry_number,entry_date,fiscal_period_id,description,source,status,created_by,posting_agent)
    VALUES(${id}::uuid,${companyId}::uuid,${`YE-${yearLabel}`},${permit.accountingDate}::date,${period.id}::uuid,
     ${`Year ${yearLabel} close`},'year_end','draft',${userId}::uuid,${`human:${userId}`}) RETURNING *` as Row[];
   if(!created)throw new Error('Closing journal was not created');
   for(const line of closing.plan)await ctx.sql`INSERT INTO gl_journal_lines(company_id,journal_entry_id,gl_account_id,debit,credit,description)
    VALUES(${companyId}::uuid,${id}::uuid,${line.glAccountId}::uuid,${line.debit},${line.credit},'Year-end close')`;
   const parentControl={permit,parent};await registerGeneratedJournal(ctx,parentControl,id,'journal.post');
   await postJournalEntry(companyId,id,userId,{parentControl});
   const [posted]=await ctx.sql`SELECT * FROM gl_journal_entries WHERE company_id=${companyId}::uuid AND id=${id}::uuid` as Row[];
   if(!posted||posted.status!=='posted')throw new Error('Closing journal posting outcome unavailable');
   entry=JSON.parse(canonicalJson(posted)) as Row;
  }
  for(const before of live.periods){
   const [after]=await ctx.sql`UPDATE fiscal_periods SET status='locked' WHERE company_id=${companyId}::uuid AND id=${before.id}::uuid AND status='closed' RETURNING *` as Row[];
   if(!after)throw new Error('Year period changed during close');
   const entity={entityType:'fiscal_period',entityId:String(before.id)},version=await readControlEntityVersion(ctx,entity);
   await recordCommittedChange(ctx,{...entity,previousVersion:version?.version??null,newVersion:(version?.version??0)+1,action:'fiscal_period.locked',
    accountingDate:permit.accountingDate,before,after,bindingHash:current.bindingHash,protectedEvidenceRef:null,operationId:permit.operationId});
  }
  return{closingEntry:entry,netIncome:Number(closing.netIncome),netIncomeExact:closing.netIncome,message:`Year ${yearLabel} closed. Net income ${closing.netIncome} transferred to retained earnings.`};
 });
}
