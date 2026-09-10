import {createHash} from 'node:crypto';
import {withTransaction} from '@/lib/neon';
import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import {requireControlTx} from '../controls/context';
import {canonicalJson} from '../controls/canonical';
import {recordCommittedChange} from '../controls/changeEventService';
import {readGlChangeRows,meaningfulGlRow} from './glAccountChangeRows';
import {assertMergePopulation,mergePopulation,readMergeJournals} from './glMergeChangeRows';
import type {MergeAccountsResult} from './accountMergeService';
import {digestLineIds} from './accountMergePreview';

/** Company, sorted journals, lines, then accounts: compatible with ordinary posting. */
export async function withGlMergeChanges(companyId:string,source:string,target:string,
 mutate:()=>Promise<MergeAccountsResult>):Promise<MergeAccountsResult>{
 const ctx=requireControlTx();
 if(ctx.principal.companyId!==companyId)throw new Error('GL company does not match authenticated context');
 await assertEffectivePermission(ctx,'write:accounts');await assertEffectivePermission(ctx,'write:post');
 await ctx.sql`SELECT pg_advisory_xact_lock(hashtextextended(${'gl-account-mutation:'+companyId},0))`;
 return withTransaction(async()=>{
  const population=await mergePopulation(ctx,source,target);
  if(!population.accounts.includes(source)||!population.accounts.includes(target))throw new Error('Account not found');
  const ids=[...new Set(population.lines.map(row=>row.journal_entry_id))].sort();
  const journals=await readMergeJournals(ctx,ids);
  const accountIds=[...new Set([...population.accounts,...journals.flatMap(j=>j.lines.map(line=>String(line.gl_account_id)))])].sort();
  const accounts=await readGlChangeRows(ctx,{ids:accountIds});
  if(accounts.length!==accountIds.length)throw new Error('Merge journal account not found');
  assertMergePopulation(population,await mergePopulation(ctx,source,target));
  const priorSource=accounts.find(a=>a.id===source)!,priorTarget=accounts.find(a=>a.id===target)!;
  const delta=Number(priorTarget.level)-Number(priorSource.level);
  const changedAccounts=population.accounts.filter(id=>id===source||id===target||delta!==0||accounts.find(a=>a.id===id)?.parent_account_id===source);
  for(const id of changedAccounts)await assertEffectivePermission(ctx,'write:accounts',{entityType:'gl_account',entityId:id});
  const periodIds=[...new Set(journals.map(j=>j.header.fiscal_period_id).filter((id):id is string=>typeof id==='string'))].sort();
  await ctx.sql`SELECT id FROM fiscal_periods WHERE company_id=${companyId}::uuid AND id=ANY(${periodIds}::uuid[]) ORDER BY id FOR SHARE`;
  const versions=await ctx.sql`SELECT entity_type,entity_id,version FROM control_entity_versions WHERE company_id=${companyId}::uuid
   AND ((entity_type='gl_account' AND entity_id=ANY(${changedAccounts}::text[])) OR (entity_type='journal_entry' AND entity_id=ANY(${ids}::text[])))
   ORDER BY entity_type,entity_id FOR UPDATE` as {entity_type:string;entity_id:string;version:string|number}[];
  const result=await mutate();
  if(result.movedLinesDigest!==digestLineIds(population.lines.map(line=>line.id))||result.linesRepointed!==population.lines.length
   ||result.entriesAffected!==ids.length)throw new Error('Merge recovery population changed');
  const afterAccounts=await readGlChangeRows(ctx,{ids:accountIds}),afterJournals=await readMergeJournals(ctx,ids);
  if(afterAccounts.length!==accounts.length)throw new Error('Merge account population changed');
  const expectedChildren=accounts.filter(a=>a.parent_account_id===source);
  if(result.childAccountsReparented!==expectedChildren.length||result.descendantsRelevelled!==(delta===0?0:population.accounts.length-2))throw new Error('Merge tree population changed');
  const recovery=await ctx.sql`SELECT source_account_id,target_account_id,moved_line_ids,moved_line_ids_digest,
   reparented_account_ids,relevelled_account_ids,merged_by FROM gl_account_merges WHERE company_id=${companyId}::uuid AND id=${result.mergeRecordId}::uuid` as {
    source_account_id:string;target_account_id:string;moved_line_ids:string[];moved_line_ids_digest:string;
    reparented_account_ids:string[];relevelled_account_ids:string[];merged_by:string}[];
  const record=recovery[0],descendants=population.accounts.filter(id=>id!==source&&id!==target);
  if(recovery.length!==1||!record||record.source_account_id!==source||record.target_account_id!==target||record.merged_by!==ctx.principal.personId
   ||record.moved_line_ids_digest!==result.movedLinesDigest||canonicalJson([...record.moved_line_ids].sort())!==canonicalJson(population.lines.map(l=>l.id))
   ||canonicalJson([...record.reparented_account_ids].sort())!==canonicalJson(expectedChildren.map(a=>a.id).sort())
   ||canonicalJson([...record.relevelled_account_ids].sort())!==canonicalJson(delta===0?[]:descendants))throw new Error('Merge recovery evidence was not retained');
  for(const row of afterAccounts){
   const before=accounts.find(a=>a.id===row.id)!;
   const expected={...before,...(row.id===source?{is_active:false}:{}),
    ...(before.parent_account_id===source?{parent_account_id:target}:{}),
    ...(population.accounts.includes(row.id)&&row.id!==source&&row.id!==target?{level:Number(before.level)+delta}:{})};
   if(meaningfulGlRow(expected)!==meaningfulGlRow(row))throw new Error('Expected GL merge account mutation was not retained');
  }
  for(const before of journals){
   const after=afterJournals.find(j=>j.header.id===before.header.id)!;
   if(canonicalJson(before.header)!==canonicalJson(after.header)||before.lines.length!==after.lines.length)throw new Error('Merge journal population changed');
   for(let i=0;i<before.lines.length;i++){
    const {updated_at:ignoredBefore,...line}=before.lines[i]!,{updated_at:ignoredAfter,...next}=after.lines[i]!;void ignoredBefore;void ignoredAfter;
    const expected={...line,gl_account_id:line.gl_account_id===source?target:line.gl_account_id};
    if(canonicalJson(expected)!==canonicalJson(next))throw new Error('Expected GL merge journal mutation was not retained');
   }
  }
  const bindingHash=createHash('sha256').update(canonicalJson({mergeRecordId:result.mergeRecordId,sourceAccountId:source,targetAccountId:target,movedLinesDigest:result.movedLinesDigest})).digest('hex');
  const capture=async(entityType:string,entityId:string,before:Record<string,unknown>,after:Record<string,unknown>,accountingDate:string|null)=>{
   const row=versions.find(v=>v.entity_type===entityType&&v.entity_id===entityId),version=row?Number(row.version):null;
   await recordCommittedChange(ctx,{entityType,entityId,previousVersion:version,newVersion:version===null?1:version+1,
    action:`accounts_merged:${result.mergeRecordId}`,accountingDate,before,after,bindingHash,protectedEvidenceRef:null});
  };
  for(const row of afterAccounts){const before=accounts.find(a=>a.id===row.id)!;if(meaningfulGlRow(before)!==meaningfulGlRow(row))await capture('gl_account',row.id,before,row,null);}
  for(const before of journals){
   const after=afterJournals.find(j=>j.header.id===before.header.id)!;
   const beforeIds=new Set(before.lines.map(line=>line.gl_account_id)),afterIds=new Set(after.lines.map(line=>line.gl_account_id));
   await capture('journal_entry',before.header.id,{...before,accounts:accounts.filter(a=>beforeIds.has(a.id))},
    {...after,accounts:afterAccounts.filter(a=>afterIds.has(a.id))},before.header.entry_date);
  }
  return result;
 });
}
