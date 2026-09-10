import {withTransaction} from '@/lib/neon';
import {cache} from '@/lib/cache';
import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import {loadPermissionState,EffectivePermissionError} from '@/lib/auth/effectivePermissionQueries';
import {permissionReason} from '@/lib/auth/effectivePermissionPolicy';
import type {ControlTx} from '../controls/contracts';
import {assertControlTx} from '../controls/context';
import {canonicalJson} from '../controls/canonical';
import {recordCommittedChange} from '../controls/changeEventService';
import {clearSystemAccountCache} from './systemAccountResolver';
import {readGlChangeRows,meaningfulGlRow} from './glAccountChangeRows';
import {parseDefaultAccountsInput} from './defaultAccountsInput';
import {DEFAULT_SETTINGS_KEY,defaultAccountIds,readDefaultSettings,sameMappings,expectedDefaultRows,assertDefaultRows} from './defaultAccountsRows';
/** Whole-map replacement; authenticated authority and mandatory history share the mutation. */
export async function saveDefaultAccounts(ctx:ControlTx,value:unknown):Promise<{saved:true}>{
 assertControlTx(ctx);const mappings=parseDefaultAccountsInput(value),c=ctx.principal.companyId;
 const permission=await loadPermissionState(ctx);
 if(permissionReason(permission.role,'write:accounts',permission.scopes,permission.overrides,true))throw new EffectivePermissionError();
 await ctx.sql`SELECT pg_advisory_xact_lock(hashtextextended(${'gl-account-mutation:'+c},0))`;
 return withTransaction(async()=>{
  const ids=await defaultAccountIds(ctx,mappings),before=await readGlChangeRows(ctx,{ids});
  if(canonicalJson(ids)!==canonicalJson(await defaultAccountIds(ctx,mappings)))throw new Error('Default account population changed');
  for(const row of before)await assertEffectivePermission(ctx,'write:accounts',{entityType:'gl_account',entityId:row.id});
  if(!before.length)await assertEffectivePermission(ctx,'write:accounts');
  const expected=expectedDefaultRows(before,mappings);
  const prior=await readDefaultSettings(ctx),settingsChanged=!sameMappings(prior,mappings);
  const changed=expected.filter((row,i)=>meaningfulGlRow(row)!==meaningfulGlRow(before[i]!));
  if(!settingsChanged&&!changed.length)return{saved:true};
  const versions=await ctx.sql`SELECT entity_type,entity_id,version FROM control_entity_versions WHERE company_id=${c}::uuid
   AND ((entity_type='gl_account' AND entity_id=ANY(${changed.map(row=>row.id)}::text[])) OR (entity_type='accounting_default_accounts' AND entity_id=${c}))
   ORDER BY entity_type,entity_id FOR UPDATE` as {entity_type:string;entity_id:string;version:number|string}[];
  for(const row of changed){
   const rows=await ctx.sql`UPDATE gl_accounts SET is_system_account=${row.is_system_account},account_subtype=${row.account_subtype}
    WHERE company_id=${c}::uuid AND id=${row.id}::uuid RETURNING id` as {id:string}[];
   if(rows.length!==1||rows[0]?.id!==row.id)throw new Error('Default account update was not retained');
  }
  if(settingsChanged){
   const rows=await ctx.sql`INSERT INTO app_settings(key,value,company_id,updated_at)
    VALUES(${DEFAULT_SETTINGS_KEY},${JSON.stringify(mappings)}::jsonb,${c}::uuid,NOW())
    ON CONFLICT(key,company_id) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW() RETURNING key` as {key:string}[];
   if(rows.length!==1||rows[0]?.key!==DEFAULT_SETTINGS_KEY)throw new Error('Default settings update was not retained');
  }
  const after=await readGlChangeRows(ctx,{ids}),next=await readDefaultSettings(ctx);
  assertDefaultRows(expected,after);if(!next||!sameMappings(next,mappings))throw new Error('Default settings were not retained');
  const record=async(entityType:string,entityId:string,a:Record<string,unknown>|null,b:Record<string,unknown>)=>{
   const found=versions.find(row=>row.entity_type===entityType&&row.entity_id===entityId),v=found?Number(found.version):null;
   await recordCommittedChange(ctx,{entityType,entityId,previousVersion:v,newVersion:v===null?1:v+1,action:'default_accounts_changed',accountingDate:null,
    before:a,after:b,bindingHash:null,protectedEvidenceRef:null});
  };
  for(const row of changed)await record('gl_account',row.id,before.find(a=>a.id===row.id)!,after.find(a=>a.id===row.id)!);
  if(settingsChanged)await record('accounting_default_accounts',c,prior,next);
  cache.invalidatePrefix(`${c}:gl-accounts`);clearSystemAccountCache(c);return{saved:true};
 });
}
