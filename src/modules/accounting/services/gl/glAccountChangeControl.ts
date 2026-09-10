import {withTransaction} from '@/lib/neon';
import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import {loadPermissionState,EffectivePermissionError} from '@/lib/auth/effectivePermissionQueries';
import {permissionReason} from '@/lib/auth/effectivePermissionPolicy';
import {requireControlTx} from '../controls/context';
import {recordCommittedChange} from '../controls/changeEventService';
import {canonicalJson} from '../controls/canonical';
import {readGlChangeRows,meaningfulGlRow,type GlAccountRow,type GlAccountSelection} from './glAccountChangeRows';
/** Fixed chart authority; caller bodies cannot choose permissions or supply evidence. */
export async function withGlAccountChanges<T>(companyId:string,selection:GlAccountSelection,action:string,
 mutate:(before:readonly GlAccountRow[])=>Promise<T>):Promise<T>{
 const ctx=requireControlTx(),owned=JSON.parse(canonicalJson(selection)) as GlAccountSelection;
 if(ctx.principal.companyId!==companyId)throw new Error('GL company does not match authenticated context');
 const state=await loadPermissionState(ctx);
 if(permissionReason(state.role,'write:accounts',state.scopes,state.overrides,true))throw new EffectivePermissionError();
 // Future opening/admin integrations must take this BEFORE any account/journal row lock.
 await ctx.sql`SELECT pg_advisory_xact_lock(hashtextextended(${'gl-account-mutation:'+companyId},0))`;
 return withTransaction(async()=>{
  const before=await readGlChangeRows(ctx,owned);
  for(const row of before)await assertEffectivePermission(ctx,'write:accounts',{entityType:'gl_account',entityId:row.id});
  if(owned.codes?.some(code=>!before.some(row=>row.account_code===code)))await assertEffectivePermission(ctx,'write:accounts');
  if(owned.ids?.some(id=>!before.some(row=>row.id===id))||(owned.descendantsOf&&!before.some(row=>row.id===owned.descendantsOf)))throw new Error('Account not found');
  const versions=before.length?await ctx.sql`SELECT entity_id,version FROM control_entity_versions WHERE company_id=${companyId}::uuid
   AND entity_type='gl_account' AND entity_id=ANY(${before.map(row=>row.id)}::text[]) ORDER BY entity_id FOR UPDATE` as {entity_id:string;version:number|string}[]:[];
  const result=await mutate(before);
  const after=await readGlChangeRows(ctx,{ids:before.map(row=>row.id),codes:owned.codes??[]});
  if(before.some(row=>!after.some(next=>next.id===row.id))||owned.codes?.some(code=>!after.some(row=>row.account_code===code)))throw new Error('Expected GL mutation was not retained');
  const previous=new Map(before.map(row=>[row.id,row])),versionById=new Map(versions.map(row=>[row.entity_id,Number(row.version)]));
  for(const row of after){
   const prior=previous.get(row.id)??null;if(meaningfulGlRow(prior)===meaningfulGlRow(row))continue;
   await assertEffectivePermission(ctx,'write:accounts',{entityType:'gl_account',entityId:row.id});
   const version=versionById.get(row.id)??null;
   await recordCommittedChange(ctx,{entityType:'gl_account',entityId:row.id,previousVersion:version,newVersion:version===null?1:version+1,
    action,accountingDate:null,before:prior,after:row,bindingHash:null,protectedEvidenceRef:null});
  }
  return result;
 });
}
