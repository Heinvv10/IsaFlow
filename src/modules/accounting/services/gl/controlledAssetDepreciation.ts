import { randomUUID } from 'node:crypto';
import { replayKnownOperationEffect } from '../controls/operationReceiptReplay';
import { depreciationEntryNumber } from '../items/depreciationRunPlan';
import { UUID_RE, isRealCalendarDate } from '@/lib/validation';
import { assertEffectivePermission } from '@/lib/auth/effectivePermissions';
import { withSavepoint } from '@/lib/neon';
import { requireControlTx } from '../controls/context';
import { canonicalIntentId, loadIntentReceipt, sameIntentId } from '../controls/intentIdentity';
import { loadOperationMaterial } from '../controls/operationMaterializer';
import { materializeAssetDepreciationOperation } from '../controls/assetDepreciationOperationMaterializer';
import { initializeOperationObservations } from '../controls/approvalRequestService';
import { executeControlledOperation } from '../controls/approvalExecutionService';
import { registerGeneratedJournal } from '../controls/generatedJournalPermit';
import { readControlEntityVersion } from '../controls/operationVersions';
import { recordCommittedChange } from '../controls/changeEventService';
import { postJournalEntry } from './journalEntryPostingService';
import type { ControlTx } from '../controls/contracts';
import type { calculateExactDepreciation, ExactPostingLine } from './glBypassExactPlans';
type Row=Record<string,unknown>;
type Calculation=ReturnType<typeof calculateExactDepreciation>;
interface Facts { company:Row; asset:Row; intent:Row; accounts:Row[]; period:Row; ledgers:Row[]; input:Row; calculation:Calculation; plan:ExactPostingLine[] }
export interface AssetDepreciationResult { intentId:string; assetId:string; journalEntryId:string|null; policyDep:string; taxDep:string; accountingDate:string }
const ref=(entityId:string)=>({entityType:'asset_depreciation_intent',entityId,operation:'asset_depreciation.post' as const});
function actor(companyId:string,userId:string):ControlTx {
 const ctx=requireControlTx();
 if(ctx.principal.companyId!==companyId||ctx.principal.personId!==userId)throw new Error('Depreciation actor does not match authenticated context');
 return ctx;
}
export async function prepareAssetDepreciation(companyId:string,userId:string,assetId:string,periodDate:string){
 const ctx=actor(companyId,userId);await assertEffectivePermission(ctx,'write:assets');
 if(!UUID_RE.test(assetId)||!isRealCalendarDate(periodDate))throw new Error('Invalid asset depreciation input');
 return withSavepoint('prepare_asset_depreciation',async()=>{
  let intentId:string=randomUUID();
  await ctx.sql`INSERT INTO control_asset_depreciation_intents(company_id,id,requester_person_id,asset_id,period_date)
   VALUES(${companyId}::uuid,${intentId}::uuid,${userId},${assetId}::uuid,${periodDate}::date) ON CONFLICT DO NOTHING`;
  const [stored]=await ctx.sql`SELECT id,requester_person_id,period_date::text FROM control_asset_depreciation_intents
   WHERE company_id=${companyId}::uuid AND asset_id=${assetId}::uuid AND period_key=${periodDate.slice(0,7).replace('-','')}` as Row[];
  if(!stored||stored.requester_person_id!==userId||stored.period_date!==periodDate)throw new Error('Existing depreciation intent belongs to another requester or date');
  intentId=String(stored.id);
  const material=await loadOperationMaterial(ctx,ref(intentId));await initializeOperationObservations(ctx,material);
  return{intentId,operation:ref(intentId),amount:material.binding.amount!,currency:material.binding.currency!,
   requiresApproval:material.binding.policies.length>0,status:material.binding.policies.length?'approval_required' as const:'prepared' as const};
 });
}
async function receipt(ctx:ControlTx,intentId:string):Promise<AssetDepreciationResult|null>{
 const effect=await loadIntentReceipt<AssetDepreciationResult>(ctx,ref(intentId));
 if(!effect)return null;
 if(!sameIntentId(effect.result.intentId,intentId))throw new Error('Invalid depreciation receipt');
 if(effect.result.journalEntryId){
  const rows=await ctx.sql`SELECT id FROM gl_journal_entries WHERE company_id=${ctx.principal.companyId}::uuid
   AND id=${effect.result.journalEntryId}::uuid AND source='auto_depreciation' AND source_record_id=${intentId}::uuid
   AND status='posted' AND reversed_at IS NULL FOR SHARE`;
  if(rows.length!==1)throw new Error('Depreciation receipt journal has changed');
 }
 return replayKnownOperationEffect<AssetDepreciationResult>(ctx,ref(intentId),effect.id);
}
export async function executeAssetDepreciation(companyId:string,userId:string,inputIntentId:string,options?:{approvalId?:string}):Promise<AssetDepreciationResult>{
 const ctx=actor(companyId,userId);await assertEffectivePermission(ctx,'write:assets');await assertEffectivePermission(ctx,'write:post');
 if(!UUID_RE.test(inputIntentId))throw new Error('Invalid depreciation intent');
 const intentId=canonicalIntentId(inputIntentId);
 const [intent]=await ctx.sql`SELECT requester_person_id FROM control_asset_depreciation_intents
  WHERE company_id=${companyId}::uuid AND id=${intentId}::uuid` as Row[];
 if(!intent||intent.requester_person_id!==userId)throw new Error('Depreciation intent does not belong to requester');
 if(!options?.approvalId){const prior=await receipt(ctx,intentId);if(prior)return prior;}
 const parent=ref(intentId);
 return executeControlledOperation(ctx,parent,options?.approvalId??null,async permit=>{
  if(await receipt(ctx,intentId))throw new Error('Depreciation intent already executed');
  const material=await materializeAssetDepreciationOperation(ctx,parent),facts=material.observedSources[0]!.facts as unknown as Facts;
  if(facts.company.lockdown_enabled===true&&(!facts.company.lockdown_date||permit.accountingDate<=String(facts.company.lockdown_date)))throw new Error('Depreciation date is within company lockdown');
  if(facts.period.status!=='open'||facts.accounts.some(a=>a.is_active!==true))throw new Error('Depreciation period or accounts are not open');
  const assetId=String(facts.asset.id),yyyymm=permit.accountingDate.slice(0,7).replace('-','');
  if(facts.ledgers.some(row=>row.yyyymm===yyyymm))throw new Error('Depreciation period already exists; explicit correction required');
  const c=facts.calculation;
  let journalEntryId:string|null=null;
  if(facts.plan.length){
   journalEntryId=randomUUID();
   await ctx.sql`INSERT INTO gl_journal_entries(id,company_id,entry_number,entry_date,fiscal_period_id,description,source,source_record_id,status,created_by,posting_agent)
    VALUES(${journalEntryId}::uuid,${companyId}::uuid,${depreciationEntryNumber(String(facts.asset.asset_number),permit.accountingDate)},${permit.accountingDate}::date,${facts.period.id}::uuid,
     'Asset depreciation','auto_depreciation',${intentId}::uuid,'draft',${userId}::uuid,${`human:${userId}`})`;
   for(const line of facts.plan)await ctx.sql`INSERT INTO gl_journal_lines(company_id,journal_entry_id,gl_account_id,debit,credit,description)
    VALUES(${companyId}::uuid,${journalEntryId}::uuid,${line.glAccountId}::uuid,${line.debit},${line.credit},'Asset depreciation')`;
   const parentControl={permit,parent};await registerGeneratedJournal(ctx,parentControl,journalEntryId,'journal.post');
   await postJournalEntry(companyId,journalEntryId,userId,{parentControl});
  }
  await ctx.sql`INSERT INTO asset_period_ledger(company_id,asset_id,period_date,yyyymm,policy_cost,policy_opening_acc_dep,policy_current_dep,
   policy_closing_acc_dep,policy_carrying_amount,policy_dep_rate,tax_cost,tax_opening_acc_dep,tax_current_dep,tax_closing_acc_dep,tax_carrying_amount,deferred_tax)
   VALUES(${companyId}::uuid,${assetId}::uuid,${permit.accountingDate}::date,${yyyymm},${facts.input.cost},${facts.input.openingAccDep},${c.policyDep},
    ${c.policyClosing},${c.policyCarrying},${c.policyRate},${facts.input.cost},${facts.input.taxOpeningAccDep},${c.taxDep},${c.taxClosing},${c.taxCarrying},${c.deferredTax})`;
  const [after]=await ctx.sql`UPDATE assets SET accumulated_depreciation=${c.policyClosing},current_book_value=${c.policyCarrying},
   tax_accumulated_depreciation=${c.taxClosing},updated_at=clock_timestamp() WHERE company_id=${companyId}::uuid AND id=${assetId}::uuid RETURNING *` as Row[];
  if(!after)throw new Error('Depreciation asset disappeared');
  const version=await readControlEntityVersion(ctx,{entityType:'asset',entityId:assetId});
  await recordCommittedChange(ctx,{entityType:'asset',entityId:assetId,previousVersion:version?.version??null,newVersion:(version?.version??0)+1,
   action:'asset.depreciated',accountingDate:permit.accountingDate,before:facts.asset,after,bindingHash:null,protectedEvidenceRef:null,operationId:permit.operationId});
  return{intentId,assetId,journalEntryId,policyDep:c.policyDep,taxDep:c.taxDep,accountingDate:permit.accountingDate};
 });
}
