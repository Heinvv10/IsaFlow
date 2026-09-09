/** Read-only preview derives the same locked persisted facts as depreciation execution. */
import type {DbRow} from '@/lib/neon';
import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import {requireControlTx} from '../controls/context';
import {loadAssetDepreciationFacts} from '../controls/assetDepreciationOperationMaterializer';
import type {DepreciationPlan} from './depreciationRunPlan';
import type {DryRunJournal,DryRunSkip} from '@/lib/mcp/contracts';
export interface DepreciationPreview {journals:DryRunJournal[];writesWithoutJournal:DryRunSkip[]}
export async function previewDepreciationJournals(companyId:string,plan:DepreciationPlan,_assets:DbRow[]):Promise<DepreciationPreview>{
 const ctx=requireControlTx();
 if(ctx.principal.companyId!==companyId)throw new Error('Depreciation preview company does not match authenticated context');
 await assertEffectivePermission(ctx,'read:assets');
 if(plan.postable.length>10000)throw new Error('Depreciation preview population exceeds its bound');
 const [company]=await ctx.sql`SELECT id,default_currency,lockdown_enabled,lockdown_date::text FROM companies WHERE id=${companyId}::uuid FOR SHARE` as Record<string,unknown>[];
 if(!company)throw new Error('Depreciation company not found');
 const journals:DryRunJournal[]=[],writesWithoutJournal:DryRunSkip[]=[];
 for(const row of plan.postable){
  const facts=await loadAssetDepreciationFacts(ctx,company,{asset_id:row.assetId,period_date:plan.periodDate});
  if(company.lockdown_enabled===true&&(!company.lockdown_date||plan.periodDate<=String(company.lockdown_date)))throw new Error('Depreciation date is within company lockdown');
  if(facts.period.status!=='open'||facts.accounts.some(a=>a.is_active!==true))throw new Error('Depreciation period or accounts are not open');
  if(!facts.plan.length){
   writesWithoutJournal.push({id:row.assetId,reason:'subledger_row_only_no_journal',detail:`No policy journal; persisted tax depreciation ${facts.calculation.taxDep} and carrying amounts would update the asset period ledger.`});
   continue;
  }
  const lines=facts.plan.map(line=>{const account=facts.accounts.find(a=>a.id===line.glAccountId)!;return{
   accountId:line.glAccountId,accountCode:String(account.account_code),accountName:String(account.account_name),
   debit:Number(line.debit),credit:Number(line.credit),exactDebit:line.debit,exactCredit:line.credit};});
  const journal={date:plan.periodDate,description:`Depreciation: ${row.name} (${row.assetNumber})`,fiscalPeriodId:String(facts.period.id),
   lines,totalDebit:Number(facts.calculation.policyDep),totalCredit:Number(facts.calculation.policyDep),exactTotal:facts.calculation.policyDep};
  journals.push(journal);
 }
 return{journals,writesWithoutJournal};
}
